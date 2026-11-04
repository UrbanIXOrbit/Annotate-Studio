import type { BookCitation, BookFile, CitationAuthorName, CitationField, CitationSourceName } from '@/store/books';
import type { CitationStyle } from './citation-formats.ts';
import { CITATION_FIELDS } from './citation-schema.ts';
import { getPdfEngine } from './pdf-engine.ts';
import { readExternalFileBytes, readFileBytes, errorMessage } from './tauri-commands.ts';
import { uid } from './utils.ts';
import {
  isbn13,
  lookupLine,
  retryFailedSources,
  type LookupEntry,
  type LookupOptions,
  type MergedRef,
  SOURCE_LABELS,
  type SourceProgress,
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

const EBOOK_MIME: Record<string, string> = {
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook',
  prc: 'application/x-mobipocket-ebook',
  fb2: 'application/x-fictionbook+xml',
  fbz: 'application/x-zip-compressed-fb2',
  cbz: 'application/vnd.comicbook+zip',
};

/**
 * foliate-js picks its parser from `file.name` and `file.type` (`name.endsWith('.cbz')`…),
 * so it must be given a named File — a bare Blob has no name and makeBook throws
 * "Cannot read properties of undefined (reading 'endsWith')".
 */
export function ebookFile(bytes: Uint8Array, name: string, extension: string): File {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return new File([bytes as BlobPart], name || `book.${ext}`, { type: EBOOK_MIME[ext] ?? '' });
}

async function extractEbookCitation(bytes: Uint8Array, file: BookFile): Promise<BookCitation> {
  const { makeBook } = await import('foliate-js/view.js');
  const book = await makeBook(ebookFile(bytes, file.name, file.extension));
  const meta = (book.metadata ?? {}) as RawMeta;

  const rawTitle = flattenString(meta.title);
  // Comic archives report their own filename as the title — "comic.cbz" is not one.
  const title = rawTitle && rawTitle !== file.name ? rawTitle : fallbackTitleFromFile(file.name);
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

/**
 * The engine names its sources with plain keys ("googlebooks"); saved
 * citations use the schema's names ("google-books"). Everything else matches.
 */
export function toSchemaSource(engineKey: string): CitationSourceName {
  return (engineKey === 'googlebooks' ? 'google-books' : engineKey) as CitationSourceName;
}

/** Human label for a schema source name, covering the file/manual pseudo-sources too. */
export function sourceDisplayName(name: string): string {
  if (name === 'google-books') return SOURCE_LABELS.googlebooks;
  return SOURCE_LABELS[name] || name;
}

const SOURCE_BY_LABEL: Record<string, CitationSourceName> = Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([key, label]) => [label, toSchemaSource(key)]),
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
    edition: rec.edition || undefined,
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
  const progress = en.progress;
  if (en.status === 'error' || !en.rec) {
    return {
      citation: null,
      applied: false,
      candidates: en.status === 'choose' ? en.cands.map((c) => mergedToCitation(c.rec)) : [],
      progress,
      error: en.status === 'error' ? en.error : undefined,
      entry: en,
    };
  }
  const citation = mergedToCitation(en.rec);
  const others =
    en.cands.length > 1
      ? en.cands.slice(1).map((c) => mergedToCitation(c.rec))
      : en.versions.filter((_, i) => i !== en.chosen).map((v) => mergedToCitation(v.rec));
  return { citation, applied: true, candidates: [citation, ...others], progress, entry: en };
}

/**
 * Ask again only the sources that failed (rate-limited, timed out, refused) and merge
 * their answers with what the others already returned.
 */
export async function retryFailedEnrichment(entry: LookupEntry, opts: LookupOptions = {}): Promise<EnrichResult> {
  return entryToResult(await retryFailedSources(entry, opts));
}

