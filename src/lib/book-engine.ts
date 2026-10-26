/**
 * E-book engine, following pdf-engine.ts: the window hands it raw bytes and gets
 * back a foliate view or plain text, with all foliate-js details kept in one place.
 *
 * Supported: EPUB, MOBI/AZW3, FB2 and CBZ. foliate-js sniffs the format from the
 * file's magic bytes (and, for zip formats that can mean several things, its name),
 * so files are opened as a `File` carrying the original name.
 */

import type { FoliateBook, FoliateView } from 'foliate-js/view.js';

export const BOOK_EXTENSIONS = ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'cbz'];

export function isBookPath(path: string): boolean {
  const index = path.lastIndexOf('.');
  if (index < 0) return false;
  return BOOK_EXTENSIONS.includes(path.slice(index + 1).toLowerCase());
}

let viewModule: Promise<typeof import('foliate-js/view.js')> | null = null;

/** Importing registers the <foliate-view> custom element; must settle before creating one. */
export function ensureFoliateModule() {
  viewModule ??= import('foliate-js/view.js');
  return viewModule;
}

/** Create the view element; only call after `ensureFoliateModule()` has resolved. */
export function createBookView(): FoliateView {
  return document.createElement('foliate-view') as unknown as FoliateView;
}

export async function openBook(bytes: Uint8Array, name: string, view: FoliateView): Promise<FoliateBook> {
  const { makeBook } = await ensureFoliateModule();
  const file = new File([bytes.slice().buffer as ArrayBuffer], name);
  const book = await makeBook(file);
  await view.open(book);
  view.renderer.setAttribute('flow', 'scrolled');
  return book;
}

export interface ExtractedBookText {
  text: string;
  sectionsRead: number;
  sectionCount: number;
  truncated: boolean;
}

export async function extractBookText(bytes: Uint8Array, name: string, maxChars = 40_000): Promise<ExtractedBookText> {
  const { makeBook } = await ensureFoliateModule();
  const file = new File([bytes.slice().buffer as ArrayBuffer], name);
  const book = await makeBook(file);
  const parts: string[] = [];
  let length = 0;
  let sectionsRead = 0;
  for (const section of book.sections) {
    if (length >= maxChars) break;
    if (section.linear === 'no') continue;
    try {
      const doc = await section.createDocument();
      const cleaned = (doc.body?.textContent ?? '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleaned) {
        parts.push(cleaned);
        length += cleaned.length;
      }
    } catch {
      // A section that cannot be parsed should not sink the whole extraction.
    }
    sectionsRead += 1;
  }
  const joined = parts.join('\n\n');
  const truncated = length > maxChars || sectionsRead < book.sections.length;
  return { text: joined.slice(0, maxChars), sectionsRead, sectionCount: book.sections.length, truncated };
}
