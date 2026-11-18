import { create } from 'zustand';
import { scanBookFile, scanPdfFile } from '@/lib/annotation-scan';
import { ALL_GROUPS, type BookAnnotations, type KindGroup } from '@/lib/annotations';
import type { StudyFile } from '@/lib/tauri-commands';

export type AnnotationFile = StudyFile & { isExternal?: boolean };

export interface BookState {
  /** Identity of the file version this result belongs to. A changed key means "scan again". */
  key: string;
  status: 'scanning' | 'done' | 'error';
  data?: BookAnnotations;
  error?: string;
}

interface AnnotationsStore {
  books: Record<string, BookState>;
  /** 'all' or the path of one PDF. */
  selected: string;
  groups: Record<KindGroup, boolean>;
  query: string;
  hideEmpty: boolean;
  scanning: boolean;
  progress: { done: number; total: number };
  revision: number;
  select: (selected: string) => void;
  setQuery: (query: string) => void;
  toggleGroup: (group: KindGroup) => void;
  setHideEmpty: (hide: boolean) => void;
  scan: (files: AnnotationFile[], options?: { force?: boolean }) => Promise<void>;
  /** Mark a saved PDF stale; AnnotationsTab will pick it up on its next render. */
  invalidate: (path: string) => void;
}

export function fileKey(file: Pick<AnnotationFile, 'path' | 'modified_at' | 'size' | 'isExternal'>): string {
  return `${file.path}|${file.modified_at}|${file.size}|${file.isExternal ? 'external' : 'workspace'}`;
}

let chain: Promise<void> = Promise.resolve();
/** Bumped when a path is invalidated, so a scan that started before the save
 * cannot commit its stale result afterwards. */
const generations = new Map<string, number>();

export const useAnnotations = create<AnnotationsStore>((set, get) => {
  async function run(files: AnnotationFile[], force: boolean) {
    const scanned = files.filter((file) => file.file_type === 'Pdf' || file.file_type === 'Book');
    const stale = scanned.filter((file) => force || get().books[file.path]?.key !== fileKey(file));
    if (stale.length === 0) return;

    // The book you are looking at is scanned first so it fills in immediately.
    const selected = get().selected;
    stale.sort((a, b) => Number(b.path === selected) - Number(a.path === selected));

    set({ scanning: true, progress: { done: 0, total: stale.length } });
    let done = 0;
    for (const file of stale) {
      const key = fileKey(file);
      const generation = generations.get(file.path) ?? 0;
      set((state) => ({
        books: { ...state.books, [file.path]: { key, status: 'scanning', data: state.books[file.path]?.data } },
      }));
      try {
        const data = file.file_type === 'Book' ? await scanBookFile(file) : await scanPdfFile(file);
        // A save landed while the scan was running: leave the key cleared so
        // the revision-triggered re-scan picks up the saved content.
        if ((generations.get(file.path) ?? 0) === generation) {
          set((state) => ({ books: { ...state.books, [file.path]: { key, status: 'done', data } } }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          books: {
            ...state.books,
            [file.path]: {
              key,
              status: 'error',
              error: message,
              // A transient read error must not wipe annotations already shown.
              data: state.books[file.path]?.data,
            },
          },
        }));
      }
      done += 1;
      set({ progress: { done, total: stale.length } });
    }
    set({ scanning: false });
  }

  return {
    books: {},
    selected: 'all',
    groups: { ...ALL_GROUPS },
    query: '',
    hideEmpty: true,
    scanning: false,
    progress: { done: 0, total: 0 },
    revision: 0,
    select: (selected) => set({ selected }),
    setQuery: (query) => set({ query }),
    toggleGroup: (group) => set((state) => ({ groups: { ...state.groups, [group]: !state.groups[group] } })),
    setHideEmpty: (hideEmpty) => set({ hideEmpty }),
    scan: (files, options) => {
      // Scans run one at a time; each pass re-checks what is stale, so queued duplicates are cheap.
      chain = chain.then(() => run(files, options?.force ?? false)).catch(() => set({ scanning: false }));
      return chain;
    },
    invalidate: (path) => set((state) => {
      generations.set(path, (generations.get(path) ?? 0) + 1);
      const existing = state.books[path];
      return {
        revision: state.revision + 1,
        ...(existing ? { books: { ...state.books, [path]: { ...existing, key: '' } } } : {}),
      };
    }),
  };
});
