import { create } from 'zustand';
import {
  getDataDir,
  listWorkspaceFiles,
  statExternalFile,
  type StudyFile,
} from '@/lib/tauri-commands';
import { useSettings } from './settings';
import { useWorkspaceScopes } from './workspace-scopes';
import { currentWorkspace } from './workspace-context';

interface LibraryStore {
  files: StudyFile[];
  /** Every file known to any workspace, for the global view. */
  allFiles: StudyFile[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<StudyFile[]>;
  /** Reload the active workspace's files after switching workspaces. */
  reloadForWorkspace: () => Promise<void>;
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
let indexTimer: ReturnType<typeof setTimeout> | undefined;

/** Rebuild the graph/search indexes when the set of library files changes. */
function forgetPath(path: string): void {
  void Promise.all([
    import('./graph').then((module) => module.forgetPath(path)),
    import('./search').then((module) => module.forgetSearchPath(path)),
  ]).catch(() => undefined);
}

function invalidateIndexes(): void {
  if (indexTimer) clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    indexTimer = undefined;
    void Promise.all([
      import('./graph').then((module) => module.invalidateLibraryIndex()),
      import('./search').then((module) => module.invalidateSearchIndex()),
    ]).catch(() => undefined);
  }, 250);
}

function sortFiles(files: StudyFile[]): StudyFile[] {
  return [...files].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  files: [],
  allFiles: [],
  loading: false,
  loaded: false,
  error: null,
  refresh: () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = (async () => {
      try {
        const files = await listWorkspaceFiles();
        const scopes = useWorkspaceScopes.getState();
        const id = currentWorkspace();
        const scope = scopes.get(id);
        const allExternals = [...new Set(Object.values(scopes.scopes).flatMap((entry) => entry.externalFiles))];
        const stats = await Promise.all(
          allExternals.map(async (path) => {
            try {
              return { path, file: await statExternalFile(path) };
            } catch {
              return { path, file: null };
            }
          }),
        );
        const root = await getDataDir().catch(() => '');
        const listed = new Set(files.map((file) => file.path));
        const externalFiles: StudyFile[] = [];
        const unavailable: string[] = [];
        for (const { path, file } of stats) {
          // A failed stat (unplugged drive, transient lock) is not proof the
          // user removed the file. Keep both the registration and its metadata
          // so the file comes back on a later refresh.
          if (!file) {
            unavailable.push(path);
            continue;
          }
          // Files inside the workspace's top-level documents/notes folders are
          // already listed by the scan; only keep the workspace-relative entry.
          const relative = root && (file.path.startsWith(`${root}/`) || file.path.startsWith(`${root}\\`))
            ? file.path.slice(root.length).replace(/^[\\/]+/, '')
            : null;
          if (relative && listed.has(relative)) continue;
          if (/^(documents|notes)[\\/][^\\/]+$/.test(relative ?? '')) continue;
          externalFiles.push(file);
        }
        // Seed the default workspace with the legacy library on first use;
        // new workspaces start with an empty owned list.
        if (!scope.seeded) {
          scopes.set(id, {
            seeded: true,
            files: id === 'default' ? [...files.map((file) => file.path), ...scope.externalFiles] : [...scope.externalFiles],
          });
        }
        const owned = useWorkspaceScopes.getState().get(id);
        const ownedPaths = new Set(owned.files);
        const ownedExternal = new Set(owned.externalFiles);
        const visibleFiles = files.filter((file) => ownedPaths.has(file.path));
        const visibleExternal = externalFiles.filter((file) => ownedExternal.has(file.path));
        const allKnown = sortFiles([...files, ...externalFiles]);
        const merged = sortFiles([...visibleFiles, ...visibleExternal]);
        // Only files owned by the active workspace belong in its library.
        const finalFiles = merged;
        const previousPaths = new Set(useLibrary.getState().files.map((file) => file.path));
        // Prune the active workspace's metadata, not the legacy global copy.
        const activeId = currentWorkspace();
        const activeScope = scopes.get(activeId);
        const valid = new Set([...finalFiles.map((file) => file.path), ...unavailable]);
        const keptMeta = Object.fromEntries(Object.entries(activeScope.fileMeta).filter(([path]) => valid.has(path)));
        if (Object.keys(keptMeta).length !== Object.keys(activeScope.fileMeta).length) {
          scopes.set(activeId, { fileMeta: keptMeta });
        }
        set({ files: finalFiles, allFiles: allKnown, loading: false, loaded: true, error: null });
        // A workspace switch can swap every file while keeping the count same.
        void Promise.all([
          import('./graph').then((module) => module.invalidateLibraryIndex()),
          import('./search').then((module) => module.invalidateSearchIndex()),
        ]).catch(() => undefined);
        if (finalFiles.length !== previousPaths.size) invalidateIndexes();
        return finalFiles;
      } catch (error: unknown) {
        set({ loading: false, loaded: true, error: error instanceof Error ? error.message : String(error) });
        return [] as StudyFile[];
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  reloadForWorkspace: async () => {
    set({ files: [], loading: true, loaded: false });
    void Promise.all([
      import('./graph').then((module) => module.invalidateLibraryIndex()),
      import('./search').then((module) => module.invalidateSearchIndex()),
    ]).catch(() => undefined);
    await get().refresh();
  },
  upsert: (file) => {
    const id = currentWorkspace();
    const scopes = useWorkspaceScopes.getState();
    const owned = scopes.get(id);
    if (!scopes.allWorkspaces && !owned.files.includes(file.path)) {
      scopes.set(id, { files: [...owned.files, file.path] });
    }
    set((state) => ({ files: sortFiles([file, ...state.files.filter((existing) => existing.path !== file.path)]) }));
  },
  remove: (path) => {
    const id = currentWorkspace();
    const scopes = useWorkspaceScopes.getState();
    const owned = scopes.get(id);
    if (owned.files.includes(path)) {
      scopes.set(id, {
        files: owned.files.filter((entry) => entry !== path),
        externalFiles: owned.externalFiles.filter((entry) => entry !== path),
        fileMeta: Object.fromEntries(Object.entries(owned.fileMeta).filter(([key]) => key !== path)),
        books: Object.fromEntries(Object.entries(owned.books).filter(([key]) => key !== path)),
      });
    }
    set((state) => ({ files: state.files.filter((file) => file.path !== path) }));
    forgetPath(path);
    invalidateIndexes();
  },
  replace: (oldPath, file) => {
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== oldPath && existing.path !== file.path)]),
    }));
    forgetPath(oldPath);
    invalidateIndexes();
  },
  registerExternal: async (path) => {
    const file = await statExternalFile(path);
    if (!file) return null;
    const root = await getDataDir().catch(() => '');
    const relative = root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
      ? path.slice(root.length).replace(/^[\\/]+/, '')
      : null;
    // Files in the workspace's top-level documents/notes folders are listed by
    // the scan already; deeper workspace folders and truly external paths are
    // referenced through the registry so they survive a refresh.
    const scanListed = relative !== null && /^(documents|notes)[\\/][^\\/]+$/.test(relative);
    if (!scanListed) useSettings.getState().addExternalFile(path);
    const scopes = useWorkspaceScopes.getState();
    const owned = scopes.get(currentWorkspace());
    if (!scopes.allWorkspaces && !owned.files.includes(file.path)) {
      scopes.set(currentWorkspace(), { files: [...owned.files, file.path] });
    }
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== file.path && existing.path !== relative)]),
    }));
    invalidateIndexes();
    return file;
  },
  removeExternal: (path) => {
    useSettings.getState().removeExternalFile(path);
    set((state) => ({ files: state.files.filter((file) => file.path !== path) }));
    forgetPath(path);
    invalidateIndexes();
  },
  replaceExternal: (oldPath, file) => {
    useSettings.getState().replaceExternalFile(oldPath, file.path);
    set((state) => ({
      files: sortFiles([file, ...state.files.filter((existing) => existing.path !== oldPath && existing.path !== file.path)]),
    }));
    forgetPath(oldPath);
    invalidateIndexes();
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
