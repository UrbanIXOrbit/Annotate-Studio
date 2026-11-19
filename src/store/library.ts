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
        // registered path, list the ones still on disk, and keep the rest.
        const externals = useSettings.getState().externalFiles;
        const stats = await Promise.all(
          externals.map(async (path) => {
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
        const merged = sortFiles([...files, ...externalFiles]);
        // Anything added while the scan was in flight still belongs in the
        // library; committing the scan result alone would drop it.
        const concurrent = useLibrary.getState().files.filter(
          (file) => !merged.some((entry) => entry.path === file.path),
        );
        const finalFiles = sortFiles([...merged, ...concurrent]);
        const previousPaths = new Set(useLibrary.getState().files.map((file) => file.path));
        // Keep metadata for temporarily unavailable external files.
        useSettings.getState().pruneFileMeta([...finalFiles.map((file) => file.path), ...unavailable]);
        set({ files: finalFiles, loading: false, loaded: true, error: null });
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
  upsert: (file) =>
    set((state) => ({ files: sortFiles([file, ...state.files.filter((existing) => existing.path !== file.path)]) })),
  remove: (path) => {
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
