import { create } from 'zustand';
import { loadCanvasState, saveCanvasState } from '@/lib/tauri-commands';
import { createSaver } from '@/lib/persist';
import { addMembers, bucketByColor, bucketBySource, colorName, defaultGroupColor, defaultGroupTitle, hiddenIds, migrateGroups, nextGroupColor, reconcileMembership, removeMembers, type Group } from '@/lib/groups';
import { autoSides, chainPairs, type Placement } from '@/lib/arrange';
import { bookLabel } from '@/lib/note-clip';
import { isDefaultView, mergePdfView, migratePdfViews, pruneViews, removePdfView, renamePdfView, type PdfViewState } from '@/lib/pdf-view';
import { mergeBookView, migrateBookViews, pruneBookViews, removeBookView, renameBookView, type BookViewState } from '@/lib/book-view';
import { clamp, uid } from '@/lib/utils';
import { estimateCardSize, planCardPosition } from '@/lib/cards';
import { migrateConnectors, sameConnection, type Connector, type Point, type Side } from '@/lib/connectors';

export type ResourceType = 'pdf' | 'note' | 'image' | 'card' | 'book' | 'audiobook' | 'video' | 'article';

export interface ArticleHighlight {
  id: string;
  text: string;
  prefix: string;
  suffix: string;
  color: string;
  createdAt: string;
}

export interface AudioTrack {
  path: string;
  title: string;
  mediaType: string;
}

export interface CardSource {
  filePath: string;
  title: string;
  /** 1-based page the quote was taken from. */
  page: number;
  /** Books only: CFI anchor of the quote, so "go to source" lands on the exact paragraph. */
  cfi?: string;
  /** True when the source is opened directly from outside the workspace. */
  isExternal?: boolean;
}

export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

export interface Resource {
  id: string;
  type: ResourceType;
  title: string;
  filePath?: string;
  content?: string;
  articleUrl?: string;
  articleHighlights?: ArticleHighlight[];
  tracks?: AudioTrack[];
  /** Cards only: where the quote came from, accent colour, and the reader's own comment. */
  source?: CardSource;
  color?: string;
  note?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** For Books Manager: indicates file is external to workspace */
  isExternal?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  resources: Resource[];
  connectors: Connector[];
  /** Named frames around related cards. */
  groups: Group[];
  view: CanvasView;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ArrangeLayout = 'columns' | 'rows' | 'grid';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 3;
export const MIN_WINDOW_WIDTH = 280;
export const MIN_WINDOW_HEIGHT = 180;
const HISTORY_LIMIT = 100;
const DEFAULT_VIEW: CanvasView = { x: 0, y: 0, zoom: 1 };

export const DEFAULT_SIZES: Record<ResourceType, { width: number; height: number }> = {
  pdf: { width: 760, height: 880 },
  note: { width: 680, height: 560 },
  image: { width: 560, height: 440 },
  card: { width: 320, height: 200 },
  book: { width: 660, height: 840 },
  audiobook: { width: 560, height: 360 },
  video: { width: 720, height: 480 },
  article: { width: 760, height: 880 },
};

const MIN_CARD_WIDTH = 240;
const MIN_CARD_HEIGHT = 120;

export function minSizeFor(type: ResourceType): { width: number; height: number } {
  return type === 'card'
    ? { width: MIN_CARD_WIDTH, height: MIN_CARD_HEIGHT }
    : { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT };
}

export interface OpenResourceInput {
  type: ResourceType;
  title: string;
  filePath?: string;
  content?: string;
  articleUrl?: string;
  articleHighlights?: ArticleHighlight[];
  tracks?: AudioTrack[];
  width?: number;
  height?: number;
}

export interface OpenOptions {
  at?: { x: number; y: number };
  center?: { x: number; y: number };
  focusExisting?: boolean;
  near?: string;
  isExternal?: boolean;
}

export interface CardInput {
  title: string;
  content: string;
  note?: string;
  color?: string;
  source?: CardSource;
  /** Resource id to place the card next to (stacks beside its source PDF). */
  near?: string;
  /** World point to centre the card on. Takes precedence over `near`. */
  center?: Point;
}

export interface ConnectorInput {
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
}

export interface CanvasStore {
  hydrated: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** Where you were in each PDF (page, scroll position, zoom, pen settings), keyed by file path. */
  pdfViews: Record<string, PdfViewState>;
  /** Where you were in each e-book (CFI anchor), keyed by file path. */
  bookViews: Record<string, BookViewState>;
  selectedId: string | null;
  /** Every selected window; `selectedId` is the one you touched last. */
  selectedIds: string[];
  selectedConnectorId: string | null;
  locked: boolean;
  viewport: { width: number; height: number };
  past: Resource[][];
  future: Resource[][];
  hydrate: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  createWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  setView: (view: CanvasView) => void;
  panBy: (dx: number, dy: number) => void;
  zoomAt: (zoom: number, anchor?: { x: number; y: number }) => void;
  resetZoom: () => void;
  fitToContent: (ids?: string[]) => void;
  focusResource: (id: string) => void;
  setViewport: (size: { width: number; height: number }) => void;
  setLocked: (locked: boolean) => void;
  openResource: (input: OpenResourceInput, options?: OpenOptions) => string;
  addCard: (input: CardInput) => string;
  addConnector: (input: ConnectorInput) => string | null;
  updateConnector: (id: string, patch: Partial<Omit<Connector, 'id'>>) => void;
  removeConnector: (id: string) => void;
  selectConnector: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[], additive?: boolean) => void;
  selectAllCards: () => void;
  /** Move several windows at once (one undo step). `reconcile` lets dropped cards join or leave groups. */
  placeResources: (positions: Placement, options?: { reconcile?: boolean }) => void;
  closeResources: (ids: string[]) => void;
  setCardsColor: (ids: string[], color: string) => void;
  createGroup: (ids: string[], title?: string) => string | null;
  ungroup: (groupId: string) => void;
  renameGroup: (groupId: string, title: string) => void;
  setGroupColor: (groupId: string, color: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  addToGroup: (groupId: string, ids: string[]) => void;
  removeFromGroups: (ids: string[]) => void;
  /** Make one group per book (or per colour) from `ids`, or from every card. Returns how many were made. */
  groupBy: (by: 'book' | 'colour', ids?: string[]) => number;
  /** Link the cards in the given order with connectors. Returns how many were added. */
  chainResources: (orderedIds: string[], loop?: boolean) => number;
  unchainResources: (ids: string[]) => number;
  updateResource: (id: string, patch: Partial<Resource>, record?: boolean) => void;
  patchResourceIn: (workspaceId: string, id: string, patch: Partial<Resource>) => void;
  setResourceRect: (id: string, rect: Partial<Rect>) => void;
  bringToFront: (id: string) => void;
  select: (id: string | null) => void;
  closeResource: (id: string) => void;
  toggleMinimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  exitMaximize: () => void;
  minimizeAll: () => void;
  arrange: (layout: ArrangeLayout) => void;
  setPdfView: (path: string, patch: Partial<Omit<PdfViewState, 'updatedAt'>>) => void;
  setBookView: (path: string, patch: Partial<Omit<BookViewState, 'updatedAt'>>) => void;
  replaceFilePath: (oldPath: string, newPath: string, title?: string) => void;
  closeByFilePath: (path: string) => void;
  undo: () => void;
  redo: () => void;
}

export function activeWorkspace(state: Pick<CanvasStore, 'workspaces' | 'activeWorkspaceId'>): Workspace {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0];
}

