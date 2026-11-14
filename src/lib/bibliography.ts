/**
 * Saved bibliographies — the pure layer: resolving entries to citations,
 * style-aware ordering, duplicate detection and rendering. No store imports,
 * so the whole engine is unit-testable like the rest of src/lib.
 */
import { renderBibliographyRich, renderExport, type CitationStyle, type ExportFormat } from './citation-formats.ts';
import type { BookCitation } from '@/store/books';

/** One saved row in a bibliography. */
export interface BibliographyEntry {
  id: string;
  /** Books Manager file whose saved citation is used; absent for manual entries. */
  fileId?: string;
  /** Standalone record for works cited that are not in the library. */
  manual?: BookCitation;
  /** Omitted rows stay in the list but are excluded from the output. */
  included: boolean;
}

/** A named, persisted bibliography. */
export interface Bibliography {
  id: string;
  title: string;
  style: CitationStyle;
  entries: BibliographyEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Minimal library-file view the resolver needs. */
export interface BibliographyFile {
  name: string;
  displayName?: string | null;
  citation?: BookCitation | null;
}

/** One entry as the renderer sees it. */
export interface ResolvedEntry {
  entry: BibliographyEntry;
  citation: BookCitation | null;
  /** Display label: the file's display name or the manual record's title. */
  label: string;
  /** The entry points at a file that no longer exists. */
  missing: boolean;
  /** Another included entry earlier in the list describes the same work. */
  duplicateOfId?: string;
}

/** Sort key for author–date styles: first author's family name, then year, then title. */
function citationSortKey(citation: BookCitation): string {
  const family = (citation.authors[0] ?? citation.title).split(',')[0].trim().toLowerCase();
  const year = citation.year ?? '9999';
  const title = citation.title.trim().toLowerCase();
  return `${family}|${year}|${title}`;
}

/** A stable work identity for duplicate detection across files and manual records. */
function workKey(citation: BookCitation): string {
  const family = (citation.authors[0] ?? '').split(',')[0].trim().toLowerCase();
  return `${citation.title.trim().toLowerCase()}|${family}|${citation.year ?? ''}`;
}

/**
 * Resolve every entry against the library: live citations for file entries
 * (so a fixed citation shows up in every bibliography), manual records for the
 * rest, and a `missing` flag for files that were removed from the library.
 */
export function resolveBibliographyEntries(files: Record<string, BibliographyFile>, entries: BibliographyEntry[]): ResolvedEntry[] {
  const resolved: ResolvedEntry[] = entries.map((entry) => {
    const file = entry.fileId ? files[entry.fileId] : undefined;
    if (entry.fileId) {
      return {
        entry,
        citation: file?.citation ?? null,
        label: file ? file.displayName || file.name : entry.manual?.title ?? 'Missing source',
        missing: !file,
      };
    }
    return {
      entry,
      citation: entry.manual ?? null,
      label: entry.manual?.title ?? 'Manual entry',
      missing: false,
    };
  });

  // Mark later duplicates of the same work so they can be warned about
  // (the renderer skips them; the store keeps the row).
  const seen = new Map<string, string>();
  for (const item of resolved) {
    if (!item.citation) continue;
    const key = workKey(item.citation);
    const first = seen.get(key);
    if (first) item.duplicateOfId = first;
    else seen.set(key, item.entry.id);
  }
  return resolved;
}

/**
 * Reorder resolved entries the way the style expects: alphabetical for the
 * author–date styles, entry order (first-cited) for numbered Vancouver.
 */
export function orderBibliography(resolved: ResolvedEntry[], style: CitationStyle): ResolvedEntry[] {
  if (style === 'vancouver') return [...resolved];
  return [...resolved].sort((a, b) => {
    const keyA = a.citation ? citationSortKey(a.citation) : `~${a.label.toLowerCase()}`;
    const keyB = b.citation ? citationSortKey(b.citation) : `~${b.label.toLowerCase()}`;
    return keyA.localeCompare(keyB);
  });
}

export interface RenderedBibliography {
  /** Included, ordered, de-duplicated citations in output order. */
  citations: BookCitation[];
  html: string;
  text: string;
}

/**
 * Build the actual output: only included entries, sorted for the style, with
 * later duplicates of the same work skipped so a bibliography never lists a
 * work twice.
 */
export function renderBibliography(resolved: ResolvedEntry[], style: CitationStyle, format: ExportFormat = 'txt'): RenderedBibliography {
  const citations: BookCitation[] = [];
  for (const item of orderBibliography(resolved, style)) {
    if (!item.entry.included) continue;
    if (item.duplicateOfId) continue;
    if (item.citation) citations.push(item.citation);
  }
  if (format === 'txt') {
    const { html, text } = renderBibliographyRich(citations, style);
    return { citations, html, text };
  }
  return { citations, html: '', text: renderExport(citations, format, style) };
}
