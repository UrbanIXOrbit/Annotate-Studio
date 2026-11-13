/**
 * Report compiler — the pure layer: turns selected notes, highlight cards and
 * PDF/book annotations plus a resolved bibliography into one structured
 * manuscript. Markdown in, markdown out; the export step (md/txt/docx/pdf) is
 * the existing note-export pipeline. No store imports.
 */
import { escapeMarkdown, type ReportItem } from './annotations.ts';
import { stripFrontMatter } from './note-export.ts';
import { formatClip, type CardClip } from './note-clip.ts';
import { parseMarkdown, inlineText } from './markdown.ts';
import { formatCitation, type CitationStyle } from './citation-formats.ts';
import type { ResolvedEntry } from './bibliography.ts';

/** A note going into the manuscript. */
export interface CompileNote {
  path: string;
  title: string;
  markdown: string;
}

/** Annotations from one PDF/book, grouped by page (the annotations report shape). */
export interface CompileSourceBook {
  title: string;
  /** What `page` counts: PDF pages or e-book chapters. */
  locationUnit?: 'page' | 'chapter';
  pages: Array<{ page: number; items: ReportItem[] }>;
}

export interface CompileOptions {
  includeToc: boolean;
  includeHighlights: boolean;
  includeBibliography: boolean;
  style: CitationStyle;
}

export interface CompileInput {
  title: string;
  notes: CompileNote[];
  /** Canvas cards: a quote from a source plus the reader's comment. */
  cards: CardClip[];
  /** PDF/book annotation highlights, grouped per source. */
  sourceBooks: CompileSourceBook[];
  /** Resolved + ordered bibliography entries (missing/duplicate entries skipped). */
  bibliography: ResolvedEntry[];
  options: CompileOptions;
}

export interface CompileStats {
  notes: number;
  highlights: number;
  citations: number;
  words: number;
}

/**
 * Shift ATX headings down by `levels` so a note's own structure nests under its
 * section heading (capped at level 6). Fenced code blocks are untouched, as are
 * `#` characters anywhere but the start of a line.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  if (levels <= 0) return markdown;
  let inFence = false;
  let fenceMarker = '';
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^\s{0,3}(```+|~~~+)\s*([^`]*)$/.exec(line);
      if (fence) {
        const marker = fence[1].slice(0, 3);
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
        }
        return line;
      }
      if (inFence) return line;
      const heading = /^(#{1,6})(\s)/.exec(line);
      if (!heading) return line;
      const shifted = Math.min(6, heading[1].length + levels);
      return `${'#'.repeat(shifted)}${line.slice(heading[1].length)}`;
    })
    .join('\n');
}

/** Headings of level ≤ maxLevel, in document order, outside code blocks. */
function collectHeadings(markdown: string, maxLevel: number): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (const block of parseMarkdown(stripFrontMatter(markdown))) {
    if (block.type === 'heading' && block.level <= maxLevel) {
      const text = inlineText(block.children).trim();
      if (text) headings.push({ level: block.level, text });
    }
  }
  return headings;
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** Quote + comment blocks for the cards, in the given order. */
function cardsToMarkdown(cards: CardClip[]): string {
  const parts: string[] = [];
  for (const card of cards) {
    const text = card.text.replace(/\r\n?/g, '\n').trim();
    const comment = card.comment.replace(/\r\n?/g, '\n').trim();
    if (!text && !comment) continue;
    const piece: string[] = [];
    if (text && card.source) {
      piece.push(formatClip({ text, title: card.source.title, page: card.source.page }, 'markdown'));
    } else if (text) {
      piece.push(
        escapeMarkdown(text)
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n'),
      );
    }
    if (comment) piece.push(escapeMarkdown(comment));
    parts.push(piece.join('\n\n'));
  }
  return parts.join('\n\n');
}

/** Quote + comment blocks for one book's annotations, grouped by page. */
function sourceBookToMarkdown(book: CompileSourceBook): string {
  const unit = book.locationUnit === 'chapter' ? 'chapter' : 'p.';
  const parts: string[] = [];
  for (const page of book.pages) {
    for (const item of page.items) {
      const body = item.text || item.comment || '';
      const comment = item.text ? item.comment : '';
      const piece: string[] = [];
      if (body) {
        // Same convention as cards: quote with the source inside the block quote.
        piece.push(formatClip({ text: body, title: book.title, page: page.page }, 'markdown'));
        if (unit === 'chapter') {
          // formatClip always says "p." — books may count chapters instead.
          piece[piece.length - 1] = piece[piece.length - 1].replace(/, p\. (\d+)$/, ', chapter $1');
        }
      }
      if (comment) piece.push(escapeMarkdown(comment));
      const block = piece.join('\n\n').trim();
      if (block) parts.push(block);
    }
  }
  return parts.join('\n\n');
}

