import { create } from 'zustand';
import { isTauri, loadSettings, saveSettings } from '@/lib/tauri-commands';
import { createSaver } from '@/lib/persist';
import { clamp, uid } from '@/lib/utils';
import { normalizeTags, removeTagFromMetas, renameTagInMetas, type FileMeta, type SavedCollection } from '@/lib/library-metadata';

export const THEME_IDS = ['white', 'black', 'sepia', 'gray', 'forest', 'ocean', 'lavender', 'rose'] as const;
export type ThemeMode = (typeof THEME_IDS)[number];

export const POMODORO_SOUNDS = ['beep', 'bell', 'chime', 'digital', 'none'] as const;
export type PomodoroSound = (typeof POMODORO_SOUNDS)[number];

export interface PomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  sound: PomodoroSound;
}

export interface ChatLayout {
  dockedHeight: number;
  detached: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A named capture note created from the composer ("Reading log", "Ideas", …). */
export interface CaptureNoteRef {
  name: string;
  path: string;
}

export interface NoteClipSettings {
  /** Path of the note text was last copied to from a PDF (shown first in the picker). */
  lastNote: string;
  /** Also highlight the passage in the PDF when copying it to a note. */
  highlight: boolean;
}

export interface PersistedSettings {
  theme: ThemeMode;
  primaryColor: string;
  appScale: number;
  pomodoro: PomodoroSettings;
  selectedModel: string;
  sidebarExpanded: boolean;
  notificationsEnabled: boolean;
  chatLayout: ChatLayout;
  recentFiles: Record<string, number>;
  noteClip: NoteClipSettings;
  /** User-selected folder where microphone recordings are stored (defaults to the workspace documents folder when empty). */
  recordingFolder: string;
  /** Folder new notes are created in, picked by the user at creation time like recordings. */
  noteFolder: string;
  /** Inbox note captures go to; blank = Inbox.md in the notes folder. */
  inboxNotePath: string;
  /** Extra named capture notes offered next to the default Inbox. */
  captureNotes: CaptureNoteRef[];
  /** Absolute paths of files kept outside the workspace that the library references in place. */
  externalFiles: string[];
  /** Place new canvas items at the pointer's last canvas position instead of auto-placing them. */
  newItemAtPointer: boolean;
  /** Per-file app metadata (tags, star, private note) keyed by file path — never copied files. */
  fileMeta: Record<string, FileMeta>;
  /** Saved live filters (collections) evaluated against the current library. */
  collections: SavedCollection[];
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  theme: 'white',
  primaryColor: '#2563EB',
  appScale: 100,
  pomodoro: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakEvery: 4,
    autoStartBreaks: true,
    autoStartFocus: false,
    sound: 'beep',
  },
  selectedModel: '',
  sidebarExpanded: false,
  notificationsEnabled: true,
  chatLayout: { dockedHeight: 320, detached: false, x: 120, y: 90, width: 420, height: 560 },
  recentFiles: {},
  noteClip: { lastNote: '', highlight: true },
  recordingFolder: '',
  noteFolder: '',
  inboxNotePath: '',
  captureNotes: [],
  externalFiles: [],
  newItemAtPointer: false,
  fileMeta: {},
  collections: [],
};

interface SettingsStore extends PersistedSettings {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<PersistedSettings>) => void;
  updatePomodoro: (patch: Partial<PomodoroSettings>) => void;
  updateChatLayout: (patch: Partial<ChatLayout>) => void;
  updateNoteClip: (patch: Partial<NoteClipSettings>) => void;
  touchRecent: (path: string) => void;
  forgetRecent: (path: string) => void;
  setFileMeta: (path: string, patch: Partial<Omit<FileMeta, 'tags'>> & { tags?: string[] }) => void;
  toggleFileStar: (path: string) => void;
  setFileTags: (path: string, tags: string[]) => void;
  /** Rename a tag on every file that carries it. */
  renameTagEverywhere: (from: string, to: string) => void;
  /** Remove a tag from every file that carries it. */
  removeTagEverywhere: (tag: string) => void;
  /** Drop metadata for paths that no longer exist in the library. */
  pruneFileMeta: (existingPaths: string[]) => void;
  createCollection: (name: string, criteria: SavedCollection['criteria']) => string;
  updateCollection: (id: string, patch: Partial<Pick<SavedCollection, 'name' | 'criteria'>>) => void;
  deleteCollection: (id: string) => void;
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function readableTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.45 ? '#0F172A' : '#FFFFFF';
}