function newWorkspace(name: string, id: string = uid()): Workspace {
  return { id, name, resources: [], connectors: [], groups: [], view: { ...DEFAULT_VIEW } };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function toWorkspaceRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const marker = '/annotate-studio/';
  const index = normalized.lastIndexOf(marker);
  if (index >= 0 && (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized))) {
    return normalized.slice(index + marker.length);
  }
  return normalized.replace(/^\.\//, '');
}

function isResourceType(value: unknown): value is ResourceType {
  return value === 'pdf' || value === 'note' || value === 'image' || value === 'card' || value === 'book' || value === 'audiobook' || value === 'video' || value === 'article';
}

function migrateResource(raw: unknown, index: number): Resource | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const type = data.type === 'sticky' ? 'note' : data.type;
  if (!isResourceType(type)) return null;
  const position = (data.position ?? {}) as Record<string, unknown>;
  const size = (data.size ?? {}) as Record<string, unknown>;
  const previous = (data.previousBounds ?? null) as Record<string, unknown> | null;
  const defaults = DEFAULT_SIZES[type];
  const min = minSizeFor(type);
  const wasFullscreen = data.isFullscreen === true;
  const baseX = wasFullscreen && previous ? previous.x : data.x ?? position.x;
  const baseY = wasFullscreen && previous ? previous.y : data.y ?? position.y;
  const baseW = wasFullscreen && previous ? previous.width : data.width ?? size.width;
  const baseH = wasFullscreen && previous ? previous.height : data.height ?? size.height;
  const filePath = typeof data.filePath === 'string' && data.filePath.trim() ? toWorkspaceRelative(data.filePath.trim()) : undefined;
  const rawArticle = data.article && typeof data.article === 'object' ? data.article as Record<string, unknown> : null;
  const content = typeof data.content === 'string'
    ? data.content
    : typeof rawArticle?.content === 'string'
      ? rawArticle.content
      : typeof rawArticle?.html === 'string'
        ? rawArticle.html
        : undefined;
  const savedArticleUrl = data.articleUrl ?? rawArticle?.url;
  const articleUrl = typeof savedArticleUrl === 'string' && /^https?:\/\//i.test(savedArticleUrl) ? savedArticleUrl : undefined;
  const rawHighlights = data.articleHighlights ?? rawArticle?.highlights;
  const articleHighlights = Array.isArray(rawHighlights)
    ? rawHighlights.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .filter((item) => typeof item.id === 'string' && typeof item.text === 'string')
        .map((item) => ({
          id: item.id as string,
          text: item.text as string,
          prefix: typeof item.prefix === 'string' ? item.prefix : '',
          suffix: typeof item.suffix === 'string' ? item.suffix : '',
          color: typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : '#ffe066',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        }))
    : undefined;
  const tracks = type === 'audiobook' && Array.isArray(data.tracks)
    ? data.tracks.filter((track): track is Record<string, unknown> => !!track && typeof track === 'object')
        .filter((track) => typeof track.path === 'string' && typeof track.title === 'string' && typeof track.mediaType === 'string')
        .map((track) => ({ path: toWorkspaceRelative(track.path as string), title: track.title as string, mediaType: track.mediaType as string }))
    : undefined;
  const rawSource = data.source && typeof data.source === 'object' ? (data.source as Record<string, unknown>) : null;
  const source: CardSource | undefined =
    type === 'card' && rawSource && typeof rawSource.filePath === 'string' && rawSource.filePath.trim()
      ? {
          filePath: toWorkspaceRelative(rawSource.filePath.trim()),
          title: typeof rawSource.title === 'string' && rawSource.title.trim() ? rawSource.title : 'PDF',
          page: Math.max(1, Math.round(finiteOr(rawSource.page, 1))),
          cfi: typeof rawSource.cfi === 'string' ? rawSource.cfi : undefined,
          isExternal: rawSource.isExternal === true,
        }
      : undefined;
  const color = type === 'card' && typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : undefined;
  const note = type === 'card' && typeof data.note === 'string' ? data.note : undefined;
  return {
    id: typeof data.id === 'string' && data.id ? data.id : uid(),
    type,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : (typeof rawArticle?.title === 'string' && rawArticle.title.trim() ? rawArticle.title : 'Untitled'),
    filePath,
    content: type === 'note' || type === 'card' || type === 'article' ? content : undefined,
    articleUrl,
    articleHighlights: type === 'article' ? articleHighlights : undefined,
    tracks,
    source,
    color,
    note,
    x: finiteOr(baseX, 80 + index * 32),
    y: finiteOr(baseY, 80 + index * 32),
    width: Math.max(min.width, finiteOr(baseW, defaults.width)),
    height: Math.max(min.height, finiteOr(baseH, defaults.height)),
    z: index + 1,
    minimized: data.minimized === true || data.state === 'minimized',
    maximized: data.maximized === true || wasFullscreen,
    isExternal: data.isExternal === true,
  };
}

