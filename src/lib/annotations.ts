import { normalizeQuote } from './cards.ts';

export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'text'
  | 'drawing'
  | 'shape'
  | 'line'
  | 'stamp';

/** Filter chips in the UI group the individual kinds. */
export type KindGroup = 'highlights' | 'markup' | 'notes' | 'drawings';

export const KIND_GROUPS: { id: KindGroup; label: string; kinds: AnnotationKind[] }[] = [
  { id: 'highlights', label: 'Highlights', kinds: ['highlight'] },
  { id: 'markup', label: 'Underline & strike', kinds: ['underline', 'strikeout', 'squiggly'] },
  { id: 'notes', label: 'Notes', kinds: ['note', 'text'] },
  { id: 'drawings', label: 'Drawings', kinds: ['drawing', 'shape', 'line', 'stamp'] },
];

const KIND_LABELS: Record<AnnotationKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikeout',
  squiggly: 'Squiggly underline',
  note: 'Note',
  text: 'Text box',
  drawing: 'Drawing',
  shape: 'Shape',
  line: 'Line',
  stamp: 'Stamp',
};

export function kindLabel(kind: AnnotationKind): string {
  return KIND_LABELS[kind];
}

export function groupOfKind(kind: AnnotationKind): KindGroup {
  return KIND_GROUPS.find((group) => group.kinds.includes(kind))?.id ?? 'drawings';
}

/** Kinds whose meaning is the text they cover rather than text typed by the reader. */
export function isTextMarkup(kind: AnnotationKind): boolean {
  return kind === 'highlight' || kind === 'underline' || kind === 'strikeout' || kind === 'squiggly';
}

export interface AnnotationEntry {
  /** Id assigned by the PDF engine; stable for one scan only. */
  id: string;
  /** 1-based page number. */
  page: number;
  kind: AnnotationKind;
  /** The words covered by a highlight/underline/strikeout. Empty for everything else. */
  text: string;
  /** What the reader typed: a note body, a text box, or a comment attached to a highlight. */
  comment: string;
  /** #rrggbb */
  color?: string;
  author?: string;
  /** ISO timestamp. */
  modified?: string;
  /** Position on the page (top-left origin), used only to order entries within a page. */
  x: number;
  y: number;
}

export interface BookAnnotations {
  path: string;
  title: string;
  pageCount: number;
  entries: AnnotationEntry[];
}

// ───────── glyph hit-testing ─────────

export interface GlyphBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunLike {
  charStart: number;
  glyphs: GlyphBox[];
}

export interface RectLike {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

export interface CharRange {
  charIndex: number;
  charCount: number;
}

/**
 * Character indices whose glyph centre falls inside any of the rectangles.
 * A small vertical tolerance absorbs the difference between a highlight's quad
 * (often a little taller or shorter than the text line) and the glyph's box.
 */
export function charIndicesInRects(runs: RunLike[], rects: RectLike[]): number[] {
  const hits = new Set<number>();
  for (const run of runs) {
    run.glyphs.forEach((glyph, offset) => {
      const cx = glyph.x + glyph.width / 2;
      const cy = glyph.y + glyph.height / 2;
      for (const rect of rects) {
        const tolerance = Math.max(0.5, rect.size.height * 0.15);
        if (
          cx >= rect.origin.x &&
          cx <= rect.origin.x + rect.size.width &&
          cy >= rect.origin.y - tolerance &&
          cy <= rect.origin.y + rect.size.height + tolerance
        ) {
          hits.add(run.charStart + offset);
          break;
        }
      }
    });
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * Collapse sorted character indices into slices. Gaps of up to `maxGap` characters
 * (a space the glyph test missed, a soft hyphen) are bridged so a phrase stays whole.
 */
export function indicesToRanges(indices: number[], maxGap = 2): CharRange[] {
  const ranges: CharRange[] = [];
  let start = -1;
  let last = -1;
  for (const index of indices) {
    if (start === -1) {
      start = last = index;
    } else if (index - last - 1 <= maxGap) {
      last = index;
    } else {
      ranges.push({ charIndex: start, charCount: last - start + 1 });
      start = last = index;
    }
  }
  if (start !== -1) ranges.push({ charIndex: start, charCount: last - start + 1 });
  return ranges;
}

/** Join extracted slices into one readable quotation. */
export function joinSlices(slices: string[]): string {
  const cleaned = slices
    .map((slice) => slice.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b\ufffe\uffff]/g, ''))
    .join(' ');
  // normalizeQuote rejoins words split by a line-end hyphen; then flatten any remaining breaks.
  return normalizeQuote(cleaned).replace(/\s*\n+\s*/g, ' ').trim();
}

// ───────── colours ─────────

export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim());
  if (match) return `#${match[1].toLowerCase()}`;
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value.trim());
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return undefined;
}

// ───────── ordering, filtering, grouping ─────────

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareEntries(a: AnnotationEntry, b: AnnotationEntry): number {
  return a.page - b.page || a.y - b.y || a.x - b.x;
}

export function sortEntries(entries: AnnotationEntry[]): AnnotationEntry[] {
  return [...entries].sort(compareEntries);
}