export function applyAppearance(settings: Pick<PersistedSettings, 'theme' | 'primaryColor'>) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.colorScheme = settings.theme === 'black' ? 'dark' : 'light';
  root.style.setProperty('--primary', settings.primaryColor);
  root.style.setProperty('--primary-text', readableTextColor(settings.primaryColor));
}

let appliedScale = 100;
let webviewScale = 1;

export function webviewZoomFactor(): number {
  return webviewScale;
}

export async function applyScale(scale: number) {
  if (typeof document === 'undefined' || scale === appliedScale) return;
  appliedScale = scale;
  const factor = scale / 100;
  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().setZoom(factor);
      webviewScale = factor;
      document.documentElement.style.removeProperty('zoom');
      return;
    } catch {
      webviewScale = 1;
    }
  }
  document.documentElement.style.setProperty('zoom', String(factor));
}

function sanitize(raw: unknown): PersistedSettings {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pomodoroRaw = (data.pomodoro && typeof data.pomodoro === 'object' ? data.pomodoro : {}) as Record<string, unknown>;
  const chatRaw = (data.chatLayout && typeof data.chatLayout === 'object' ? data.chatLayout : {}) as Record<string, unknown>;
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const defaults = DEFAULT_SETTINGS;
  const legacySound = typeof data.pomodoroSound === 'string' ? data.pomodoroSound : undefined;
  const soundCandidate = (pomodoroRaw.sound as string | undefined) ?? legacySound;
  const recentRaw = data.recentFiles && typeof data.recentFiles === 'object' ? (data.recentFiles as Record<string, unknown>) : {};
  const clipRaw = (data.noteClip && typeof data.noteClip === 'object' ? data.noteClip : {}) as Record<string, unknown>;
  const recentFiles = Object.fromEntries(
    Object.entries(recentRaw)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200),
  );
  return {
    theme: THEME_IDS.includes(data.theme as ThemeMode) ? (data.theme as ThemeMode) : defaults.theme,
    primaryColor: isHexColor(data.primaryColor) ? data.primaryColor : defaults.primaryColor,
    appScale: number(data.appScale, defaults.appScale, 80, 200),
    pomodoro: {
      focusMinutes: number(pomodoroRaw.focusMinutes, defaults.pomodoro.focusMinutes, 1, 180),
      shortBreakMinutes: number(pomodoroRaw.shortBreakMinutes, defaults.pomodoro.shortBreakMinutes, 1, 60),
      longBreakMinutes: number(pomodoroRaw.longBreakMinutes, defaults.pomodoro.longBreakMinutes, 1, 120),
      longBreakEvery: number(pomodoroRaw.longBreakEvery, defaults.pomodoro.longBreakEvery, 2, 12),
      autoStartBreaks: bool(pomodoroRaw.autoStartBreaks, defaults.pomodoro.autoStartBreaks),
      autoStartFocus: bool(pomodoroRaw.autoStartFocus, defaults.pomodoro.autoStartFocus),
      sound: POMODORO_SOUNDS.includes(soundCandidate as PomodoroSound) ? (soundCandidate as PomodoroSound) : defaults.pomodoro.sound,
    },
    selectedModel: typeof data.selectedModel === 'string' ? data.selectedModel : defaults.selectedModel,
    sidebarExpanded: bool(data.sidebarExpanded, defaults.sidebarExpanded),
    notificationsEnabled: bool(data.notificationsEnabled, defaults.notificationsEnabled),
    chatLayout: {
      dockedHeight: number(chatRaw.dockedHeight, defaults.chatLayout.dockedHeight, 180, 2000),
      detached: bool(chatRaw.detached, defaults.chatLayout.detached),
      x: number(chatRaw.x, defaults.chatLayout.x, -2000, 10000),
      y: number(chatRaw.y, defaults.chatLayout.y, -2000, 10000),
      width: number(chatRaw.width, defaults.chatLayout.width, 320, 2000),
      height: number(chatRaw.height, defaults.chatLayout.height, 320, 2000),
    },
    recentFiles,
    noteClip: {
      lastNote: typeof clipRaw.lastNote === 'string' ? clipRaw.lastNote.slice(0, 1000) : defaults.noteClip.lastNote,
      highlight: bool(clipRaw.highlight, defaults.noteClip.highlight),
    },
    recordingFolder: typeof data.recordingFolder === 'string' ? data.recordingFolder.slice(0, 4000) : defaults.recordingFolder,
    noteFolder: typeof data.noteFolder === 'string' ? data.noteFolder.slice(0, 4000) : defaults.noteFolder,
    inboxNotePath: typeof data.inboxNotePath === 'string' ? data.inboxNotePath.slice(0, 4000) : defaults.inboxNotePath,
    captureNotes: sanitizeCaptureNotes(data.captureNotes),
    externalFiles: Array.isArray(data.externalFiles)
      ? [...new Set(data.externalFiles.filter((entry): entry is string => typeof entry === 'string' && /^([a-zA-Z]:[\\/]|[/\\])/.test(entry)))].slice(0, 400)
      : defaults.externalFiles,
    newItemAtPointer: bool(data.newItemAtPointer, defaults.newItemAtPointer),
    fileMeta: sanitizeFileMeta(data.fileMeta),
    collections: sanitizeCollections(data.collections),
  };
}

