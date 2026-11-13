import { create } from 'zustand';
import {
  getDataDir,
  listWorkspaceFiles,
  statExternalFile,
  type StudyFile,
} from '@/lib/tauri-commands';
import { useSettings } from './settings';

interface LibraryStore {
  files: StudyFile[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<StudyFile[]>;
  upsert: (file: StudyFile) => void;
  remove: (path: string) => void;
  replace: (oldPath: string, file: StudyFile) => void;
  /** Reference a file at an absolute path outside the workspace in the library, in place. */
  registerExternal: (path: string) => Promise<StudyFile | null>;
  /** Drop an external reference; the file itself stays on the user's device. */
  removeExternal: (path: string) => void;
  /** Re-point an external reference at a new absolute path (after an in-place rename). */
  replaceExternal: (oldPath: string, file: StudyFile) => void;
}

let inflight: Promise<StudyFile[]> | null = null;

function sortFiles(files: StudyFile[]): StudyFile[] {
  return [...files].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export const useLibrary = create<LibraryStore>((set) => ({
  files: [],
  loading: false,
  loaded: false,
  error: null,
  refresh: () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = (async () => {
      try {
        const files = await listWorkspaceFiles();
        // Files kept outside the workspace are referenced in place: stat each
        // registered path, list the ones still on disk, and prune the rest.
        const externals = useSettings.getState().externalFiles;
        const stats = await Promise.all(externals.map((path) => statExternalFile(path).catch(() => null)));
        const root = await getDataDir().catch(() => '');
        const listed = new Set(files.map((file) => file.path));
        const kept: string[] = [];
        const externalFiles: StudyFile[] = [];
        stats.forEach((file, index) => {
          const requested = externals[index];
          if (!file) return;
          kept.push(requested);
          // Files inside the workspace's top-level documents/notes folders are
          // already listed by the scan; only keep the workspace-relative entry.
          const relative = root && (file.path.startsWith(`${root}/`) || file.path.startsWith(`${root}\\`))
            ? file.path.slice(root.length).replace(/^[\\/]+/, '')
            : null;
          if (relative && listed.has(relative)) return;
          if (/^(documents|notes)[\\/][^\\/]+$/.test(relative ?? '')) return;
          externalFiles.push(file);
        });
        if (kept.length !== externals.length) {
          useSettings.getState().update({ externalFiles: kept });
        }
        const merged = sortFiles([...files, ...externalFiles]);
        // Metadata is keyed by path; drop entries whose file left the library.
        useSettings.getState().pruneFileMeta(merged.map((file) => file.path));
        set({ files: merged, loading: false, loaded: true, error: null });
        return merged;
      } catch (error: unknown) {
        set({ loading: false, loaded: true, error: error instanceof Error ? error.message : String(error) });
        return [] as StudyFile[];
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  upsert: (file) =>
    set((state) => ({ files: sortFiles([file, ...state.files.filter((existing) => existing.path !== file.path)]) })),
  remove: (path) => set((state) => ({ files: state.files.filter((file) => file.path !== path) })),
  replace: (oldPath, file) =>
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== oldPath && existing.path !== file.path)]),
    })),
  registerExternal: async (path) => {
    const file = await statExternalFile(path);
    if (!file) return null;
    const settings = useSettings.getState();
    const root = await getDataDir().catch(() => '');
    const relative = root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
      ? path.slice(root.length).replace(/^[\\/]+/, '')
      : null;
    // Files in the workspace's top-level documents/notes folders are listed by
    // the scan already; deeper workspace folders and truly external paths are
    // referenced through the registry so they survive a refresh.
    const scanListed = relative !== null && /^(documents|notes)[\\/][^\\/]+$/.test(relative);
    if (!scanListed && !settings.externalFiles.includes(path)) {
      settings.update({ externalFiles: [...settings.externalFiles, path] });
    }
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== file.path && existing.path !== relative)]),
    }));
    return file;
  },
  removeExternal: (path) => {
    const settings = useSettings.getState();
    if (settings.externalFiles.includes(path)) {
      settings.update({ externalFiles: settings.externalFiles.filter((entry) => entry !== path) });
    }
    set((state) => ({ files: state.files.filter((file) => file.path !== path) }));
  },
  replaceExternal: (oldPath, file) => {
    const settings = useSettings.getState();
    if (settings.externalFiles.includes(oldPath)) {
      settings.update({ externalFiles: settings.externalFiles.map((entry) => (entry === oldPath ? file.path : entry)) });
    }
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== oldPath && existing.path !== file.path)]),
    }));
  },
}));

const LINK_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'docx', 'odt']);

function stripKnownExtension(value: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(value);
  return match && LINK_EXTENSIONS.has(match[1].toLowerCase()) ? value.slice(0, -match[0].length) : value;
}

function sanitizeLinkName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

export function normalizeLinkTarget(value: string): string {
  return stripKnownExtension(value.trim().split('|')[0].split('#')[0].trim()).toLowerCase();
}

export function resolveWikiLink(files: StudyFile[], target: string): StudyFile | undefined {
  const wanted = normalizeLinkTarget(target);
  if (!wanted) return undefined;
  const exact = files.find((file) => file.name.toLowerCase() === target.trim().toLowerCase());
  if (exact) return exact;
  const names = new Set([wanted, sanitizeLinkName(wanted)]);
  const byStem = files.filter((file) => names.has(stripKnownExtension(file.name).toLowerCase()));
  return byStem.find((file) => file.file_type === 'Markdown') ?? byStem[0];
}
