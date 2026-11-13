/**
 * Library file metadata — the pure layer: tag normalization, criteria
 * matching and saved-collection evaluation. No store imports, so the whole
 * engine is unit-testable like the rest of src/lib.
 */

/** Per-file app metadata, keyed by the file's path (the registry's identity). */
export interface FileMeta {
  tags: string[];
  starred?: boolean;
  /** Private note about the file, independent of its content. */
  note?: string;
}

export const EMPTY_FILE_META: FileMeta = { tags: [] };

/** Saved live filters — a collection is a query, never a snapshot of files. */
export interface SavedCollection {
  id: string;
  name: string;
  criteria: CollectionCriteria;
  createdAt: string;
}

export interface CollectionCriteria {
  /** Substring matched against name, tags and the file note. */
  query?: string;
  /** File types to include, e.g. ['pdf', 'note']; empty/absent = all. */
  fileTypes?: string[];
  /** Every listed tag must be present. */
  tags?: string[];
  starred?: boolean;
}

/** Minimal file view the matcher needs (StudyFile-shaped). */
export interface MatchableFile {
  name: string;
  file_type: string;
}

/**
 * Normalize a tag: trim, collapse spaces, drop empties, dedupe
 * case-insensitively (first spelling wins), cap length and count.
 */
export function normalizeTags(input: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 24) break;
  }
  return tags;
}

/** Parse a typed tag string into normalized tags (splits on commas). */
export function parseTagInput(text: string): string[] {
  return normalizeTags(text.split(','));
}

/**
 * Match one file against criteria. Name/tags/note are matched
 * case-insensitively on every word of the query (AND).
 */
export function matchFile(file: MatchableFile, meta: FileMeta | undefined, criteria: CollectionCriteria): boolean {
  if (criteria.fileTypes && criteria.fileTypes.length > 0 && !criteria.fileTypes.includes(file.file_type)) return false;
  if (criteria.starred && !meta?.starred) return false;
  if (criteria.tags && criteria.tags.length > 0) {
    const owned = new Set((meta?.tags ?? []).map((tag) => tag.toLowerCase()));
    if (!criteria.tags.every((tag) => owned.has(tag.toLowerCase()))) return false;
  }
  const query = criteria.query?.trim().toLowerCase();
  if (query) {
    const haystack = `${file.name}\n${(meta?.tags ?? []).join(' ')}\n${meta?.note ?? ''}`.toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** Evaluate a collection against the library: live, never a snapshot. */
export function collectionFileIds(
  files: MatchableFile[],
  metas: Record<string, FileMeta>,
  paths: string[],
  criteria: CollectionCriteria,
): string[] {
  return files
    .map((file, index) => ({ file, path: paths[index], meta: metas[paths[index]] }))
    .filter(({ file, meta }) => matchFile(file, meta, criteria))
    .map(({ path }) => path);
}

/** Every tag in use, sorted by frequency then alphabetically (display spelling kept). */
export function allTags(metas: Record<string, FileMeta>): string[] {
  const info = new Map<string, { display: string; count: number }>();
  for (const meta of Object.values(metas)) {
    for (const tag of meta.tags) {
      const key = tag.toLowerCase();
      const entry = info.get(key);
      if (entry) entry.count += 1;
      else info.set(key, { display: tag, count: 1 });
    }
  }
  return [...info.values()]
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .map((entry) => entry.display);
}

/** How many files carry a tag (case-insensitive). */
export function tagUsageCount(metas: Record<string, FileMeta>, tag: string): number {
  const wanted = tag.toLowerCase();
  return Object.values(metas).filter((meta) => meta.tags.some((entry) => entry.toLowerCase() === wanted)).length;
}

/** Records that survive an edit: at least one tag, a star or a note. */
function keepMeta(meta: FileMeta): boolean {
  return meta.tags.length > 0 || !!meta.starred || !!meta.note;
}

function editedMetas(metas: Record<string, FileMeta>, edit: (meta: FileMeta) => FileMeta | null): Record<string, FileMeta> {
  const out: Record<string, FileMeta> = {};
  for (const [path, meta] of Object.entries(metas)) {
    const next = edit(meta);
    if (next && keepMeta(next)) out[path] = next;
  }
  return out;
}

/** Rename a tag on every file that carries it (case-insensitive match). */
export function renameTagInMetas(metas: Record<string, FileMeta>, from: string, to: string): Record<string, FileMeta> {
  const wanted = from.toLowerCase();
  const replacement = normalizeTags([to])[0];
  if (!replacement) return metas;
  return editedMetas(metas, (meta) => {
    if (!meta.tags.some((tag) => tag.toLowerCase() === wanted)) return meta;
    return { ...meta, tags: normalizeTags(meta.tags.map((tag) => (tag.toLowerCase() === wanted ? replacement : tag))) };
  });
}

/** Remove a tag from every file that carries it. */
export function removeTagFromMetas(metas: Record<string, FileMeta>, tag: string): Record<string, FileMeta> {
  const wanted = tag.toLowerCase();
  return editedMetas(metas, (meta) => {
    if (!meta.tags.some((entry) => entry.toLowerCase() === wanted)) return meta;
    return { ...meta, tags: meta.tags.filter((entry) => entry.toLowerCase() !== wanted) };
  });
}
