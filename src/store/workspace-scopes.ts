import { create } from 'zustand';
import { createSaver } from '@/lib/persist';
import { useSettings } from '@/store/settings';
import { ALL_GROUPS, type KindGroup } from '@/lib/annotations';
import { isTauri, loadWorkspaceScopes, saveWorkspaceScopes } from '@/lib/tauri-commands';
import type { FileMeta, SavedCollection } from '@/lib/library-metadata';
import type { BookState } from '@/store/annotations';

export interface LibraryScope {
  folders: string[];
  tags: string[];
  enabled: boolean;
}

export interface LibraryView {
  query: string;
  filter: string;
  sort: string;
  tagFilter: string[];
  starredOnly: boolean;
  activeCollectionId: string | null;
}

export interface AnnotationView {
  selected: string;
  groups: Record<KindGroup, boolean>;
  query: string;
  hideEmpty: boolean;
}

/** Everything a workspace owns. Physical files stay where the user keeps them. */
export interface WorkspaceScope {
  library: LibraryScope;
  libraryView: LibraryView;
  annotations: AnnotationView;
  /** Absolute paths registered in this workspace's library. */
  externalFiles: string[];
  /** Tags, stars and private notes for this workspace's files. */
  fileMeta: Record<string, FileMeta>;
  /** Saved library searches for this workspace. */
  collections: SavedCollection[];
  /** Recently opened times for this workspace. */
  recentFiles: Record<string, number>;
  /** Annotation scan results for this workspace's books. */
  books: Record<string, BookState>;
  /** Paths of files owned by this workspace (relative or absolute). */
  files: string[];
  /** Whether the legacy library has been seeded into this workspace. */
  seeded: boolean;
}

function blank(): WorkspaceScope {
  return {
    library: { folders: [], tags: [], enabled: false },
    libraryView: {
      query: '',
      filter: 'all',
      sort: 'recent',
      tagFilter: [],
      starredOnly: false,
      activeCollectionId: null,
    },
    annotations: { selected: 'all', groups: { ...ALL_GROUPS }, query: '', hideEmpty: true },
    externalFiles: [],
    fileMeta: {},
    collections: [],
    recentFiles: {},
    books: {},
    files: [],
    seeded: false,
  };
}

interface ScopeStore {
  hydrated: boolean;
  allWorkspaces: boolean;
  setAllWorkspaces: (value: boolean) => void;
  scopes: Record<string, WorkspaceScope>;
  hydrate: () => Promise<void>;
  get: (workspaceId: string) => WorkspaceScope;
  set: (workspaceId: string, patch: Partial<WorkspaceScope>) => void;
  setLibrary: (workspaceId: string, patch: Partial<LibraryScope>) => void;
  setLibraryView: (workspaceId: string, patch: Partial<LibraryView>) => void;
  setAnnotations: (workspaceId: string, patch: Partial<AnnotationView>) => void;
  forget: (workspaceId: string) => void;
  /** Move a file's ownership and its metadata/annotations to another workspace. */
  moveFile: (path: string, fromId: string, toId: string) => void;
}

const load = async (): Promise<Record<string, WorkspaceScope>> => {
  if (!isTauri()) return {};
  try {
    const raw = await loadWorkspaceScopes();
    if (!raw || typeof raw !== 'object') return {};
    const result: Record<string, WorkspaceScope> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const data = value as Partial<WorkspaceScope>;
      const base = blank();
      result[id] = {
        library: { ...base.library, ...(data.library ?? {}) },
        libraryView: { ...base.libraryView, ...(data.libraryView ?? {}) },
        annotations: { ...base.annotations, ...(data.annotations ?? {}) },
        externalFiles: Array.isArray(data.externalFiles) ? data.externalFiles : [],
        fileMeta: data.fileMeta && typeof data.fileMeta === 'object' ? data.fileMeta : {},
        collections: Array.isArray(data.collections) ? data.collections : [],
        recentFiles: data.recentFiles && typeof data.recentFiles === 'object' ? data.recentFiles : {},
        books: data.books && typeof data.books === 'object' ? data.books : {},
        files: Array.isArray(data.files) ? data.files : [],
        seeded: data.seeded === true,
      };
    }
    return result;
  } catch {
    return {};
  }
};

