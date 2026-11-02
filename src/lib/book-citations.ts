import type { BookCitation, BookFile, CitationAuthorName, CitationField, CitationSourceName } from '@/store/books';
import { CITATION_FIELDS } from './citation-schema.ts';
import { getPdfEngine } from './pdf-engine.ts';
import { readExternalFileBytes, readFileBytes, errorMessage } from './tauri-commands.ts';
import { uid } from './utils.ts';
import {
  lookupLine,
  type LookupEntry,
  type LookupOptions,
  type MergedRef,
  SOURCE_LABELS,
} from './reference-lookup.ts';

/**
 * Citation facade for the Books Manager.
 *
 * Extraction reads the book file itself (foliate-js for EPUB/MOBI/FB2/CBZ,
 * the EmbedPDF engine for PDFs); lookup runs the multi-source reference
 * engine (`reference-lookup.ts`, the therightbibtex method) and merges the
 * records into one best citation with provenance and conflicts.
 */

const EBOOK_EXTENSIONS = new Set(['epub', 'mobi', 'azw', 'azw3', 'prc', 'fb2', 'fbz', 'cbz']);

/** PDFs carry the PDF Info dictionary; the rest are the foliate ebook formats. */
export function isCitationCapable(extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return ext === 'pdf' || EBOOK_EXTENSIONS.has(ext);
}

/** Loose shape of foliate-js `book.metadata` / EmbedPDF metadata as actually read here. */
type MetaValue = string | Record<string, string> | { name?: unknown } | MetaValue[];
interface RawMeta {
  title?: MetaValue;
  subtitle?: MetaValue;
  author?: MetaValue;
  creator?: MetaValue;
  publisher?: MetaValue;
  published?: string;
  date?: string;
  modified?: string;
  creationDate?: Date | string | null;
  language?: MetaValue;
  identifier?: string;
  isbn?: string;
  altIdentifier?: string | string[];
  source?: string | string[];
}

// Loose value coercion — foliate metadata mixes strings, language maps
// ({ en: "Title" }), contributor objects ({ name: ... }) and arrays of those.

function flattenString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.length ? flattenString(value[0]) : '';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('name' in obj) return flattenString(obj.name);
    const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim());
    return typeof first === 'string' ? first.trim() : '';
  }
  return '';
}

function flattenStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => flattenStringArray(v));
  const s = flattenString(value);
  return s ? [s] : [];
}

function splitAuthors(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function yearFromDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return String(value.getFullYear());
  const s = typeof value === 'string' ? value : '';
  return s.match(/\d{4}/)?.[0] ?? '';
}