function normalizeZ(resources: Resource[], rawOrder: unknown[]): Resource[] {
  const order = rawOrder.map((raw, index) => {
    const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return finiteOr(data.z ?? data.zIndex, index);
  });
  const ranked = resources
    .map((resource, index) => ({ resource, rank: order[index] ?? index, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const zById = new Map(ranked.map((entry, position) => [entry.resource.id, position + 1]));
  return resources.map((resource) => ({ ...resource, z: zById.get(resource.id) ?? resource.z }));
}

function migrateView(raw: unknown): CanvasView {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    x: finiteOr(data.x, 0),
    y: finiteOr(data.y, 0),
    zoom: clamp(finiteOr(data.zoom, 1), ZOOM_MIN, ZOOM_MAX),
  };
}

function migrateResources(rawList: unknown): Resource[] {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const kept: Resource[] = [];
  const keptRaw: unknown[] = [];
  rawList.forEach((raw, index) => {
    const resource = migrateResource(raw, index);
    if (!resource || seen.has(resource.id)) return;
    seen.add(resource.id);
    kept.push(resource);
    keptRaw.push(raw);
  });
  const normalized = normalizeZ(kept, keptRaw);
  const topMaximized = normalized.filter((r) => r.maximized).sort((a, b) => b.z - a.z)[0]?.id;
  return normalized.map((r) => (r.maximized && r.id !== topMaximized ? { ...r, maximized: false } : r));
}

export function migrateCanvasState(raw: unknown): {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pdfViews: Record<string, PdfViewState>;
  bookViews: Record<string, BookViewState>;
} {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let workspaces: Workspace[] = [];
  if (Array.isArray(data.workspaces)) {
    workspaces = data.workspaces
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .map((w, index) => {
        const resources = migrateResources(w.resources);
        return {
          id: typeof w.id === 'string' && w.id ? w.id : uid(),
          name: typeof w.name === 'string' && w.name.trim() ? w.name : `Workspace ${index + 1}`,
          resources,
          connectors: migrateConnectors(w.connectors, new Set(resources.map((r) => r.id)), uid),
          groups: migrateGroups(w.groups, new Set(resources.map((r) => r.id)), uid),
          view: migrateView(w.view ?? w.canvasView),
        };
      });
  } else if (Array.isArray(data.resources)) {
    workspaces = [{ id: 'default', name: 'Default Workspace', resources: migrateResources(data.resources), connectors: [], groups: [], view: migrateView(data.view) }];
  }
  const unique = new Map<string, Workspace>();
  for (const workspace of workspaces) if (!unique.has(workspace.id)) unique.set(workspace.id, workspace);
  workspaces = Array.from(unique.values());
  if (workspaces.length === 0) workspaces = [newWorkspace('Default Workspace', 'default')];
  const requested = typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : '';
  const activeWorkspaceId = workspaces.some((w) => w.id === requested) ? requested : workspaces[0].id;
  return { workspaces, activeWorkspaceId, pdfViews: migratePdfViews(data.pdfViews, toWorkspaceRelative), bookViews: migrateBookViews(data.bookViews, toWorkspaceRelative) };
}

function topZ(resources: Resource[]): number {
  return resources.reduce((max, r) => Math.max(max, r.z), 0);
}

function withFrontZ(resources: Resource[], id: string): Resource[] {
  const target = resources.find((r) => r.id === id);
  if (!target) return resources;
  const max = topZ(resources);
  if (target.z === max && resources.filter((r) => r.z === max).length === 1) return resources;
  if (max + 1 > 1_000_000) {
    const ordered = [...resources].sort((a, b) => a.z - b.z).filter((r) => r.id !== id);
    const zById = new Map(ordered.map((r, index) => [r.id, index + 1]));
    zById.set(id, ordered.length + 1);
    return resources.map((r) => ({ ...r, z: zById.get(r.id) ?? r.z }));
  }
  return resources.map((r) => (r.id === id ? { ...r, z: max + 1 } : r));
}

export function screenToWorld(view: CanvasView, point: { x: number; y: number }) {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

export function visibleWorldRect(view: CanvasView, viewport: { width: number; height: number }): Rect {
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    width: viewport.width / view.zoom,
    height: viewport.height / view.zoom,
  };
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function placeWindow(
  resources: Resource[],
  center: { x: number; y: number },
  size: { width: number; height: number },
  view: Rect,
): { x: number; y: number } {
  const visible = resources.filter((r) => !r.minimized);
  const gap = 24;
  const free = (x: number, y: number) =>
    !visible.some((r) => intersects(r, { x: x - gap / 2, y: y - gap / 2, width: size.width + gap, height: size.height + gap }));
  const inView = (x: number, y: number) =>
    x >= view.x && y >= view.y && x + size.width <= view.x + view.width && y + size.height <= view.y + view.height;
  const candidates: { x: number; y: number }[] = [{ x: center.x - size.width / 2, y: center.y - size.height / 2 }];
  for (const r of visible) {
    candidates.push(
      { x: r.x + r.width + gap, y: r.y },
      { x: r.x - size.width - gap, y: r.y },
      { x: r.x, y: r.y + r.height + gap },
      { x: r.x, y: r.y - size.height - gap },
    );
  }
  const distance = (c: { x: number; y: number }) => Math.hypot(c.x + size.width / 2 - center.x, c.y + size.height / 2 - center.y);
  const ordered = candidates.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y) })).sort((a, b) => distance(a) - distance(b));
  const best = ordered.find((c) => free(c.x, c.y) && inView(c.x, c.y)) ?? ordered.find((c) => free(c.x, c.y) && inView(c.x, c.y + size.height - 120));
  if (best) return best;
  let x = Math.round(center.x - size.width / 2);
  let y = Math.round(center.y - size.height / 2);
  for (let attempt = 0; attempt < 12 && visible.some((r) => Math.abs(r.x - x) < 24 && Math.abs(r.y - y) < 24); attempt += 1) {
    x += 36;
    y += 36;
  }
  return { x, y };
}

