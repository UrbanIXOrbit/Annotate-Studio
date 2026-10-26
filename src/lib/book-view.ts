/**
 * Where you were in each e-book, so it reopens exactly where you left off.
 * Mirrors pdf-view.ts, but the position is a foliate CFI string instead of a page
 * number: e-books reflow, so only a content anchor survives font or window changes.
 */

export interface BookViewState {
  /** Canonical fragment identifier of the top of the reading position. */
  cfi: string;
  /** Milliseconds since epoch; decides which entries survive pruning. */
  updatedAt: number;
}

export const MAX_SAVED_BOOK_VIEWS = 400;
const MAX_CFI_LENGTH = 4000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Accept only a well-formed saved view; anything else is dropped rather than repaired. */
export function sanitizeBookView(raw: unknown): BookViewState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.cfi !== 'string' || data.cfi.length === 0 || data.cfi.length > MAX_CFI_LENGTH) return null;
  return { cfi: data.cfi, updatedAt: finite(data.updatedAt) ? data.updatedAt : 0 };
}

/** Keep the most recently used entries when the map grows beyond `limit`. */
export function pruneBookViews(
  views: Record<string, BookViewState>,
  limit = MAX_SAVED_BOOK_VIEWS,
): Record<string, BookViewState> {
  const entries = Object.entries(views);
  if (entries.length <= limit) return views;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, limit));
}

/** Validate the saved map when loading from disk. `normalizePath` makes keys match open-file paths. */
export function migrateBookViews(
  raw: unknown,
  normalizePath: (path: string) => string = (path) => path,
): Record<string, BookViewState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, BookViewState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = normalizePath(key.trim());
    const view = sanitizeBookView(value);
    if (!path || !view) continue;
    const existing = result[path];
    if (!existing || existing.updatedAt <= view.updatedAt) result[path] = view;
  }
  return pruneBookViews(result);
}

/** Combine a change with what was saved. Returns the same object when nothing meaningful changed. */
export function mergeBookView(
  previous: BookViewState | undefined,
  patch: Partial<Omit<BookViewState, 'updatedAt'>>,
  now: number,
): BookViewState {
  const base: BookViewState = previous ?? { cfi: '', updatedAt: now };
  if (patch.cfi !== undefined && patch.cfi === base.cfi) return previous ?? base;
  const next: BookViewState = {
    cfi: typeof patch.cfi === 'string' && patch.cfi.length > 0 && patch.cfi.length <= MAX_CFI_LENGTH ? patch.cfi : base.cfi,
    updatedAt: now,
  };
  return next;
}

export function renameBookView(views: Record<string, BookViewState>, from: string, to: string): Record<string, BookViewState> {
  if (from === to || !views[from]) return views;
  const { [from]: moved, ...rest } = views;
  const existing = rest[to];
  return { ...rest, [to]: existing && existing.updatedAt > moved.updatedAt ? existing : moved };
}

export function removeBookView(views: Record<string, BookViewState>, path: string): Record<string, BookViewState> {
  if (!(path in views)) return views;
  const { [path]: _removed, ...rest } = views;
  return rest;
}
