/**
 * Where you were in each PDF, so a book reopens exactly where you left off: after closing the app,
 * after switching workspaces, or after closing and reopening the window.
 *
 * State is kept per file (not per window), so the same book resumes in whichever workspace opens it.
 * Nothing here depends on the PDF engine or the UI, which keeps it easy to test.
 */

export type ZoomMode = 'fit-width' | 'fit-page' | 'automatic';
/** A zoom mode, or a plain scale factor (1 = 100%). */
export type PdfZoom = ZoomMode | number;

export interface PdfViewState {
  /** Topmost visible page, 1-based. */
  page: number;
  /** Distance scrolled into that page, in PDF points from the page's top edge. */
  y: number;
  zoom: PdfZoom;
  /** Drawing colour, highlight colour and stroke width last used in this PDF. */
  color?: string;
  highlightColor?: string;
  width?: number;
  /** Milliseconds since epoch; decides which entries survive pruning. */
  updatedAt: number;
}

export const MAX_SAVED_VIEWS = 400;
export const DEFAULT_ZOOM: ZoomMode = 'fit-width';
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;
/** Scroll changes smaller than this (PDF points) are not worth saving. */
export const POSITION_TOLERANCE = 2;

const ZOOM_MODES: ZoomMode[] = ['fit-width', 'fit-page', 'automatic'];
const COLOR = /^#[0-9a-fA-F]{6}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function isZoomMode(value: unknown): value is ZoomMode {
  return typeof value === 'string' && (ZOOM_MODES as string[]).includes(value);
}

export function sanitizeZoom(value: unknown): PdfZoom {
  if (isZoomMode(value)) return value;
  if (finite(value)) return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 1000) / 1000));
  return DEFAULT_ZOOM;
}

/** Accept only a well-formed saved view; anything else is dropped rather than repaired. */
export function sanitizePdfView(raw: unknown): PdfViewState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (!finite(data.page) || data.page < 1) return null;
  const view: PdfViewState = {
    page: Math.floor(data.page),
    y: finite(data.y) && data.y > 0 ? Math.round(data.y * 10) / 10 : 0,
    zoom: sanitizeZoom(data.zoom),
    updatedAt: finite(data.updatedAt) ? data.updatedAt : 0,
  };
  if (typeof data.color === 'string' && COLOR.test(data.color)) view.color = data.color;
  if (typeof data.highlightColor === 'string' && COLOR.test(data.highlightColor)) view.highlightColor = data.highlightColor;
  if (finite(data.width) && data.width >= 1 && data.width <= 40) view.width = Math.round(data.width * 10) / 10;
  return view;
}

/** Keep the most recently used entries when the map grows beyond `limit`. */
export function pruneViews(views: Record<string, PdfViewState>, limit = MAX_SAVED_VIEWS): Record<string, PdfViewState> {
  const entries = Object.entries(views);
  if (entries.length <= limit) return views;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, limit));
}

/** Validate the saved map when loading from disk. `normalizePath` makes keys match open-file paths. */
export function migratePdfViews(raw: unknown, normalizePath: (path: string) => string = (path) => path): Record<string, PdfViewState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, PdfViewState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = normalizePath(key.trim());
    const view = sanitizePdfView(value);
    if (!path || !view) continue;
    const existing = result[path];
    if (!existing || existing.updatedAt <= view.updatedAt) result[path] = view;
  }
  return pruneViews(result);
}

export function samePosition(a: Pick<PdfViewState, 'page' | 'y'>, b: Pick<PdfViewState, 'page' | 'y'>, tolerance = POSITION_TOLERANCE): boolean {
  return a.page === b.page && Math.abs(a.y - b.y) <= tolerance;
}

export function sameZoom(a: PdfZoom, b: PdfZoom): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  return a === b;
}

/** Combine a change with what was saved. Returns the same object when nothing meaningful changed. */
export function mergePdfView(
  previous: PdfViewState | undefined,
  patch: Partial<Omit<PdfViewState, 'updatedAt'>>,
  now: number,
): PdfViewState {
  const base: PdfViewState = previous ?? { page: 1, y: 0, zoom: DEFAULT_ZOOM, updatedAt: now };
  const next: PdfViewState = { ...base };
  if (patch.page !== undefined && finite(patch.page) && patch.page >= 1) next.page = Math.floor(patch.page);
  if (patch.y !== undefined && finite(patch.y)) next.y = Math.max(0, Math.round(patch.y * 10) / 10);
  if (patch.zoom !== undefined) next.zoom = sanitizeZoom(patch.zoom);
  if (patch.color !== undefined && COLOR.test(patch.color)) next.color = patch.color;
  if (patch.highlightColor !== undefined && COLOR.test(patch.highlightColor)) next.highlightColor = patch.highlightColor;
  if (patch.width !== undefined && finite(patch.width) && patch.width >= 1 && patch.width <= 40) next.width = patch.width;

  const unchanged =
    previous !== undefined &&
    samePosition(previous, next) &&
    sameZoom(previous.zoom, next.zoom) &&
    previous.color === next.color &&
    previous.highlightColor === next.highlightColor &&
    previous.width === next.width;
  return unchanged ? previous : { ...next, updatedAt: now };
}

export interface VisiblePage {
  pageNumber: number;
  visiblePercentage: number;
  original: { pageY: number };
}

/**
 * The reading position is the topmost visible page and how far into it the top of the window sits.
 * Returns null while nothing is visible yet (the document is still laying out).
 */
export function positionFromVisibility(pages: VisiblePage[]): { page: number; y: number } | null {
  const visible = pages.filter((page) => page.visiblePercentage > 0 && finite(page.original?.pageY));
  if (visible.length === 0) return null;
  const top = visible.reduce((best, page) => (page.pageNumber < best.pageNumber ? page : best));
  return { page: top.pageNumber, y: Math.max(0, top.original.pageY) };
}

/** Keep a saved position inside a document that may have changed since (pages added or removed). */
export function clampPosition(
  position: { page: number; y: number },
  totalPages: number,
  pageHeightOf?: (page: number) => number | undefined,
): { page: number; y: number } {
  const page = Math.min(Math.max(1, Math.floor(position.page)), Math.max(1, totalPages));
  const height = pageHeightOf?.(page);
  const clampedY = height !== undefined && height > 0 ? Math.min(Math.max(0, position.y), height) : Math.max(0, position.y);
  return { page, y: page === position.page ? clampedY : 0 };
}

/** True when a view says nothing beyond the defaults, so it is not worth keeping on disk. */
export function isDefaultView(view: PdfViewState): boolean {
  return (
    view.page === 1 &&
    view.y < POSITION_TOLERANCE &&
    view.zoom === DEFAULT_ZOOM &&
    view.color === undefined &&
    view.highlightColor === undefined &&
    view.width === undefined
  );
}

export function renamePdfView(views: Record<string, PdfViewState>, from: string, to: string): Record<string, PdfViewState> {
  if (from === to || !views[from]) return views;
  const { [from]: moved, ...rest } = views;
  const existing = rest[to];
  return { ...rest, [to]: existing && existing.updatedAt > moved.updatedAt ? existing : moved };
}

export function removePdfView(views: Record<string, PdfViewState>, path: string): Record<string, PdfViewState> {
  if (!(path in views)) return views;
  const { [path]: _removed, ...rest } = views;
  return rest;
}