const saver = createSaver<{
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pdfViews: Record<string, PdfViewState>;
  bookViews: Record<string, BookViewState>;
}>(
  (value) => saveCanvasState({ version: 2, ...value }),
  500,
);

export const useCanvas = create<CanvasStore>((set, get) => {
  const active = () => activeWorkspace(get());

  const updateActive = (updater: (workspace: Workspace) => Workspace) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === state.activeWorkspaceId ? updater(w) : w)),
    }));

  const commitResources = (next: Resource[], record = true) => {
    const current = active().resources;
    if (next === current) return;
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === state.activeWorkspaceId ? { ...w, resources: next } : w)),
      past: record ? [...state.past.slice(-(HISTORY_LIMIT - 1)), current] : state.past,
      future: record ? [] : state.future,
    }));
  };

  const setViewInternal = (view: CanvasView) => {
    const next = { x: view.x, y: view.y, zoom: clamp(view.zoom, ZOOM_MIN, ZOOM_MAX) };
    const current = active().view;
    if (current.x === next.x && current.y === next.y && current.zoom === next.zoom) return;
    updateActive((w) => ({ ...w, view: next }));
  };

  return {
    hydrated: false,
    workspaces: [newWorkspace('Default Workspace', 'default')],
    activeWorkspaceId: 'default',
    pdfViews: {},
    bookViews: {},
    selectedId: null,
    selectedIds: [],
    selectedConnectorId: null,
    locked: false,
    viewport: { width: 1200, height: 800 },
    past: [],
    future: [],

    hydrate: async () => {
      if (get().hydrated) return;
      let migrated = migrateCanvasState(null);
      try {
        migrated = migrateCanvasState(await loadCanvasState());
      } catch {
        migrated = migrateCanvasState(null);
      }
      set({ ...migrated, hydrated: true, past: [], future: [], selectedId: null, selectedConnectorId: null });
    },

    switchWorkspace: (id) => {
      if (id === get().activeWorkspaceId || !get().workspaces.some((w) => w.id === id)) return;
      set({ activeWorkspaceId: id, selectedId: null, selectedConnectorId: null, past: [], future: [] });
    },
    createWorkspace: (name) => {
      const workspace = newWorkspace(name.trim() || 'Untitled Workspace');
      set((state) => ({
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        selectedId: null,
        selectedConnectorId: null,
        past: [],
        future: [],
      }));
    },
    renameWorkspace: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set((state) => ({ workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w)) }));
    },
    deleteWorkspace: (id) => {
      const { workspaces, activeWorkspaceId } = get();
      if (workspaces.length <= 1) return;
      const remaining = workspaces.filter((w) => w.id !== id);
      const nextActive = activeWorkspaceId === id ? remaining[0].id : activeWorkspaceId;
      set({
        workspaces: remaining,
        activeWorkspaceId: nextActive,
        selectedId: activeWorkspaceId === id ? null : get().selectedId,
        selectedConnectorId: activeWorkspaceId === id ? null : get().selectedConnectorId,
        past: activeWorkspaceId === id ? [] : get().past,
        future: activeWorkspaceId === id ? [] : get().future,
      });
    },

    setView: (view) => setViewInternal(view),
    panBy: (dx, dy) => {
      const view = active().view;
      setViewInternal({ ...view, x: view.x + dx, y: view.y + dy });
    },
    zoomAt: (zoom, anchor) => {
      const view = active().view;
      const nextZoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
      const { width, height } = get().viewport;
      const point = anchor ?? { x: width / 2, y: height / 2 };
      const ratio = nextZoom / view.zoom;
      setViewInternal({
        x: point.x - (point.x - view.x) * ratio,
        y: point.y - (point.y - view.y) * ratio,
        zoom: nextZoom,
      });
    },
    resetZoom: () => get().zoomAt(1),
    fitToContent: (ids) => {
      const { viewport } = get();
      const candidates = active().resources.filter((r) => !r.minimized && (!ids || ids.includes(r.id)));
      if (candidates.length === 0) {
        if (!ids) setViewInternal({ ...DEFAULT_VIEW });
        return;
      }
      const minX = Math.min(...candidates.map((r) => r.x));
      const minY = Math.min(...candidates.map((r) => r.y));
      const maxX = Math.max(...candidates.map((r) => r.x + r.width));
      const maxY = Math.max(...candidates.map((r) => r.y + r.height));
      const padding = 48;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const zoom = clamp(
        Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height, 1),
        ZOOM_MIN,
        ZOOM_MAX,
      );
      setViewInternal({
        x: viewport.width / 2 - (minX + width / 2) * zoom,
        y: viewport.height / 2 - (minY + height / 2) * zoom,
        zoom,
      });
    },
    focusResource: (id) => {
      const resources = active().resources;
      const resource = resources.find((r) => r.id === id);
      if (!resource) return;
      if (resource.minimized || resources.some((r) => r.maximized && r.id !== id)) {
        commitResources(
          resources.map((r) => (r.id === id ? { ...r, minimized: false } : r.maximized ? { ...r, maximized: false } : r)),
          resource.minimized,
        );
      }
      const { viewport } = get();
      const view = active().view;
      const rect = visibleWorldRect(view, viewport);
      const fullyVisible =
        resource.x >= rect.x && resource.y >= rect.y &&
        resource.x + resource.width <= rect.x + rect.width && resource.y + resource.height <= rect.y + rect.height;
      if (!fullyVisible) {
        const zoom = clamp(Math.min(view.zoom, (viewport.width - 64) / resource.width, (viewport.height - 64) / resource.height), ZOOM_MIN, ZOOM_MAX);
        setViewInternal({
          x: viewport.width / 2 - (resource.x + resource.width / 2) * zoom,
          y: viewport.height / 2 - (resource.y + resource.height / 2) * zoom,
          zoom,
        });
      }
      get().bringToFront(id);
      set({ selectedId: id });
    },
    setViewport: (size) => {
      const current = get().viewport;
      if (current.width === size.width && current.height === size.height) return;
      set({ viewport: size });
    },
    setLocked: (locked) => set({ locked }),

    openResource: (input, options = {}) => {
      const resources = active().resources;
      if (options.focusExisting !== false && (input.filePath || input.articleUrl)) {
        const existing = resources.find(
          (r) => (input.filePath !== undefined && r.filePath === input.filePath) ||
            (input.type === 'article' && r.type === 'article' && r.articleUrl === input.articleUrl),
        );
        if (existing) {
          get().focusResource(existing.id);
          return existing.id;
        }
      }
      const defaults = DEFAULT_SIZES[input.type];
      const view = active().view;
      const { viewport } = get();
      const visible = visibleWorldRect(view, viewport);
      const margin = 32 / view.zoom;
      const size = {
        width: Math.max(MIN_WINDOW_WIDTH, Math.round(input.width ?? Math.min(defaults.width, visible.width - margin * 2))),
        height: Math.max(MIN_WINDOW_HEIGHT, Math.round(input.height ?? Math.min(defaults.height, visible.height - margin * 2))),
      };
      let center = options.center ?? screenToWorld(view, { x: viewport.width / 2, y: viewport.height / 2 });
      const anchor = options.near ? resources.find((r) => r.id === options.near) : undefined;
      if (anchor && !options.center) {
        center = { x: anchor.x + anchor.width + 32 + size.width / 2, y: anchor.y + size.height / 2 };
      }
      const placed = options.at
        ? { x: Math.round(options.at.x), y: Math.round(options.at.y) }
        : options.center
          ? { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2) }
          : placeWindow(resources, center, size, visible);
      const keep = 140 / view.zoom;
      const position = {
        x: Math.round(clamp(placed.x, visible.x - size.width + keep, visible.x + visible.width - keep)),
        y: Math.round(clamp(placed.y, visible.y + 12 / view.zoom, Math.max(visible.y + 12 / view.zoom, visible.y + visible.height - 90 / view.zoom))),
      };
      const id = uid();
      const resource: Resource = {
        id,
        type: input.type,
        title: input.title,
        filePath: input.filePath,
        content: input.content,
        articleUrl: input.articleUrl,
        articleHighlights: input.articleHighlights,
        tracks: input.tracks,
        ...position,
        ...size,
        z: topZ(resources) + 1,
        minimized: false,
        maximized: false,
        isExternal: options.isExternal ?? false,
      };
      commitResources([...resources.map((r) => (r.maximized ? { ...r, maximized: false } : r)), resource]);
      set({ selectedId: id });
      return id;
    },
    addCard: (input) => {
      const resources = active().resources;
      const size = estimateCardSize(input.content, input.note);
      const view = active().view;
      const { viewport } = get();
      const viewCenter = screenToWorld(view, { x: viewport.width / 2, y: viewport.height / 2 });
      const anchor = input.near ? resources.find((r) => r.id === input.near) : undefined;
      const position = input.center
        ? { x: Math.round(input.center.x - size.width / 2), y: Math.round(input.center.y - size.height / 2) }
        : planCardPosition(resources, { anchor, filePath: input.source?.filePath, size, fallbackCenter: viewCenter });
      const id = uid();
      const card: Resource = {
        id,
        type: 'card',
        title: input.title,
        content: input.content,
        note: input.note,
        color: input.color,
        source: input.source,
        ...position,
        ...size,
        z: topZ(resources) + 1,
        minimized: false,
        maximized: false,
      };
      commitResources([...resources, card]);
      return id;
    },
    addConnector: (input) => {
      const workspace = active();
      if (input.from === input.to) return null;
      const ids = new Set(workspace.resources.map((r) => r.id));
      if (!ids.has(input.from) || !ids.has(input.to)) return null;
      const connector: Connector = { id: uid(), ...input, arrow: true };
      if (workspace.connectors.some((existing) => sameConnection(existing, connector))) return null;
      updateActive((w) => ({ ...w, connectors: [...w.connectors, connector] }));
      set({ selectedConnectorId: connector.id, selectedId: null });
      return connector.id;
    },
    updateConnector: (id, patch) => {
      if (!active().connectors.some((c) => c.id === id)) return;
      updateActive((w) => ({ ...w, connectors: w.connectors.map((c) => (c.id === id ? { ...c, ...patch, id } : c)) }));
    },
    removeConnector: (id) => {
      if (!active().connectors.some((c) => c.id === id)) return;
      updateActive((w) => ({ ...w, connectors: w.connectors.filter((c) => c.id !== id) }));
      if (get().selectedConnectorId === id) set({ selectedConnectorId: null });
    },
    selectConnector: (id) => {
      if (get().selectedConnectorId !== id || (id !== null && get().selectedId !== null)) {
        set({ selectedConnectorId: id, selectedId: id === null ? get().selectedId : null });
      }
    },
    updateResource: (id, patch, record = false) => {
      const resources = active().resources;
      if (!resources.some((r) => r.id === id)) return;
      commitResources(resources.map((r) => (r.id === id ? { ...r, ...patch } : r)), record);
    },
    patchResourceIn: (workspaceId, id, patch) => {
      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, resources: w.resources.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : w,
        ),
      }));
    },
    setResourceRect: (id, rect) => {
      const resources = active().resources;
      const target = resources.find((r) => r.id === id);
      if (!target) return;
      const next = {
        x: Math.round(rect.x ?? target.x),
        y: Math.round(rect.y ?? target.y),
        width: Math.max(minSizeFor(target.type).width, Math.round(rect.width ?? target.width)),
        height: Math.max(minSizeFor(target.type).height, Math.round(rect.height ?? target.height)),
      };
      if (next.x === target.x && next.y === target.y && next.width === target.width && next.height === target.height) return;
      commitResources(resources.map((r) => (r.id === id ? { ...r, ...next } : r)));
    },
    bringToFront: (id) => {
      const resources = active().resources;
      const next = withFrontZ(resources, id);
      if (next !== resources) commitResources(next, false);
    },
    select: (id) => {
      if (get().selectedId !== id || get().selectedConnectorId !== null) set({ selectedId: id, selectedConnectorId: null });
    },
    toggleSelect: (id) => {
      const existing = new Set(active().resources.map((r) => r.id));
      if (!existing.has(id)) return;
      const current = get().selectedIds.filter((other) => existing.has(other));
      const next = current.includes(id) ? current.filter((other) => other !== id) : [...current, id];
      set({ selectedIds: next, selectedId: next.length > 0 ? next[next.length - 1] : null, selectedConnectorId: null });
    },
    selectMany: (ids, additive = false) => {
      const existing = new Set(active().resources.map((r) => r.id));
      const base = additive ? get().selectedIds.filter((other) => existing.has(other)) : [];
      const next = [...new Set([...base, ...ids.filter((id) => existing.has(id))])];
      set({ selectedIds: next, selectedId: next.length > 0 ? next[next.length - 1] : null, selectedConnectorId: null });
    },
    selectAllCards: () => {
      const workspace = active();
      const hidden = hiddenIds(workspace.groups, new Set(workspace.resources.map((r) => r.id)));
      get().selectMany(workspace.resources.filter((r) => r.type === 'card' && !r.minimized && !hidden.has(r.id)).map((r) => r.id));
    },
    placeResources: (positions, options) => {
      const resources = active().resources;
      let changed = false;
      const next = resources.map((r) => {
        const target = positions[r.id];
        if (!target || (target.x === r.x && target.y === r.y)) return r;
        changed = true;
        return { ...r, x: Math.round(target.x), y: Math.round(target.y) };
      });
      if (!changed) return;
      commitResources(next);
      if (options?.reconcile) {
        const boxes = new Map(next.filter((r) => !r.minimized).map((r) => [r.id, { x: r.x, y: r.y, width: r.width, height: r.height }]));
        const groups = reconcileMembership(active().groups, boxes, new Set(Object.keys(positions)));
        if (groups !== active().groups) updateActive((w) => ({ ...w, groups }));
      }
    },
    closeResources: (ids) => {
      const closing = new Set(ids);
      const resources = active().resources;
      if (!resources.some((r) => closing.has(r.id))) return;
      commitResources(resources.filter((r) => !closing.has(r.id)));
      const remaining = get().selectedIds.filter((id) => !closing.has(id));
      set({ selectedIds: remaining, selectedId: remaining.length > 0 ? remaining[remaining.length - 1] : null });
    },
    setCardsColor: (ids, color) => {
      const chosen = new Set(ids);
      const resources = active().resources;
      if (!resources.some((r) => chosen.has(r.id) && r.type === 'card' && r.color !== color)) return;
      commitResources(resources.map((r) => (chosen.has(r.id) && r.type === 'card' ? { ...r, color } : r)));
    },
    createGroup: (ids, title) => {
      const workspace = active();
      const byId = new Map(workspace.resources.map((r) => [r.id, r]));
      const members = [...new Set(ids)].filter((id) => byId.has(id));
      if (members.length === 0) return null;
      const info = members.map((id) => ({ id, color: byId.get(id)!.color, source: byId.get(id)!.source?.title }));
      const group: Group = {
        id: uid(),
        title: title?.trim() || defaultGroupTitle(info, workspace.groups.length),
        color: defaultGroupColor(info, workspace.groups),
        members,
        collapsed: false,
      };
      updateActive((w) => ({ ...w, groups: [...removeMembers(w.groups, members), group] }));
      return group.id;
    },
    ungroup: (groupId) => updateActive((w) => ({ ...w, groups: w.groups.filter((group) => group.id !== groupId) })),
    renameGroup: (groupId, title) => {
      const clean = title.trim().slice(0, 80);
      if (!clean) return;
      updateActive((w) => ({ ...w, groups: w.groups.map((group) => (group.id === groupId ? { ...group, title: clean } : group)) }));
    },
    setGroupColor: (groupId, color) => updateActive((w) => ({ ...w, groups: w.groups.map((group) => (group.id === groupId ? { ...group, color } : group)) })),
    toggleGroupCollapsed: (groupId) => {
      const group = active().groups.find((candidate) => candidate.id === groupId);
      if (!group) return;
      updateActive((w) => ({ ...w, groups: w.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, collapsed: !candidate.collapsed } : candidate)) }));
      if (!group.collapsed) {
        const hiding = new Set(group.members);
        const remaining = get().selectedIds.filter((id) => !hiding.has(id));
        set({ selectedIds: remaining, selectedId: remaining.length > 0 ? remaining[remaining.length - 1] : null });
      }
    },
    addToGroup: (groupId, ids) => {
      if (!active().groups.some((group) => group.id === groupId)) return;
      const existing = new Set(active().resources.map((r) => r.id));
      updateActive((w) => ({ ...w, groups: addMembers(w.groups, groupId, ids.filter((id) => existing.has(id))) }));
    },
    removeFromGroups: (ids) => updateActive((w) => ({ ...w, groups: removeMembers(w.groups, ids) })),
    groupBy: (by, ids) => {
      const workspace = active();
      const hidden = hiddenIds(workspace.groups, new Set(workspace.resources.map((r) => r.id)));
      const wanted = ids ? new Set(ids) : null;
      const cards = workspace.resources.filter((r) => r.type === 'card' && !r.minimized && !hidden.has(r.id) && (!wanted || wanted.has(r.id)));
      const info = cards.map((r) => ({ id: r.id, color: r.color, source: r.source?.title }));
      const buckets =
        by === 'book'
          ? bucketBySource(info).map((bucket) => ({ title: bookLabel(bucket.source), color: undefined as string | undefined, ids: bucket.ids }))
          : bucketByColor(info).map((bucket) => ({ title: colorName(bucket.color), color: bucket.color, ids: bucket.ids }));
      const worthy = buckets.filter((bucket) => bucket.ids.length >= 2);
      if (worthy.length === 0) return 0;
      let groups = workspace.groups;
      const made: Group[] = [];
      for (const bucket of worthy) {
        groups = removeMembers(groups, bucket.ids);
        const members = info.filter((card) => bucket.ids.includes(card.id));
        made.push({
          id: uid(),
          title: bucket.title,
          color: bucket.color ?? defaultGroupColor(members, [...groups, ...made]) ?? nextGroupColor(groups),
          members: bucket.ids,
          collapsed: false,
        });
      }
      updateActive((w) => ({ ...w, groups: [...groups, ...made] }));
      return made.length;
    },
    chainResources: (orderedIds, loop = false) => {
      const workspace = active();
      const byId = new Map(workspace.resources.map((r) => [r.id, r]));
      const pairs = chainPairs(orderedIds.filter((id) => byId.has(id)), loop);
      const connectors = [...workspace.connectors];
      let added = 0;
      for (const [from, to] of pairs) {
        if (connectors.some((c) => c.from === from && c.to === to)) continue;
        connectors.push({ id: uid(), from, to, ...autoSides(byId.get(from)!, byId.get(to)!), arrow: true });
        added += 1;
      }
      if (added > 0) updateActive((w) => ({ ...w, connectors }));
      return added;
    },
    unchainResources: (ids) => {
      const chosen = new Set(ids);
      const before = active().connectors;
      const after = before.filter((c) => !(chosen.has(c.from) && chosen.has(c.to)));
      if (after.length === before.length) return 0;
      updateActive((w) => ({ ...w, connectors: after }));
      return before.length - after.length;
    },
    closeResource: (id) => {
      const resources = active().resources;
      if (!resources.some((r) => r.id === id)) return;
      commitResources(resources.filter((r) => r.id !== id));
      set({ selectedIds: get().selectedIds.filter((other) => other !== id), ...(get().selectedId === id ? { selectedId: null } : {}) });
    },
    toggleMinimize: (id) => {
      const resources = active().resources;
      const target = resources.find((r) => r.id === id);
      if (!target) return;
      const minimized = !target.minimized;
      let next = resources.map((r) =>
        r.id === id ? { ...r, minimized, maximized: minimized ? false : r.maximized } : !minimized && r.maximized ? { ...r, maximized: false } : r,
      );
      if (!minimized) next = withFrontZ(next, id);
      commitResources(next);
      set({ selectedId: minimized ? (get().selectedId === id ? null : get().selectedId) : id });
    },
    toggleMaximize: (id) => {
      const resources = active().resources;
      const target = resources.find((r) => r.id === id);
      if (!target) return;
      const maximized = !target.maximized;
      commitResources(
        resources.map((r) =>
          r.id === id ? { ...r, maximized, minimized: false } : maximized && r.maximized ? { ...r, maximized: false } : r,
        ),
        false,
      );
      set({ selectedId: id });
    },
    exitMaximize: () => {
      const resources = active().resources;
      if (!resources.some((r) => r.maximized)) return;
      commitResources(resources.map((r) => (r.maximized ? { ...r, maximized: false } : r)), false);
    },
    minimizeAll: () => {
      const resources = active().resources;
      if (resources.every((r) => r.minimized)) return;
      commitResources(resources.map((r) => ({ ...r, minimized: true, maximized: false })));
      set({ selectedId: null });
    },
    arrange: (layout) => {
      const resources = active().resources;
      const visible = resources.filter((r) => !r.minimized && r.type !== 'card').sort((a, b) => a.x - b.x || a.y - b.y);
      if (visible.length === 0) return;
      const { viewport } = get();
      const view = active().view;
      const origin = screenToWorld(view, { x: 0, y: 0 });
      const gap = 12;
      const count = visible.length;
      const columns = layout === 'columns' ? count : layout === 'rows' ? 1 : Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / columns);
      const cellWidth = Math.max(MIN_WINDOW_WIDTH, Math.floor((viewport.width - gap * (columns + 1)) / columns));
      const cellHeight = Math.max(MIN_WINDOW_HEIGHT, Math.floor((viewport.height - gap * (rows + 1)) / rows));
      const layoutById = new Map<string, Rect>();
      visible.forEach((resource, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        layoutById.set(resource.id, {
          x: Math.round(origin.x + gap + column * (cellWidth + gap)),
          y: Math.round(origin.y + gap + row * (cellHeight + gap)),
          width: cellWidth,
          height: cellHeight,
        });
      });
      commitResources(resources.map((r) => {
        const rect = layoutById.get(r.id);
        return rect ? { ...r, ...rect, maximized: false } : r;
      }));
      setViewInternal({ x: -origin.x, y: -origin.y, zoom: 1 });
    },
    setPdfView: (path, patch) => {
      if (!path) return;
      const current = get().pdfViews;
      const next = mergePdfView(current[path], patch, Date.now());
      if (next === current[path]) return;
      // A view that says nothing beyond the defaults is not worth keeping on disk.
      const views = isDefaultView(next) ? removePdfView(current, path) : pruneViews({ ...current, [path]: next });
      set({ pdfViews: views });
    },
    setBookView: (path, patch) => {
      if (!path) return;
      const current = get().bookViews;
      const next = mergeBookView(current[path], patch, Date.now());
      if (next === current[path]) return;
      set({ bookViews: pruneBookViews({ ...current, [path]: next }) });
    },
    replaceFilePath: (oldPath, newPath, title) => {
      const rename = (resources: Resource[]) =>
        resources.some((r) => r.filePath === oldPath || r.source?.filePath === oldPath)
          ? resources.map((r) => {
              if (r.filePath === oldPath) return { ...r, filePath: newPath, title: title ?? r.title };
              if (r.source?.filePath === oldPath) return { ...r, source: { ...r.source, filePath: newPath, title: title ?? r.source.title } };
              return r;
            })
          : resources;
      set((state) => ({
        workspaces: state.workspaces.map((w) => {
          const resources = rename(w.resources);
          return resources === w.resources ? w : { ...w, resources };
        }),
        past: state.past.map(rename),
        future: state.future.map(rename),
        pdfViews: renamePdfView(state.pdfViews, oldPath, newPath),
        bookViews: renameBookView(state.bookViews, oldPath, newPath),
      }));
    },
    closeByFilePath: (path) => {
      set((state) => {
        const workspaces = state.workspaces.map((w) => {
          if (!w.resources.some((r) => r.filePath === path)) return w;
          const resources = w.resources.filter((r) => r.filePath !== path);
          const ids = new Set(resources.map((r) => r.id));
          return { ...w, resources, connectors: w.connectors.filter((c) => ids.has(c.from) && ids.has(c.to)) };
        });
        const selectedExists = activeWorkspace({ workspaces, activeWorkspaceId: state.activeWorkspaceId }).resources.some(
          (r) => r.id === state.selectedId,
        );
        return { workspaces, pdfViews: removePdfView(state.pdfViews, path), bookViews: removeBookView(state.bookViews, path), past: [], future: [], selectedId: selectedExists ? state.selectedId : null };
      });
    },

    undo: () => {
      const { past, future, selectedId } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      const current = active().resources;
      updateActive((w) => ({ ...w, resources: previous }));
      set({
        past: past.slice(0, -1),
        future: [...future, current],
        selectedId: previous.some((r) => r.id === selectedId && !r.minimized) ? selectedId : null,
      });
    },
    redo: () => {
      const { past, future, selectedId } = get();
      if (future.length === 0) return;
      const next = future[future.length - 1];
      const current = active().resources;
      updateActive((w) => ({ ...w, resources: next }));
      set({
        future: future.slice(0, -1),
        past: [...past, current],
        selectedId: next.some((r) => r.id === selectedId && !r.minimized) ? selectedId : null,
      });
    },
  };
});