/** A note's body: front matter off, and a leading heading that merely repeats
 * the title dropped (the manuscript's section heading already says it). */
function noteBody(note: CompileNote): string {
  let body = stripFrontMatter(note.markdown.replace(/\r\n?/g, '\n')).trim();
  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*#*\n/.exec(body);
  if (heading && heading[1].trim().toLowerCase() === note.title.trim().toLowerCase()) {
    body = body.slice(heading[0].length).trim();
  }
  return demoteHeadings(body, 1);
}

/**
 * Compile the manuscript. Sections are emitted in a fixed order — front
 * matter, contents, notes, highlights, bibliography — and every part is
 * skipped cleanly when its input is empty.
 */
export function compileReport(input: CompileInput): { markdown: string; stats: CompileStats } {
  const { options } = input;
  const lines: string[] = [];
  const push = (...text: string[]) => lines.push(...text, '');

  // ── Front matter ──
  push(`# ${escapeMarkdown(input.title.trim() || 'Report')}`);
  push(`*Compiled ${formatExportDate(new Date())}*`);

  // ── Notes ──
  const noteBlocks = input.notes.map((note) => ({ note, body: noteBody(note) }));
  const tocEntries: Array<{ level: number; text: string }> = [];

  if (options.includeToc) {
    for (const { note, body } of noteBlocks) {
      if (!body) continue;
      tocEntries.push({ level: 2, text: note.title });
      for (const heading of collectHeadings(note.markdown, 2)) {
        if (heading.level > 1) tocEntries.push({ level: 3, text: heading.text });
      }
    }
    if (options.includeHighlights) tocEntries.push({ level: 2, text: 'Highlights' });
    if (options.includeBibliography && input.bibliography.length > 0) tocEntries.push({ level: 2, text: 'Bibliography' });
  }

  if (tocEntries.length > 0) {
    push('## Contents');
    push(tocEntries.map((entry) => `${'  '.repeat(entry.level - 2)}- ${escapeMarkdown(entry.text)}`).join('\n'));
  }

  let noteCount = 0;
  for (const { note, body } of noteBlocks) {
    if (!body) continue;
    noteCount += 1;
    push(`## ${escapeMarkdown(note.title)}`);
    push(body);
  }

  // ── Highlights ──
  let highlightCount = 0;
  if (options.includeHighlights) {
    const cardBody = cardsToMarkdown(input.cards);
    highlightCount += input.cards.filter((card) => card.text.trim() || card.comment.trim()).length;
    const bookBodies = input.sourceBooks
      .map((book) => ({ book, body: sourceBookToMarkdown(book) }))
      .filter(({ body }) => body);
    for (const { book } of bookBodies) {
      highlightCount += book.pages.reduce((sum, page) => sum + page.items.length, 0);
    }
    if (cardBody || bookBodies.length > 0) {
      push('## Highlights');
      const sections: string[] = [];
      for (const { book, body } of bookBodies) {
        sections.push(`### ${escapeMarkdown(book.title)}\n\n${body}`);
      }
      if (cardBody) sections.push(cardBody);
      push(sections.join('\n\n'));
    }
  }

  // ── Annotated bibliography ──
  const citations = input.bibliography.filter((entry) => entry.citation);
  if (options.includeBibliography && citations.length > 0) {
    push('## Bibliography');
    const entries = citations.map((entry, index) => {
      const citation = formatCitation(options.style, entry.citation!);
      const note = entry.citation!.note?.trim();
      const label = `${index + 1}. ${citation}`;
      return note ? `${label}\n\n    ${escapeMarkdown(note)}` : label;
    });
    push(entries.join('\n\n'));
  }

  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return {
    markdown,
    stats: {
      notes: noteCount,
      highlights: highlightCount,
      citations: citations.length,
      words: countWords(markdown),
    },
  };
}

function formatExportDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
