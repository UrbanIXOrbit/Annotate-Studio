import { create } from 'zustand';
import { scanPdfFile } from '@/lib/annotation-scan';
import { ALL_GROUPS, type BookAnnotations, type KindGroup } from '@/lib/annotations';
import type { StudyFile } from '@/lib/tauri-commands';

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
  select: (selected: string) => void;
  setQuery: (query: string) => void;
  toggleGroup: (group: KindGroup) => void;
  setHideEmpty: (hide: boolean) => void;
  scan: (files: StudyFile[], options?: { force?: boolean }) => Promise<void>;
}

export function fileKey(file: Pick<StudyFile, 'path' | 'modified_at' | 'size'>): string {
  return `${file.path}|${file.modified_at}|${file.size}`;
}

let chain: Promise<void> = Promise.resolve();

export const useAnnotations = create<AnnotationsStore>((set, get) => {
  async function run(files: StudyFile[], force: boolean) {
    const pdfs = files.filter((file) => file.file_type === 'Pdf');
    const stale = pdfs.filter((file) => force || get().books[file.path]?.key !== fileKey(file));
    if (stale.length === 0) return;

    // The book you are looking at is scanned first so it fills in immediately.
    const selected = get().selected;
    stale.sort((a, b) => Number(b.path === selected) - Number(a.path === selected));

    set({ scanning: true, progress: { done: 0, total: stale.length } });
    let done = 0;
    for (const file of stale) {
      const key = fileKey(file);
      set((state) => ({
        books: { ...state.books, [file.path]: { key, status: 'scanning', data: state.books[file.path]?.data } },
      }));
      try {
        const data = await scanPdfFile(file);
        set((state) => ({ books: { ...state.books, [file.path]: { key, status: 'done', data } } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({ books: { ...state.books, [file.path]: { key, status: 'error', error: message } } }));
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
    select: (selected) => set({ selected }),
    setQuery: (query) => set({ query }),
    toggleGroup: (group) => set((state) => ({ groups: { ...state.groups, [group]: !state.groups[group] } })),
    setHideEmpty: (hideEmpty) => set({ hideEmpty }),
    scan: (files, options) => {
      // Scans run one at a time; each pass re-checks what is stale, so queued duplicates are cheap.
      chain = chain.then(() => run(files, options?.force ?? false)).catch(() => set({ scanning: false }));
      return chain;
    },
  };
});