useCanvas.subscribe((state, previous) => {
  if (!state.hydrated || !previous.hydrated) return;
  if (
    state.workspaces === previous.workspaces &&
    state.activeWorkspaceId === previous.activeWorkspaceId &&
    state.pdfViews === previous.pdfViews &&
    state.bookViews === previous.bookViews
  )
    return;
  saver.schedule({
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    pdfViews: state.pdfViews,
    bookViews: state.bookViews,
  });
});

export function useActiveWorkspace(): Workspace {
  return useCanvas((state) => activeWorkspace(state));
}

/**
 * `selectedId` is set in many places (opening, focusing, closing...). This keeps `selectedIds` in step:
 * selecting something outside the current selection replaces it; clearing clears it; clicking a member of a
 * multi-selection leaves the selection intact so the group can be dragged.
 */
useCanvas.subscribe((state, previous) => {
  if (state.selectedId === previous.selectedId && state.activeWorkspaceId === previous.activeWorkspaceId) return;
  if (state.selectedId === null) {
    if (state.selectedIds.length > 0) useCanvas.setState({ selectedIds: [] });
  } else if (!state.selectedIds.includes(state.selectedId)) {
    useCanvas.setState({ selectedIds: [state.selectedId] });
  }
});

/** Windows tucked away because their group is collapsed. */
export function hiddenResourceIds(workspace: Workspace): Set<string> {
  return hiddenIds(workspace.groups, new Set(workspace.resources.map((r) => r.id)));
}