export interface EnrichResult {
  /** Pre-applied record — set when the engine's confidence rule accepted a match. */
  citation: BookCitation | null;
  /** True when `citation` is safe to save without user confirmation. */
  applied: boolean;
  /** Best record first, then the engine's alternates (other versions / clusters). */
  candidates: BookCitation[];
  /** How each source answered (found / no record / error) — shown so a failing source is visible */
  progress?: Record<string, SourceProgress>;
  /** The engine's reason when nothing usable came back (all sources failed, no close match…) */
  error?: string;
  /** The finished lookup, kept so the sources that failed can be asked again without redoing the rest */
  entry?: LookupEntry;
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

const COMPARED_FIELDS: CitationField[] = ['title', 'authors', 'publisher', 'year', 'edition', 'isbn', 'doi', 'container', 'volume', 'issue', 'pages'];

function comparable(citation: BookCitation, field: CitationField): string {
  const raw = field === 'authors' ? citation.authors.join('|') : String(citation[field] ?? '');
  return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim();
}

/**
 * Which fields would change if `candidate` replaced `current` — the quick answer to
 * "is this record actually different from what I saved?". Fields only the file
 * knows about (page count, language) are not compared.
 */
export function diffCitationFields(current: BookCitation | null | undefined, candidate: BookCitation): CitationField[] {
  if (!current) return [];
  return COMPARED_FIELDS.filter((field) => comparable(current, field) !== comparable(candidate, field));
}

/** Chip label for a citation: "Merged · N sources" when provenance is mixed, else its single source. */
export function citationSourceLabel(citation: BookCitation): string {
  const sources = new Set(Object.values(citation.fieldSources ?? {}));
  if (sources.size > 1) return `Merged · ${sources.size} sources`;
  const only = [...sources][0];
  return only ? sourceDisplayName(only) : 'Manual';
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
  return [...groups.entries()].map(([source, fields]) => `${sourceDisplayName(source)}: ${fields.join(', ')}`).join(' · ');
}

/* ---------- Field checks (shown inline while editing) ---------- */

/** ISBN-10 or ISBN-13 with a correct check digit; hyphens and spaces are ignored. */
export function isValidIsbn(value: string): boolean {
  const c = value.replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(c)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(c[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(c)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (c[i] === 'X' ? 10 : Number(c[i])) * (10 - i);
    return sum % 11 === 0;
  }
  return false;
}

/** A DOI, bare or as a doi.org link. */
export function isValidDoi(value: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''));
}

/** A short, plain-language problem with a field's value, or null when it looks right (or is empty). */
export function validateCitationField(field: 'isbn' | 'doi' | 'year', value: string, now = new Date()): string | null {
  const v = value.trim();
  if (!v) return null;
  if (field === 'isbn') {
    const digits = v.replace(/[\s-]/g, '');
    if (!/^[\dXx]{10}$|^\d{13}$/.test(digits)) return 'An ISBN has 10 or 13 digits.';
    return isValidIsbn(v) ? null : 'The check digit does not match — look for a typing mistake.';
  }
  if (field === 'doi') return isValidDoi(v) ? null : 'A DOI looks like 10.1234/abc — it starts with 10.';
  if (/^n\.?d\.?$/i.test(v)) return null;
  const year = Number(v);
  return /^\d{4}$/.test(v) && year >= 1000 && year <= now.getFullYear() + 1 ? null : 'Use a four-digit year.';
}

/* ---------- Is the reference complete for the chosen style? ---------- */

export interface CitationGap {
  field: 'title' | 'authors' | 'year' | 'publisher' | 'container' | 'volume' | 'pages' | 'doi' | 'editors';
  label: string;
  /** Required gaps leave a visibly incomplete reference; the others are "usually expected". */
  required: boolean;
}

const GAP_LABELS: Record<CitationGap['field'], string> = {
  title: 'title',
  authors: 'author',
  year: 'year',
  publisher: 'publisher',
  container: 'journal or book title',
  volume: 'volume',
  pages: 'pages',
  doi: 'DOI',
  editors: 'editors',
};

/**
 * What a reference in this style would be missing. Books need a publisher; articles a journal,
 * volume and pages; chapters a book title and editors. A DOI is expected by the author-date styles.
 */