/** Filename → searchable title ("My_Book_2nd_ed" → "My Book"). */
export function fallbackTitleFromFile(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DOIs glued into filenames with an @ or _ for the slash ("10.1515_9783111611358-005.pdf"). */
export function doiFromFilename(name: string): string | undefined {
  const stem = name.replace(/\.[^.]+$/, '');
  const m = stem.match(/^(10\.\d{4,9})[_@](.+)$/);
  if (!m) return undefined;
  const doi = `${m[1]}/${m[2]}`;
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

function normalizeIsbnString(value: string): string {
  const cleaned = value.replace(/^urn:isbn:/i, '').replace(/[-\s]/g, '');
  if (/^\d{9}[\dXx]$/.test(cleaned) || /^\d{13}$/.test(cleaned)) return cleaned.toUpperCase();
  return '';
}

function normalizeDoiString(value: string): string {
  return value.replace(/^urn:doi:/i, '').replace(/^doi:\s*/i, '').trim();
}

/** Pull ISBN/DOI out of whatever identifier-ish strings the metadata carries. */
function identifiersFrom(values: unknown): { isbn?: string; doi?: string } {
  const list = flattenStringArray(values);
  for (const raw of list) {
    const value = raw.trim();
    if (/^urn:isbn:/i.test(value) || /^\d[-\d]{8,}\d[Xx]?$/.test(value)) {
      const isbn = normalizeIsbnString(value);
      if (isbn) return { isbn };
    }
    if (/^urn:doi:/i.test(value) || /^10\./.test(value)) {
      const doi = normalizeDoiString(value);
      if (doi) return { doi };
    }
  }
  return {};
}

// ── Extraction from files ────────────────────────────────────────────────────

async function extractEbookCitation(bytes: Uint8Array, file: BookFile): Promise<BookCitation> {
  const { makeBook } = await import('foliate-js/view.js');
  const book = await makeBook(new Blob([bytes as BlobPart]));
  const meta = (book.metadata ?? {}) as RawMeta;

  const title = flattenString(meta.title) || fallbackTitleFromFile(file.name);
  const authors = flattenStringArray(meta.author).length ? flattenStringArray(meta.author) : flattenStringArray(meta.creator);
  const published = meta.published ?? meta.date ?? '';
  const { isbn, doi } = identifiersFrom([meta.identifier, meta.isbn, meta.altIdentifier, meta.source].flat());
  const publisher = flattenString(meta.publisher);

  return {
    title,
    authors,
    publisher: publisher || undefined,
    year: yearFromDate(published) || undefined,
    isbn,
    doi,
    language: flattenStringArray(meta.language)[0] || undefined,
    source: 'embedded',
    retrievedAt: new Date().toISOString(),
  };
}

async function extractPdfCitation(bytes: Uint8Array, file: BookFile): Promise<BookCitation> {
  const engine = await getPdfEngine();
  const content = bytes.slice().buffer as ArrayBuffer;
  const doc = await engine.openDocumentBuffer({ id: `cite-${uid()}`, content }).toPromise();
  try {
    const meta = await engine.getMetadata(doc).toPromise();
    const title = (meta.title ?? '').trim() || fallbackTitleFromFile(file.name);
    const authors = splitAuthors((meta.author ?? '').trim());
    // PDF CreationDate is when the file was made, not when the work was
    // published — a weak hint only; the lookup replaces it.
    const year = yearFromDate(meta.creationDate) || undefined;
    return {
      title,
      authors,
      year,
      pageCount: doc.pageCount || undefined,
      source: 'embedded',
      retrievedAt: new Date().toISOString(),
    };
  } finally {
    await engine.closeDocument(doc).toPromise().catch(() => undefined);
  }
}

/** Read a book file's embedded metadata as a citation seed. Throws with a readable message. */
export async function extractCitationFromFile(file: BookFile): Promise<BookCitation> {
  const ext = file.extension.toLowerCase().replace(/^\./, '');
  if (ext !== 'pdf' && !EBOOK_EXTENSIONS.has(ext)) {
    throw new Error(`Citations can't be read automatically from .${ext || 'this'} files — enter one manually.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readExternalFileBytes(file.filePath);
  } catch {
    bytes = await readFileBytes(file.filePath);
  }
  try {
    const citation = ext === 'pdf' ? await extractPdfCitation(bytes, file) : await extractEbookCitation(bytes, file);
    // Downloaded article PDFs often carry the DOI in their filename instead of
    // their metadata ("10.1515_9783111611358-005.pdf") — that unlocks the
    // strong-identifier lookup path.
    if (!citation.doi && !citation.isbn) {
      const filenameDoi = doiFromFilename(file.name);
      if (filenameDoi) citation.doi = filenameDoi;
    }
    return citation;
  } catch (error) {
    if (error instanceof Error && /automatically/.test(error.message)) throw error;
    throw new Error(`Could not read metadata from “${file.name}”: ${errorMessage(error)}`);
  }
}

// ── Pasted-reference parsing (the light version of therightbibtex's parse_input) ──

const LABELED_ISBN_RE = /\bISBN(?:-1[03])?[:\s]*([0-9][0-9Xx\- ]{8,24}[0-9Xx])/i;
const BARE_ISBN13_RE = /\b97[89][\s-]?\d{1,5}[\s-]?\d{1,7}[\s-]?\d{1,7}[\s-]?[\dXx]\b/;
const PASTE_DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/;

export interface ParsedCitationInput {
  isbn?: string;
  doi?: string;
  year?: string;
  /** The text left once identifiers and years are stripped — use as the title query. */
  remainder: string;
}

/** Pull ISBN, DOI and year out of an arbitrary pasted citation or reference string. */
export function parseCitationInput(text: string): ParsedCitationInput {
  let working = text.trim();

  // A filename that IS a DOI with the slash replaced ("10.1515_9783111611358-005").
  const filenameDoi = doiFromFilename(working);
  if (filenameDoi) return { doi: filenameDoi, remainder: '' };

  let isbn: string | undefined;
  const labeled = working.match(LABELED_ISBN_RE);
  const bare = labeled ? null : working.match(BARE_ISBN13_RE);
  const isbnMatch = labeled ?? bare;
  if (isbnMatch) {
    isbn = normalizeIsbnString(isbnMatch[1].replace(/^(?:ISBN(?:-1[03])?[:\s]*)/i, '')) || undefined;
    if (isbn) working = working.replace(isbnMatch[0], ' ');
  }

  let doi: string | undefined;
  const doiMatch = working.match(PASTE_DOI_RE);
  if (doiMatch) {
    doi = normalizeDoiString(doiMatch[1]).replace(/[.,;)]+$/, '');
    working = working.replace(doiMatch[0], ' ');
  }

  let year: string | undefined;
  // Plausible publication years: 1500–2099 (books predate the 20th century).
  const yearMatch = working.match(/\b((?:1[5-9]|20)\d{2})\b/);
  if (yearMatch) {
    year = yearMatch[1];
    working = working.replace(yearMatch[0], ' ');
  }

  return { isbn, doi, year, remainder: working.replace(/\s+/g, ' ').trim() };
}

/** Filenames make poor search queries — turn separators into spaces and drop
 * trailing edition markers ("Calculus_Early_Transcendentals_8th_Edition" →
 * "Calculus Early Transcendentals"). */
export function cleanSearchTitle(title: string): string {
  return title
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s*\b\d+(?:st|nd|rd|th)\s+ed(?:ition)?s?\.?\s*$/i, '')
    .replace(/\s*\bed(?:ition)?s?\.?\s*(?:\d+)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function surnameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim();
  const words = trimmed.split(/\s+/);
  return words[words.length - 1] ?? '';
}

// ── Engine → BookCitation mapping ────────────────────────────────────────────

export const FIELD_LABELS: Record<CitationField, string> = {
  title: 'title',
  authors: 'authors',
  publisher: 'publisher',
  city: 'place',
  year: 'year',
  edition: 'edition',
  isbn: 'ISBN',
  doi: 'DOI',
  language: 'language',
  pageCount: 'pages',
  container: 'venue',
  volume: 'volume',
  issue: 'issue',
  pages: 'pages',
};

const SOURCE_BY_LABEL: Record<string, CitationSourceName> = Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([key, label]) => [label, key as CitationSourceName]),
) as Record<string, CitationSourceName>;

const CONFLICT_FIELD_MAP: Record<string, CitationField> = {
  year: 'year',
  pages: 'pages',
  'number of authors': 'authors',
};

/** Map the engine's merged record onto the persisted citation shape. */
export function mergedToCitation(rec: MergedRef): BookCitation {
  const toDisplay = (a: CitationAuthorName): string => (a.given ? `${a.family}, ${a.given}` : a.family);
  const fieldSources: Partial<Record<CitationField, CitationSourceName>> = {};
  for (const [key, label] of Object.entries(rec.prov ?? {})) {
    const field = key as CitationField;
    const source = SOURCE_BY_LABEL[label];
    if ((CITATION_FIELDS as readonly string[]).includes(key) && source) fieldSources[field] = source;
  }
  const conflicts = (rec.conflicts ?? [])
    .map((c) => CONFLICT_FIELD_MAP[c.field])
    .filter((f): f is CitationField => !!f);

  return {
    title: rec.title,
    authors: rec.authors.map(toDisplay),
    structuredAuthors: rec.authors.length ? rec.authors : undefined,
    publisher: rec.publisher || undefined,
    year: rec.year || undefined,
    isbn: rec.isbn || undefined,
    doi: rec.doi || undefined,
    type: rec.type,
    container: rec.container || undefined,
    containerShort: rec.containerShort || undefined,
    volume: rec.volume || undefined,
    issue: rec.issue || undefined,
    pages: rec.pages || undefined,
    editors: rec.editors.length ? rec.editors.map(toDisplay) : undefined,
    url: rec.url || undefined,
    note: rec.note || undefined,
    confidence: rec.confidence,
    retracted: rec.retracted || undefined,
    source: 'enriched',
    retrievedAt: new Date().toISOString(),
    fieldSources: Object.keys(fieldSources).length ? fieldSources : undefined,
    conflicts: conflicts.length ? [...new Set(conflicts)] : undefined,
  };
}

function entryToResult(en: LookupEntry): EnrichResult {
  if (en.status === 'error' || !en.rec) {
    return { citation: null, applied: false, candidates: en.status === 'choose' ? en.cands.map((c) => mergedToCitation(c.rec)) : [] };
  }
  const citation = mergedToCitation(en.rec);
  const others =
    en.cands.length > 1
      ? en.cands.slice(1).map((c) => mergedToCitation(c.rec))
      : en.versions.filter((_, i) => i !== en.chosen).map((v) => mergedToCitation(v.rec));
  return { citation, applied: true, candidates: [citation, ...others] };
}

export interface EnrichResult {
  /** Pre-applied record — set when the engine's confidence rule accepted a match. */
  citation: BookCitation | null;
  /** True when `citation` is safe to save without user confirmation. */
  applied: boolean;
  /** Best record first, then the engine's alternates (other versions / clusters). */
  candidates: BookCitation[];
}

/**
 * Look a seed up across every applicable source with the reference engine:
 * an ISBN or DOI is asked by identifier, anything else by title (plus the
 * first author's surname). The engine auto-applies only when its own
 * confidence rule accepts the match; otherwise the user picks.
 */
export async function enrichCitation(seed: BookCitation, opts: LookupOptions = {}): Promise<EnrichResult> {
  const isbn = seed.isbn?.trim();
  const doi = seed.doi?.trim();
  const line = isbn || doi || [cleanSearchTitle(seed.title), surnameOf(seed.authors[0] ?? '')].filter(Boolean).join(' ');
  if (!line) return { citation: null, applied: false, candidates: [] };
  const en = await lookupLine(line, opts);
  return entryToResult(en);
}

/** Look up one ISBN across the book sources (Open Library, Google Books, Crossref). */
export async function lookupByIsbn(isbn: string, opts: LookupOptions = {}): Promise<BookCitation | null> {
  const en = await lookupLine(isbn.trim(), opts);
  if (en.kind !== 'isbn' || en.status !== 'ok' || !en.rec) return null;
  return mergedToCitation(en.rec);
}

/** Chip label for a citation: "Merged · N sources" when provenance is mixed, else its single source. */
export function citationSourceLabel(citation: BookCitation): string {
  const sources = new Set(Object.values(citation.fieldSources ?? {}));
  if (sources.size > 1) return `Merged · ${sources.size} sources`;
  const only = [...sources][0];
  return only ? SOURCE_LABELS[only] || only : 'Manual';
}

/** One-line provenance summary, e.g. "Crossref: title, year · File metadata: pages". */
export function provenanceSummary(citation: BookCitation | null): string {
  const fieldSources = citation?.fieldSources;
  if (!fieldSources) return '';
  const groups = new Map<CitationSourceName, string[]>();
  for (const field of CITATION_FIELDS) {
    const source = fieldSources[field];
    if (!source) continue;
    const list = groups.get(source) ?? [];
    list.push(FIELD_LABELS[field]);
    groups.set(source, list);
  }
  return [...groups.entries()].map(([source, fields]) => `${SOURCE_LABELS[source] || source}: ${fields.join(', ')}`).join(' · ');
}
