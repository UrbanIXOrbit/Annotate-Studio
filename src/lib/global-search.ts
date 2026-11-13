/**
 * Full-text search across the workspace: pure matching, ranking and snippets
 * with no store or UI imports, so the whole engine is unit-testable and the
 * search panel only supplies documents.
 */

export type SearchKind = 'note' | 'pdf' | 'book' | 'card' | 'article' | 'quote';

/** One searchable document. */
export interface SearchDoc {
  path: string;
  kind: SearchKind;
  title: string;
  /** Main searchable body. */
  text: string;
  /** Secondary searchable text (comments, source titles); matches rank lower. */
  meta?: string;
  /** Where a hit can jump back to on the canvas. */
  locator?: { page?: number; cfi?: string };
  /** Canvas resource id, for hits that focus an open window. */
  resourceId?: string;
}

export interface SearchHit {
  path: string;
  kind: SearchKind;
  title: string;
  /** Short excerpt with the first match near the start. */
  snippet: string;
  /** Character ranges inside `snippet` to highlight. */
  highlight: Array<{ start: number; end: number }>;
  score: number;
  locator?: { page?: number; cfi?: string };
  resourceId?: string;
}

/** Split a query into lowercase terms; quotes keep a phrase together. */
export function tokenize(query: string): string[] {
  const terms: string[] = [];
  const phrasePattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.toLowerCase().matchAll(phrasePattern)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value) terms.push(value);
  }
  return terms;
}

/** Collapse every whitespace run to a single space so snippets read cleanly. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** All case-insensitive occurrences of `needle` inside `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const found: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return found;
}

/**
 * Build a readable excerpt around the first term match, with the character
 * ranges of every term occurrence inside the excerpt for highlighting.
 */
export function buildSnippet(text: string, terms: string[], around = 48, span = 120): { snippet: string; highlight: Array<{ start: number; end: number }> } {
  const flat = flatten(text);
  if (flat.length === 0 || terms.length === 0) return { snippet: flat.slice(0, span), highlight: [] };
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return { snippet: flat.slice(0, span), highlight: [] };
  const start = Math.max(0, first - around);
  const end = Math.min(flat.length, first + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  const snippet = prefix + flat.slice(start, end) + suffix;
  const offset = prefix.length - start;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    for (const at of occurrences(lower, term)) {
      if (at < start || at + term.length > end) continue;
      ranges.push({ start: at + offset, end: at + offset + term.length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return { snippet, highlight: ranges };
}

/** Rank documents against a query; every term must match somewhere. */
export function searchDocs(docs: SearchDoc[], query: string, limit = 40): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const body = `${doc.text}\n${doc.meta ?? ''}`.toLowerCase();
    if (!terms.every((term) => body.includes(term) || title.includes(term))) continue;

    let score = 1;
    for (const term of terms) {
      if (title.includes(term)) score += 12;
      const count = occurrences(body, term).length;
      score += Math.min(6, count) * 2;
    }
    if (phrase.length > 1 && (body.includes(phrase) || title.includes(phrase))) score += 24;
    if (doc.locator?.page || doc.locator?.cfi) score += 2; // jumpable hits first

    // Snippet comes from the body; fall back to meta text when the match is only there.
    const snippetFrom = terms.some((term) => doc.text.toLowerCase().includes(term)) ? doc.text : (doc.meta ?? doc.text);
    const { snippet, highlight } = buildSnippet(snippetFrom, terms);
    hits.push({
      path: doc.path,
      kind: doc.kind,
      title: doc.title,
      snippet,
      highlight,
      score,
      locator: doc.locator,
      resourceId: doc.resourceId,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}