export function compareBooks(a: { title: string }, b: { title: string }): number {
  return collator.compare(a.title, b.title);
}

export interface EntryFilter {
  groups: Record<KindGroup, boolean>;
  query: string;
}

export const ALL_GROUPS: Record<KindGroup, boolean> = { highlights: true, markup: true, notes: true, drawings: true };

export function matchesFilter(entry: AnnotationEntry, filter: EntryFilter): boolean {
  if (!filter.groups[groupOfKind(entry.kind)]) return false;
  const query = filter.query.trim().toLowerCase();
  if (!query) return true;
  return (
    entry.text.toLowerCase().includes(query) ||
    entry.comment.toLowerCase().includes(query) ||
    kindLabel(entry.kind).toLowerCase().includes(query) ||
    String(entry.page) === query ||
    `page ${entry.page}` === query
  );
}

export function filterEntries(entries: AnnotationEntry[], filter: EntryFilter): AnnotationEntry[] {
  return entries.filter((entry) => matchesFilter(entry, filter));
}

export interface PageGroup<T> {
  page: number;
  entries: T[];
}

export function groupByPage<T extends { page: number }>(entries: T[]): PageGroup<T>[] {
  const groups: PageGroup<T>[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.page === entry.page) last.entries.push(entry);
    else groups.push({ page: entry.page, entries: [entry] });
  }
  return groups;
}

export function countByGroup(entries: AnnotationEntry[]): Record<KindGroup, number> {
  const counts: Record<KindGroup, number> = { highlights: 0, markup: 0, notes: 0, drawings: 0 };
  for (const entry of entries) counts[groupOfKind(entry.kind)] += 1;
  return counts;
}

// ───────── report model shared by every export format ─────────

export interface ReportItem {
  kind: AnnotationKind;
  label: string;
  text: string;
  comment: string;
  color?: string;
  author?: string;
  modified?: string;
}

export interface ReportPage {
  page: number;
  items: ReportItem[];
}

export interface ReportBook {
  title: string;
  path: string;
  pageCount: number;
  count: number;
  pages: ReportPage[];
}

export interface Report {
  /** Heading of the document, e.g. the book title or "All books". */
  title: string;
  exportedAt: Date;
  totalCount: number;
  books: ReportBook[];
}

/** Build the export model from the books currently in view. Empty books are dropped. */
export function buildReport(books: BookAnnotations[], filter: EntryFilter, title: string, exportedAt = new Date()): Report {
  const reportBooks: ReportBook[] = [];
  for (const book of [...books].sort(compareBooks)) {
    const entries = sortEntries(filterEntries(book.entries, filter));
    if (entries.length === 0) continue;
    reportBooks.push({
      title: book.title,
      path: book.path,
      pageCount: book.pageCount,
      count: entries.length,
      pages: groupByPage(entries).map((group) => ({
        page: group.page,
        items: group.entries.map((entry) => ({
          kind: entry.kind,
          label: kindLabel(entry.kind),
          text: entry.text,
          comment: entry.comment,
          color: entry.color,
          author: entry.author,
          modified: entry.modified,
        })),
      })),
    });
  }
  return { title, exportedAt, totalCount: reportBooks.reduce((sum, book) => sum + book.count, 0), books: reportBooks };
}

export function formatExportDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function reportSummary(report: Report): string {
  const books = report.books.length;
  return `${report.totalCount} annotation${report.totalCount === 1 ? '' : 's'} from ${books} book${books === 1 ? '' : 's'}`;
}

// ───────── markdown ─────────

/** Escape characters that would be read as Markdown formatting inside running text. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    .replace(/^(\s*)([#>+-])/gm, '$1\\$2')
    .replace(/^(\s*\d+)\./gm, '$1\\.');
}

function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : line ? indent + line : ''))
    .join('\n');
}

export function reportToMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Annotations: ${escapeMarkdown(report.title)}`, '');
  lines.push(`*Exported ${formatExportDate(report.exportedAt)} · ${reportSummary(report)}*`, '');

  for (const book of report.books) {
    lines.push(`## ${escapeMarkdown(book.title)}`, '');
    lines.push(`*${book.count} annotation${book.count === 1 ? '' : 's'}*`, '');
    for (const page of book.pages) {
      lines.push(`### Page ${page.page}`, '');
      for (const item of page.items) {
        const body = item.text || (item.kind === 'note' || item.kind === 'text' ? item.comment : '');
        const comment = item.text ? item.comment : '';
        let line = `- **${item.label}**`;
        if (body) line += ` — ${indentBlock(escapeMarkdown(body), '  ')}`;
        lines.push(line);
        if (comment) lines.push(`  - **Comment:** ${indentBlock(escapeMarkdown(comment), '    ')}`);
        const meta = [item.author, item.modified ? item.modified.slice(0, 10) : ''].filter(Boolean).join(' · ');
        if (meta) lines.push(`  - *${escapeMarkdown(meta)}*`);
      }
      lines.push('');
    }
  }

  if (report.books.length === 0) lines.push('*No annotations to export.*', '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** A safe file name stem for exports. */
export function exportFileStem(title: string): string {
  const cleaned = title
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Annotations';
}