export function citationGaps(c: BookCitation, style: CitationStyle): CitationGap[] {
  const kind = c.type ?? (c.container ? 'article' : 'book');
  const gaps: CitationGap[] = [];
  const need = (field: CitationGap['field'], present: unknown, required: boolean) => {
    const has = Array.isArray(present) ? present.length > 0 : !!String(present ?? '').trim();
    if (!has) gaps.push({ field, label: GAP_LABELS[field], required });
  };
  need('title', c.title, true);
  need('authors', c.authors, true);
  need('year', c.year, true);
  if (kind === 'book' || kind === 'thesis') need('publisher', c.publisher, true);
  if (kind === 'article') {
    need('container', c.container, true);
    need('volume', c.volume, false);
    need('pages', c.pages, false);
  }
  if (kind === 'conference') {
    need('container', c.container, true);
    need('pages', c.pages, false);
  }
  if (kind === 'chapter') {
    need('container', c.container, true);
    need('publisher', c.publisher, true);
    need('pages', c.pages, false);
    if (style !== 'vancouver') need('editors', c.editors, false);
  }
  if ((kind === 'article' || kind === 'preprint') && ['apa', 'harvard', 'chicago'].includes(style)) need('doi', c.doi, false);
  return gaps.sort((a, b) => Number(b.required) - Number(a.required));
}

/* ---------- Needs review? ---------- */

export interface CitationReview {
  state: 'missing' | 'matched' | 'review';
  reasons: string[];
}

/** Whether a saved citation can be trusted as it is, and if not, why not (for the batch dialog). */
export function citationReview(c: BookCitation | null | undefined): CitationReview {
  if (!c) return { state: 'missing', reasons: [] };
  const reasons: string[] = [];
  if (c.retracted) reasons.push('A source marks it as retracted');
  if ((c.conflicts ?? []).length) reasons.push(`Sources disagree on ${(c.conflicts ?? []).map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}`);
  if (c.source === 'embedded') reasons.push('Only the file’s own metadata — not checked online');
  if (c.source === 'enriched' && c.confidence === 'low') reasons.push('Only one independent source confirms it');
  const required = citationGaps(c, 'apa').filter((g) => g.required).map((g) => g.label);
  if (required.length) reasons.push(`Missing ${required.join(', ')}`);
  return { state: reasons.length ? 'review' : 'matched', reasons };
}

/* ---------- Duplicates ---------- */

const normaliseForKey = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Identifiers that make two citations "the same book": an ISBN (10 and 13 compare equal) or a DOI.
 * Without either, the same title, first author and year count.
 */
export function duplicateKeys(c: BookCitation | null | undefined): string[] {
  if (!c) return [];
  const keys: string[] = [];
  const isbn = c.isbn ? isbn13(c.isbn) : '';
  if (isbn) keys.push(`isbn:${isbn}`);
  const doi = (c.doi ?? '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
  if (doi) keys.push(`doi:${doi}`);
  if (!keys.length && c.title.trim()) {
    keys.push(`work:${normaliseForKey(c.title)}|${normaliseForKey((c.authors[0] ?? '').split(',')[0])}|${c.year ?? ''}`);
  }
  return keys;
}

/**
 * Which files duplicate an earlier file in the list. `of` maps a file to the first file it repeats;
 * `groups` lists each set of repeats, original first.
 */
export function findDuplicates(files: { id: string; citation?: BookCitation | null }[]): { of: Map<string, string>; groups: string[][] } {
  const seen = new Map<string, string>();
  const of = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const file of files) {
    for (const key of duplicateKeys(file.citation)) {
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, file.id);
        continue;
      }
      if (first === file.id) continue;
      if (!of.has(file.id)) of.set(file.id, first);
      const group = groups.get(first) ?? [first];
      if (!group.includes(file.id)) group.push(file.id);
      groups.set(first, group);
    }
  }
  return { of, groups: [...groups.values()] };
}

/** The other file already holding this citation, if any — used to warn before saving a repeat. */
export function findDuplicateOf(
  files: Record<string, BookFile>,
  citation: BookCitation,
  excludeId: string | null,
): BookFile | null {
  const keys = new Set(duplicateKeys(citation));
  if (!keys.size) return null;
  for (const file of Object.values(files)) {
    if (file.id === excludeId || !file.citation) continue;
    if (duplicateKeys(file.citation).some((k) => keys.has(k))) return file;
  }
  return null;
}
