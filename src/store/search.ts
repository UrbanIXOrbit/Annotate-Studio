import { create } from 'zustand';
import { searchDocs, type SearchDoc, type SearchHit, type SearchKind } from '@/lib/global-search';
import { openBookAtCfi, openPdfAtPage } from '@/lib/card-actions';
import { isTauri, type StudyFile } from '@/lib/tauri-commands';
import { isExternalPath, stripExtension } from '@/lib/utils';
import { fileKey, useAnnotations, type AnnotationFile } from '@/store/annotations';
import { useApp } from '@/store/app';
import { useCanvas, type ResourceType } from '@/store/canvas';
import { useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { useSettings } from '@/store/settings';
import { openFileOnCanvas, readDocumentText } from '@/lib/workspace-actions';

export type SearchScope = 'all' | SearchKind;

interface SearchState {
  open: boolean;
  query: string;
  scope: SearchScope;
  hits: SearchHit[];
  /** Progress of the background text index, like the Annotations tab shows. */
  indexing: { done: number; total: number };
  show: () => void;
  hide: () => void;
  setQuery: (query: string) => void;
  setScope: (scope: SearchScope) => void;
}

/** Extracted document text, kept in memory only and keyed like the Annotations
 * store so a changed file is re-read and a deleted one is dropped. */
const cache = new Map<string, { key: string; doc: SearchDoc }>();
const MAX_CACHED = 500;
let chain: Promise<void> = Promise.resolve();
let indexed = false;

function pruneCache() {
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function setCache(path: string, key: string, doc: SearchDoc) {
  cache.delete(path);
  cache.set(path, { key, doc });
  pruneCache();
}

/** Canvas windows that carry their own text (cards, web articles). */
function resourceDocs(): SearchDoc[] {
  const { workspaces } = useCanvas.getState();
  return workspaces.flatMap((workspace) =>
    workspace.resources.flatMap((resource): SearchDoc[] => {
      if (resource.type === 'card') {
        const source = resource.source;
        return [{
          path: `resource:${resource.id}`,
          kind: 'card',
          title: resource.title,
          text: resource.content ?? '',
          meta: source ? `${source.title}${source.page ? ` · page ${source.page}` : ''}` : undefined,
          locator: source ? { page: source.page, cfi: source.cfi } : undefined,
          resourceId: resource.id,
        }];
      }
      if (resource.type === 'article') {
        const highlights = (resource.articleHighlights ?? []).map((highlight) => highlight.text).join(' ');
        return [{
          path: `resource:${resource.id}`,
          kind: 'article',
          title: resource.title,
          text: [resource.content ?? '', highlights].filter(Boolean).join('\n'),
          resourceId: resource.id,
        }];
      }
      // Notes kept inline (pre-migration) are searchable through their content.
      if (resource.type === 'note' && resource.content) {
        return [{ path: `resource:${resource.id}`, kind: 'note', title: resource.title, text: resource.content, resourceId: resource.id }];
      }
      return [];
    }),
  );
}

/** Annotation quotes with page/CFI locations, from the Annotations store's scans. */
function quoteDocs(): SearchDoc[] {
  const { books } = useAnnotations.getState();
  return Object.entries(books).flatMap(([path, state]) => {
    if (state.status !== 'done' || !state.data) return [];
    return state.data.entries.map((entry) => ({
      // Keep the real file path: the synthetic `#quote-…` suffix made every
      // jump fail the library lookup. The locator already carries the spot.
      path,
      kind: 'quote' as const,
      title: state.data!.title,
      text: entry.text,
      meta: entry.comment,
      locator: { page: entry.page, cfi: entry.cfi },
    }));
  });
}

/** Cached file documents, with live note buffers taking precedence. */
function fileDocs(): SearchDoc[] {
  const buffers = useNotes.getState().buffers;
  const docs: SearchDoc[] = [];
  for (const [path, entry] of cache) {
    const buffer = buffers[path];
    const text = buffer && buffer.status === 'ready' ? buffer.content : entry.doc.text;
    docs.push(text === entry.doc.text ? entry.doc : { ...entry.doc, text });
  }
  return docs;
}

function computeHits() {
  const { query, scope } = useSearch.getState();
  const docs = [...resourceDocs(), ...fileDocs(), ...quoteDocs()];
  const filtered = scope === 'all' ? docs : docs.filter((doc) => doc.kind === scope);
  useSearch.setState({ hits: searchDocs(filtered, query) });
}

/** Kick off the annotations scan so quote hits carry page/CFI locations. */
function scanAnnotations() {
  const library = useLibrary.getState();
  const files = library.loaded ? library.files : [];
  const { workspaces } = useCanvas.getState();
  const external: AnnotationFile[] = workspaces.flatMap((workspace) =>
    workspace.resources
      .filter((resource) => (resource.type === 'pdf' || resource.type === 'book') && resource.isExternal && !!resource.filePath)
      .map((resource) => ({
        id: `external:${resource.filePath}`,
        name: resource.filePath!.split(/[\\/]/).pop() ?? '',
        path: resource.filePath!,
        file_type: resource.type === 'book' ? ('Book' as const) : ('Pdf' as const),
        size: 0,
        created_at: '',
        modified_at: '',
        isExternal: true,
      })),
  );
  const scannable = [
    ...files.filter((file) => file.file_type === 'Pdf' || file.file_type === 'Book'),
    ...external,
  ];
  if (scannable.length === 0) return;
  void useAnnotations.getState().scan(scannable).then(() => computeHits());
}

function buildDoc(file: StudyFile, text: string): SearchDoc {
  const kind: SearchKind = file.file_type === 'Pdf' ? 'pdf' : file.file_type === 'Book' ? 'book' : 'note';
  const meta = useSettings.getState().fileMeta[file.path];
  return {
    path: file.path,
    kind,
    title: stripExtension(file.name),
    text,
    // Tags and the private file note are searchable alongside the content.
    ...(meta && (meta.tags.length > 0 || meta.note) ? { meta: [...meta.tags, meta.note ?? ''].filter(Boolean).join(' ') } : {}),
  };
}

/** Read one file's text and cache it. Skips files whose text is already current. */
async function indexFile(file: StudyFile, done: number, total: number): Promise<boolean> {
  const searchable = file.file_type === 'Pdf' || file.file_type === 'Book' || file.file_type === 'Markdown' || file.file_type === 'Text';
  const key = fileKey({ ...file, isExternal: isExternalPath(file.path) });
  const existing = cache.get(file.path);
  if (!searchable || (existing && existing.key === key)) return false;
  try {
    // Notes that are open are already in memory; readDocumentText would read
    // the file again, so take the buffer and let it fall back to the file.
    const buffer = useNotes.getState().buffers[file.path];
    const text = buffer && buffer.status === 'ready' ? buffer.content : (await readDocumentText(file.path, 120_000)).text;
    setCache(file.path, key, buildDoc(file, text));
  } catch {
    // Unreadable files (gone, unsupported) are simply left out of the index.
  }
  useSearch.setState({ indexing: { done: done + 1, total } });
  if (useSearch.getState().query.trim()) computeHits();
  return true;
}

async function runIndex() {
  if (!isTauri()) {
    indexed = true;
    return;
  }
  const library = useLibrary.getState();
  const files = library.loaded ? library.files : await library.refresh();

  // Priority: what is on the canvas now, then recent files, then the rest.
  const { workspaces } = useCanvas.getState();
  const opened = new Set(
    workspaces.flatMap((workspace) => workspace.resources.map((resource) => resource.filePath).filter((path): path is string => !!path)),
  );
  const recent = Object.keys(useSettings.getState().recentFiles);
  const rank = (path: string) => (opened.has(path) ? 0 : recent.includes(path) ? 1 : 2);
  const ordered = [...files].sort((a, b) => rank(a.path) - rank(b.path));

  const pending = ordered.filter((file) => {
    const existing = cache.get(file.path);
    return !existing || existing.key !== fileKey({ ...file, isExternal: isExternalPath(file.path) });
  }).length;
  useSearch.setState({ indexing: { done: 0, total: pending } });

  let done = 0;
  for (const file of ordered) {
    const added = await indexFile(file, done, pending);
    if (added) done += 1;
  }
  indexed = true;
  useSearch.setState({ indexing: { done: pending, total: pending } });
  computeHits();
}

function ensureIndex() {
  if (indexed) return;
  scanAnnotations();
  chain = chain.then(runIndex).catch(() => undefined);
}

/** Drop one path from the text index (file deleted or renamed away). */
export function forgetSearchPath(path: string): void {
  if (!cache.delete(path)) return;
  computeHits();
}

/** Rebuild the text index when the library's set of files changes. */
export function invalidateSearchIndex(): void {
  indexed = false;
  // Prune first so a deleted file cannot keep showing up as a live hit.
  const valid = new Set(useLibrary.getState().files.map((file) => file.path));
  for (const path of [...cache.keys()]) {
    if (!path.startsWith('resource:') && !valid.has(path)) cache.delete(path);
  }
  chain = chain.then(runIndex).catch(() => undefined);
  computeHits();
}

let debounce: ReturnType<typeof setTimeout> | undefined;

export const useSearch = create<SearchState>((set) => ({
  open: false,
  query: '',
  scope: 'all',
  hits: [],
  indexing: { done: 0, total: 0 },
  show: () => {
    set({ open: true });
    ensureIndex();
    computeHits();
  },
  hide: () => set({ open: false }),
  setQuery: (query) => {
    set({ query });
    ensureIndex();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(computeHits, 120);
  },
  setScope: (scope) => {
    set({ scope });
    computeHits();
  },
}));

/** Jump from a hit to its source on the canvas; shared by the search dialog. */
export function openSearchHit(hit: SearchHit): boolean {
  const setView = useApp.getState().setView;
  const canvas = useCanvas.getState();

  if (hit.resourceId) {
    const exists = canvas.workspaces.some((workspace) => workspace.resources.some((resource) => resource.id === hit.resourceId));
    if (exists) {
      canvas.focusResource(hit.resourceId);
      setView('canvas');
      return true;
    }
  }
  if (hit.locator?.cfi && (hit.kind === 'book' || hit.kind === 'quote')) {
    if (openBookAtCfi(hit.path, hit.locator.cfi, hit.title, isExternalPath(hit.path))) {
      setView('canvas');
      return true;
    }
  }
  if (hit.locator?.page && (hit.kind === 'pdf' || hit.kind === 'quote')) {
    if (openPdfAtPage(hit.path, hit.locator.page, hit.title, isExternalPath(hit.path))) {
      setView('canvas');
      return true;
    }
  }
  const file = useLibrary.getState().files.find((candidate) => candidate.path === hit.path);
  if (file) {
    openFileOnCanvas(file);
    setView('canvas');
    return true;
  }
  // External files are usually registered in the library already; fall back to
  // opening them straight from their path when they are not listed yet.
  if ((hit.kind === 'pdf' || hit.kind === 'book' || hit.kind === 'note' || hit.kind === 'quote') && !hit.path.startsWith('resource:')) {
    const type: ResourceType = hit.kind === 'quote' ? (hit.locator?.cfi ? 'book' : 'pdf') : hit.kind;
    canvas.openResource({ type, title: hit.title, filePath: hit.path }, { isExternal: isExternalPath(hit.path) });
    setView('canvas');
    return true;
  }
  return false;
}