const MAX_FILE_META = 500;

function sanitizeFileMeta(raw: unknown): Record<string, FileMeta> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, FileMeta> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!path || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const tags = normalizeTags(Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === 'string') : []);
    const note = typeof entry.note === 'string' ? entry.note.slice(0, 2000) : undefined;
    const starred = entry.starred === true ? true : undefined;
    if (tags.length === 0 && !note && !starred) continue;
    out[path] = { tags, ...(note ? { note } : {}), ...(starred ? { starred } : {}) };
  }
  // Cap the registry so a very old, very large library cannot grow it forever.
  const entries = Object.entries(out);
  if (entries.length <= MAX_FILE_META) return out;
  return Object.fromEntries(entries.slice(0, MAX_FILE_META));
}

function sanitizeCaptureNotes(raw: unknown): CaptureNoteRef[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureNoteRef[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!path || !/^([a-zA-Z]:[\\/]|[/\\])/.test(path) || seen.has(path)) continue;
    seen.add(path);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 60) : 'Capture';
    out.push({ name, path });
  }
  return out;
}

function sanitizeCollections(raw: unknown): SavedCollection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 50)
    .map((item, index): SavedCollection | null => {
      if (!item || typeof item !== 'object') return null;
      const data = item as Record<string, unknown>;
      const criteriaRaw = (data.criteria && typeof data.criteria === 'object' ? data.criteria : {}) as Record<string, unknown>;
      return {
        id: typeof data.id === 'string' && data.id ? data.id : `collection-${index}`,
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 60) : `Collection ${index + 1}`,
        criteria: {
          ...(typeof criteriaRaw.query === 'string' && criteriaRaw.query.trim() ? { query: criteriaRaw.query.slice(0, 200) } : {}),
          ...(Array.isArray(criteriaRaw.fileTypes) ? { fileTypes: criteriaRaw.fileTypes.filter((t): t is string => typeof t === 'string').slice(0, 12) } : {}),
          ...(Array.isArray(criteriaRaw.tags) ? { tags: normalizeTags(criteriaRaw.tags.filter((t): t is string => typeof t === 'string')) } : {}),
          ...(criteriaRaw.starred === true ? { starred: true } : {}),
        },
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
      };
    })
    .filter((item): item is SavedCollection => !!item);
}

function snapshot(state: SettingsStore): PersistedSettings {
  return {
    theme: state.theme,
    primaryColor: state.primaryColor,
    appScale: state.appScale,
    pomodoro: state.pomodoro,
    selectedModel: state.selectedModel,
    sidebarExpanded: state.sidebarExpanded,
    notificationsEnabled: state.notificationsEnabled,
    chatLayout: state.chatLayout,
    recentFiles: state.recentFiles,
    noteClip: state.noteClip,
    recordingFolder: state.recordingFolder,
    noteFolder: state.noteFolder,
    inboxNotePath: state.inboxNotePath,
    captureNotes: state.captureNotes,
    externalFiles: state.externalFiles,
    newItemAtPointer: state.newItemAtPointer,
    fileMeta: state.fileMeta,
    collections: state.collections,
  };
}

