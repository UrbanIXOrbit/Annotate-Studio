import { escapeMarkdown } from './annotations.ts';

/** Text selected in a PDF, with where it came from. */
export interface ClipSource {
  text: string;
  /** The book's title (file name is fine; ".pdf" is dropped). */
  title: string;
  /** 1-based page number. */
  page: number;
}

export type ClipKind = 'markdown' | 'text';

export interface NoteLike {
  path: string;
  name: string;
  file_type: string;
  modified_at: string;
}

export function isNoteFile(file: Pick<NoteLike, 'file_type'>): boolean {
  return file.file_type === 'Markdown' || file.file_type === 'Text';
}

/** Markdown notes get a block quote; plain-text notes get plain quotation marks. */
export function clipKindFor(file: Pick<NoteLike, 'file_type' | 'name'>): ClipKind {
  return file.file_type === 'Text' && !/\.(md|markdown)$/i.test(file.name) ? 'text' : 'markdown';
}

export function noteLabel(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '').trim() || name;
}

export function bookLabel(title: string): string {
  return title.replace(/\.pdf$/i, '').trim() || 'PDF';
}

/**
 * The text that lands in the note.
 *
 * Markdown:   > the selected passage
 *             >
 *             > — *Book title*, p. 12
 */
export function formatClip(source: ClipSource, kind: ClipKind): string {
  const text = source.text.replace(/\r\n?/g, '\n').trim();
  const book = bookLabel(source.title);
  if (kind === 'text') return `\u201C${text}\u201D\n\u2014 ${book}, p. ${source.page}`;
  const quote = escapeMarkdown(text)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `${quote}\n>\n> \u2014 *${escapeMarkdown(book)}*, p. ${source.page}`;
}

/**
 * Add a clip to the end of a note, separated by one blank line. Nothing already in the note is
 * changed, and the note always ends with a single newline after the clip.
 */
export function appendClip(existing: string, clip: string): string {
  if (existing.trim() === '') return `${clip}\n`;
  const trailing = /\n*$/.exec(existing)?.[0].length ?? 0;
  const separator = trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
  return `${existing}${separator}${clip}\n`;
}

export function defaultNewNoteName(title: string): string {
  return `Notes on ${bookLabel(title)}`;
}

export interface NoteOrderOptions {
  /** The note you copied to last time: shown first. */
  lastPath?: string;
  /** Notes already open on the canvas: shown next. */
  openPaths?: ReadonlySet<string>;
  query?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Notes for the picker: filtered by the search, then last used, open ones, newest first, then by name. */
export function orderNotes<T extends NoteLike>(files: T[], options: NoteOrderOptions = {}): T[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const time = (file: T) => {
    const parsed = Date.parse(file.modified_at);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return files
    .filter(isNoteFile)
    .filter((file) => query === '' || noteLabel(file.name).toLowerCase().includes(query))
    .sort((a, b) => {
      const last = Number(b.path === options.lastPath) - Number(a.path === options.lastPath);
      if (last) return last;
      const open = Number(options.openPaths?.has(b.path) ?? false) - Number(options.openPaths?.has(a.path) ?? false);
      if (open) return open;
      return time(b) - time(a) || collator.compare(noteLabel(a.name), noteLabel(b.name));
    });
}
