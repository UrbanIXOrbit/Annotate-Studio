import { create } from 'zustand';
import {
  buildLinkIndex,
  extractLinks,
  resolveLinks,
  type LinkDoc,
  type ResolvedLinks,
} from '@/lib/link-graph';
import { isTauri, type StudyFile } from '@/lib/tauri-commands';
import { isExternalPath } from '@/lib/utils';
import { fileKey } from '@/store/annotations';
import { useCanvas, type Resource } from '@/store/canvas';
import { resolveWikiLink, useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { openFileOnCanvas, readDocumentText } from '@/lib/workspace-actions';
import { useApp } from '@/store/app';

/* ---------- Node identity ---------- */

/** The stable node id for a canvas resource: its file when it has one, else a
 * workspace-scoped resource id (resource ids are workspace-local). */
export function resourceNodeId(workspaceId: string, resource: Resource): string {
  return resource.filePath ?? `res:${workspaceId}/${resource.id}`;
}

export type GraphKind = 'note' | 'pdf' | 'book' | 'card' | 'article' | 'other';

export interface GraphNode {
  id: string;
  title: string;
  kind: GraphKind;
  /** Wiki-link mentions (resolved endpoints) + connector endpoints. */
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'link' | 'connector';
  label?: string;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Phantom targets: link text that resolves to no file (dashed nodes). */
  unresolved: string[];
  backlinks: ResolvedLinks['backlinks'];
  outgoing: ResolvedLinks['outgoing'];
  /** The indexed documents (live note buffers included), by node id. */
  docs: Map<string, LinkDoc>;
}

interface GraphState {
  open: boolean;
  /** Bumped whenever the index changes so the view recomputes. */
  revision: number;
  indexing: { done: number; total: number };
  /** A path to spotlight in the graph (e.g. the note the panel opened from). */
  focus: string | null;
  show: (focus?: string | null) => void;
  hide: () => void;
  setFocus: (focus: string | null) => void;
}

/* ---------- Index machinery (same pattern as the search store) ---------- */

const cache = new Map<string, { key: string; doc: LinkDoc; links: string[] }>();
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

function setCache(path: string, key: string, doc: LinkDoc) {
  cache.delete(path);
  cache.set(path, { key, doc, links: extractLinks(doc.markdown) });
  pruneCache();
}

function linkable(file: StudyFile): boolean {
  return file.file_type === 'Markdown' || file.file_type === 'Text';
}

function docTitle(file: StudyFile): string {
  return file.name.replace(/\.(md|markdown|txt)$/i, '');
}

/** Read one note's text and cache its links. Skips files already current. */
async function indexFile(file: StudyFile, done: number, total: number): Promise<boolean> {
  if (!linkable(file)) return false;
  const key = fileKey({ ...file, isExternal: isExternalPath(file.path) });
  const existing = cache.get(file.path);
  if (existing && existing.key === key) return false;
  try {
    const buffer = useNotes.getState().buffers[file.path];
    const markdown = buffer && buffer.status === 'ready' ? buffer.content : (await readDocumentText(file.path, 120_000)).text;
    setCache(file.path, key, { path: file.path, title: docTitle(file), markdown });
  } catch {
    // Unreadable files are simply left out of the index.
  }
  useGraph.setState({ indexing: { done: done + 1, total } });
  return true;
}

async function runIndex() {
  if (!isTauri()) {
    indexed = true;
    return;
  }
  const library = useLibrary.getState();
  const files = library.loaded ? library.files : await library.refresh();
  const notes = files.filter(linkable);
  const pending = notes.filter((file) => {
    const existing = cache.get(file.path);
    return !existing || existing.key !== fileKey({ ...file, isExternal: isExternalPath(file.path) });
  }).length;
  useGraph.setState({ indexing: { done: 0, total: pending } });
  let done = 0;
  for (const file of notes) {
    const added = await indexFile(file, done, pending);
    if (added) done += 1;
  }
  indexed = true;
  useGraph.setState({ indexing: { done: pending, total: pending } });
  useGraph.setState((state) => ({ revision: state.revision + 1 }));
}

function ensureIndex() {
  if (indexed) return;
  chain = chain.then(runIndex).catch(() => undefined);
}

/** Current doc text for a cached path, with the live note buffer on top. */
function docFor(path: string, markdown: string): LinkDoc {
  const buffer = useNotes.getState().buffers[path];
  const text = buffer && buffer.status === 'ready' ? buffer.content : markdown;
  const entry = cache.get(path);
  const links = entry && entry.doc.markdown === text ? entry.links : undefined;
  return { path, title: entry?.doc.title ?? path, markdown: text, links };
}

/** Cards and articles across all workspaces, keyed as resource nodes. */
function resourceDocs(): Array<LinkDoc & { kind: GraphKind }> {
  const { workspaces } = useCanvas.getState();
  return workspaces.flatMap((workspace) =>
    workspace.resources.flatMap((resource): Array<LinkDoc & { kind: GraphKind }> => {
      if (resource.content) {
        const kind: GraphKind = resource.type === 'card' ? 'card' : resource.type === 'article' ? 'article' : 'other';
        return [{ path: resourceNodeId(workspace.id, resource), title: resource.title, markdown: resource.content, kind }];
      }
      return [];
    }),
  );
}

/** Connector edges from every workspace, mapped onto node ids. */
function connectorEdges(): GraphEdge[] {
  const { workspaces } = useCanvas.getState();
  return workspaces.flatMap((workspace) =>
    workspace.connectors.flatMap((connector): GraphEdge[] => {
      const from = workspace.resources.find((resource) => resource.id === connector.from);
      const to = workspace.resources.find((resource) => resource.id === connector.to);
      if (!from || !to) return [];
      return [{ from: resourceNodeId(workspace.id, from), to: resourceNodeId(workspace.id, to), kind: 'connector', label: connector.label }];
    }),
  );
}

function kindForFile(file: StudyFile): GraphKind {
  switch (file.file_type) {
    case 'Markdown':
    case 'Text':
      return 'note';
    case 'Pdf':
      return 'pdf';
    case 'Book':
      return 'book';
    default:
      return 'other';
  }
}

/**
 * Build the whole graph model from the current stores. Resolves links at
 * query time against the library, so renames stay correct without any
 * content rewrite. Pure computation over store state — safe inside useMemo.
 */
let modelCache: { key: string; model: GraphModel } | null = null;

/** One graph computation per revision/workspace, shared by all note windows. */
export function getGraphModel(): GraphModel {
  const state = useGraph.getState();
  const canvas = useCanvas.getState();
  const key = `${state.revision}|${canvas.activeWorkspaceId}|${canvas.workspaces}`;
  if (modelCache?.key === key) return modelCache.model;
  const model = computeGraph();
  modelCache = { key, model };
  return model;
}

export function invalidateGraphModel(): void {
  modelCache = null;
}

export function computeGraph(): GraphModel {
  ensureIndex();
  const files = useLibrary.getState().files;
  const loaded = useLibrary.getState().loaded;

  const docs: LinkDoc[] = [
    ...[...cache.keys()].map((path) => {
      const entry = cache.get(path)!;
      return docFor(path, entry.doc.markdown);
    }),
    ...resourceDocs(),
  ];

  const index = buildLinkIndex(docs);
  const resolve = (target: string): string | null => {
    if (!loaded) return null;
    const file = resolveWikiLink(files, target);
    return file ? file.path : null;
  };
  const resolved = resolveLinks(index, resolve);

  // Node metadata: kind + title for every node that ends up in the graph.
  const meta = new Map<string, { title: string; kind: GraphKind }>();
  for (const doc of docs) {
    const kind = (doc as { kind?: GraphKind }).kind;
    if (kind) {
      meta.set(doc.path, { title: doc.title, kind });
      continue;
    }
    const file = files.find((candidate) => candidate.path === doc.path);
    meta.set(doc.path, file ? { title: docTitle(file), kind: kindForFile(file) } : { title: doc.title, kind: 'other' });
  }
  // Connector endpoints that carry no text (PDFs, books, images…).
  for (const edge of connectorEdges()) {
    for (const id of [edge.from, edge.to]) {
      if (meta.has(id)) continue;
      const file = files.find((candidate) => candidate.path === id);
      if (file) {
        meta.set(id, { title: docTitle(file), kind: kindForFile(file) });
        continue;
      }
      if (id.startsWith('res:')) {
        const workspaceId = id.slice(4, id.indexOf('/', 4));
        const resourceId = id.slice(id.indexOf('/', 4) + 1);
        const workspace = useCanvas.getState().workspaces.find((candidate) => candidate.id === workspaceId);
        const resource = workspace?.resources.find((candidate) => candidate.id === resourceId);
        if (resource) {
          meta.set(id, { title: resource.title, kind: resource.type === 'card' ? 'card' : resource.type === 'article' ? 'article' : 'other' });
        }
      }
    }
  }

  const edges: GraphEdge[] = [
    ...[...resolved.outgoing.values()].flatMap((links) =>
      links
        .filter((link) => link.resolved && link.to !== link.from)
        .map((link) => ({ from: link.from, to: link.to, kind: 'link' as const })),
    ),
    ...connectorEdges(),
  ];

  const degrees = new Map<string, number>();
  const bump = (id: string) => degrees.set(id, (degrees.get(id) ?? 0) + 1);
  for (const edge of edges) {
    bump(edge.from);
    bump(edge.to);
  }

  const nodes: GraphNode[] = [...meta.entries()].map(([id, info]) => ({
    id,
    title: info.title,
    kind: info.kind,
    degree: degrees.get(id) ?? 0,
  }));

  return {
    nodes,
    edges,
    unresolved: resolved.unresolved,
    backlinks: resolved.backlinks,
    outgoing: resolved.outgoing,
    docs: new Map(docs.map((doc) => [doc.path, doc])),
  };
}

export const useGraph = create<GraphState>((set) => ({
  open: false,
  revision: 0,
  indexing: { done: 0, total: 0 },
  focus: null,
  show: (focus) => {
    set({ open: true, ...(focus !== undefined ? { focus } : {}) });
    ensureIndex();
    set((state) => ({ revision: state.revision + 1 }));
  },
  hide: () => set({ open: false }),
  setFocus: (focus) => set({ focus }),
}));

/** Rebuild the link index when files are added or removed from the library. */
export function invalidateLibraryIndex(): void {
  indexed = false;
  const valid = new Set(useLibrary.getState().files.map((file) => file.path));
  for (const path of [...cache.keys()]) {
    // Resource nodes (cards/articles) are not library files.
    if (!path.startsWith('res:') && !valid.has(path)) cache.delete(path);
  }
  useGraph.setState((state) => ({ revision: state.revision + 1 }));
}

/** Drop a path from the index (file deleted or moved) and bump the revision. */
export function forgetPath(path: string) {
  if (!cache.has(path)) return;
  cache.delete(path);
  useGraph.setState((state) => ({ revision: state.revision + 1 }));
}

/** Re-index one file after a save and bump the revision. Called from
 * notes.save via a dynamic import (graph reads notes buffers statically). */
export function refreshPath(path: string) {
  const file = useLibrary.getState().files.find((candidate) => candidate.path === path);
  if (!file || !linkable(file)) return;
  const buffer = useNotes.getState().buffers[path];
  const markdown = buffer && buffer.status === 'ready' ? buffer.content : null;
  const finish = (text: string) => {
    const key = fileKey({ ...file, isExternal: isExternalPath(file.path) });
    setCache(path, key, { path, title: docTitle(file), markdown: text });
    useGraph.setState((state) => ({ revision: state.revision + 1 }));
  };
  if (markdown !== null) {
    finish(markdown);
    return;
  }
  void readDocumentText(path, 120_000)
    .then((text) => finish(text.text))
    .catch(() => undefined);
}

/** Open a graph node on the canvas: library files via the standard flow,
 * canvas resources by focusing them. */
export function openGraphNode(id: string): boolean {
  const setView = useApp.getState().setView;
  const canvas = useCanvas.getState();
  const file = useLibrary.getState().files.find((candidate) => candidate.path === id);
  if (file) {
    openFileOnCanvas(file);
    setView('canvas');
    return true;
  }
  if (id.startsWith('res:')) {
    const rest = id.slice(4);
    const workspaceId = rest.slice(0, rest.indexOf('/'));
    const resourceId = rest.slice(rest.indexOf('/') + 1);
    if (canvas.workspaces.some((workspace) => workspace.id === workspaceId && workspace.resources.some((resource) => resource.id === resourceId))) {
      canvas.focusResource(resourceId);
      setView('canvas');
      return true;
    }
  }
  return false;
}