const saver = createSaver<PersistedSettings>((value) => saveSettings(value), 300);

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    let loaded = DEFAULT_SETTINGS;
    let reachable = false;
    try {
      loaded = sanitize(await loadSettings());
      reachable = true;
    } catch {
      loaded = DEFAULT_SETTINGS;
    }
    set({ ...loaded, hydrated: true });
    applyAppearance(loaded);
    void applyScale(loaded.appScale);
    if (reachable) saver.schedule(loaded);
  },
  update: (patch) => {
    set(patch);
    if (patch.theme !== undefined || patch.primaryColor !== undefined) applyAppearance(get());
    if (patch.appScale !== undefined) void applyScale(get().appScale);
  },
  updatePomodoro: (patch) => set((state) => ({ pomodoro: { ...state.pomodoro, ...patch } })),
  updateChatLayout: (patch) => set((state) => ({ chatLayout: { ...state.chatLayout, ...patch } })),
  updateNoteClip: (patch) => set((state) => ({ noteClip: { ...state.noteClip, ...patch } })),
  touchRecent: (path) => set((state) => ({ recentFiles: { ...state.recentFiles, [path]: Date.now() } })),
  forgetRecent: (path) =>
    set((state) => {
      if (!(path in state.recentFiles)) return state;
      const next = { ...state.recentFiles };
      delete next[path];
      return { recentFiles: next };
    }),
  setFileMeta: (path, patch) =>
    set((state) => {
      const current = state.fileMeta[path] ?? { tags: [] };
      const next: FileMeta = {
        tags: patch.tags ? normalizeTags(patch.tags) : current.tags,
        ...(patch.starred !== undefined ? { starred: patch.starred || undefined } : { starred: current.starred }),
        ...(patch.note !== undefined ? { note: patch.note || undefined } : { note: current.note }),
      };
      const fileMeta = { ...state.fileMeta };
      // An empty record is not worth keeping.
      if (next.tags.length === 0 && !next.starred && !next.note) delete fileMeta[path];
      else fileMeta[path] = next;
      return { fileMeta };
    }),
  toggleFileStar: (path) =>
    set((state) => {
      const current = state.fileMeta[path] ?? { tags: [] };
      const starred = !current.starred;
      const next: FileMeta = { tags: current.tags, ...(starred ? { starred: true } : {}), ...(current.note ? { note: current.note } : {}) };
      const fileMeta = { ...state.fileMeta };
      if (next.tags.length === 0 && !starred && !next.note) delete fileMeta[path];
      else fileMeta[path] = next;
      return { fileMeta };
    }),
  setFileTags: (path, tags) => {
    get().setFileMeta(path, { tags });
  },
  renameTagEverywhere: (from, to) =>
    set((state) => {
      const next = renameTagInMetas(state.fileMeta, from, to);
      if (next === state.fileMeta) return state;
      return { fileMeta: next };
    }),
  removeTagEverywhere: (tag) =>
    set((state) => {
      const next = removeTagFromMetas(state.fileMeta, tag);
      if (next === state.fileMeta) return state;
      return { fileMeta: next };
    }),
  pruneFileMeta: (existingPaths) =>
    set((state) => {
      const alive = new Set(existingPaths);
      const fileMeta = Object.fromEntries(Object.entries(state.fileMeta).filter(([path]) => alive.has(path)));
      if (Object.keys(fileMeta).length === Object.keys(state.fileMeta).length) return state;
      return { fileMeta };
    }),
  createCollection: (name, criteria) => {
    const collection: SavedCollection = {
      id: uid(),
      name: name.trim().slice(0, 60) || 'Untitled collection',
      criteria,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ collections: [...state.collections, collection].slice(-50) }));
    return collection.id;
  },
  updateCollection: (id, patch) =>
    set((state) => ({
      collections: state.collections.map((collection) =>
        collection.id === id
          ? {
              ...collection,
              ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 60) || collection.name } : {}),
              ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
            }
          : collection,
      ),
    })),
  deleteCollection: (id) => set((state) => ({ collections: state.collections.filter((collection) => collection.id !== id) })),
}));

useSettings.subscribe((state, previous) => {
  if (!state.hydrated || !previous.hydrated) return;
  const current = snapshot(state);
  const before = snapshot(previous);
  const changed = (Object.keys(current) as Array<keyof PersistedSettings>).some((key) => current[key] !== before[key]);
  if (changed) saver.schedule(current);
});