const saver = createSaver<Record<string, WorkspaceScope>>(
  (value) => saveWorkspaceScopes(value),
  400,
);

export const useWorkspaceScopes = create<ScopeStore>((set, getState) => ({
  hydrated: false,
  allWorkspaces: false,
  setAllWorkspaces: (allWorkspaces) => set({ allWorkspaces }),
  scopes: {},
  hydrate: async () => {
    if (getState().hydrated) return;
    const loaded = await load();
    // Migrate the legacy global library data into the default workspace once.
    if (Object.keys(loaded).length === 0) {
      const settings = useSettings.getState();
      loaded['default'] = {
        ...blank(),
        externalFiles: [...settings.externalFiles],
        fileMeta: { ...settings.fileMeta },
        collections: [...settings.collections],
        recentFiles: { ...settings.recentFiles },
      };
    }
    set({ scopes: loaded, hydrated: true });
  },
  get: (workspaceId) => getState().scopes[workspaceId] ?? blank(),
  set: (workspaceId, patch) =>
    set((state) => {
      const current = state.scopes[workspaceId] ?? blank();
      const scopes = { ...state.scopes, [workspaceId]: { ...current, ...patch } };
      saver.schedule(scopes);
      return { scopes };
    }),
  setLibrary: (workspaceId, patch) =>
    getState().set(workspaceId, { library: { ...getState().get(workspaceId).library, ...patch } }),
  setLibraryView: (workspaceId, patch) =>
    getState().set(workspaceId, { libraryView: { ...getState().get(workspaceId).libraryView, ...patch } }),
  setAnnotations: (workspaceId, patch) =>
    getState().set(workspaceId, { annotations: { ...getState().get(workspaceId).annotations, ...patch } }),
  moveFile: (path, fromId, toId) =>
    set((state) => {
      if (fromId === toId || !state.scopes[fromId] || !state.scopes[toId]) return state;
      const from = state.scopes[fromId];
      const to = state.scopes[toId];
      if (!from.files.includes(path) && !from.externalFiles.includes(path)) return state;
      const nextFrom = {
        ...from,
        files: from.files.filter((entry) => entry !== path),
        externalFiles: from.externalFiles.filter((entry) => entry !== path),
        fileMeta: Object.fromEntries(Object.entries(from.fileMeta).filter(([key]) => key !== path)),
        books: Object.fromEntries(Object.entries(from.books).filter(([key]) => key !== path)),
        recentFiles: Object.fromEntries(Object.entries(from.recentFiles).filter(([key]) => key !== path)),
      };
      const nextTo = {
        ...to,
        files: [...to.files.filter((entry) => entry !== path), path],
        externalFiles: [...to.externalFiles.filter((entry) => entry !== path), ...(from.externalFiles.includes(path) ? [path] : [])],
        fileMeta: { ...to.fileMeta, ...(from.fileMeta[path] ? { [path]: from.fileMeta[path] } : {}) },
        books: { ...to.books, ...(from.books[path] ? { [path]: from.books[path] } : {}) },
        recentFiles: { ...to.recentFiles, ...(from.recentFiles[path] !== undefined ? { [path]: from.recentFiles[path] } : {}) },
      };
      const scopes = { ...state.scopes, [fromId]: nextFrom, [toId]: nextTo };
      saver.schedule(scopes);
      return { scopes };
    }),
  forget: (workspaceId) =>
    set((state) => {
      if (!(workspaceId in state.scopes)) return state;
      const scopes = { ...state.scopes };
      delete scopes[workspaceId];
      saver.schedule(scopes);
      return { scopes };
    }),
}));
