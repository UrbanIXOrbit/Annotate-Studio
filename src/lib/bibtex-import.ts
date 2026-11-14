/**
 * BibTeX import — the pure layer of Zotero interop: maps parsed BibTeX
 * entries onto the existing BookCitation shape and suggests which library
 * file each entry describes. Pure — no store imports; the similarity helpers
 * are the same ones the online reference lookup uses.
 */
import type { BookCitation, CitationWorkType } from '@/store/books';
import { parseBibtex, type BibtexEntry, type ParseResult } from './bibtex.ts';
import { doiFromFilename, fallbackTitleFromFile } from './book-citations.ts';
import { titleSimilarity } from './reference-lookup.ts';

export type { BibtexEntry, ParseResult };

/** BibTeX entry type → the work types the citation formatters know. */
const TYPE_MAP: Record<string, CitationWorkType> = {
  article: 'article',
  book: 'book',
  booklet: 'book',
  manual: 'book',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'conference',
  conference: 'conference',
  proceedings: 'conference',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  magisterthesis: 'thesis',
  techreport: 'other',
  unpublished: 'preprint',
  online: 'preprint',
};

/** Split a BibTeX name list on ` and `, but never inside braces. */
export function splitBibtexNames(value: string): string[] {
  const names: string[] = [];
  let current = '';
  let depth = 0;
  const push = () => {
    const name = current.trim();
    if (name) names.push(name);
    current = '';
  };
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(char) && /^and[\s{]/i.test(value.slice(i + 1))) {
      push();
      i += 3; // skip "and"
      continue;
    }
    current += char;
  }
  push();
  return names;
}

/** `12--30` / `12-30` → `12–30` (en dash), the format citation styles expect. */
function normalizePages(value: string): string {
  return value.replace(/\s*-{2,}\s*|\s+-\s+/g, '–').trim();
}

/** Map one parsed BibTeX entry onto the app's citation record. */
export function bibtexToCitation(entry: BibtexEntry): BookCitation {
  const f = entry.fields;
  const authors = splitBibtexNames(f.author ?? '');
  const editors = splitBibtexNames(f.editor ?? '');
  const citation: BookCitation = {
    title: f.title || entry.key,
    authors,
    source: 'manual',
    retrievedAt: new Date().toISOString(),
    confidence: 'medium',
  };
  const optional: Partial<BookCitation> = {
    // Zotero's BibTeX export writes `year`; the biblatex flavour writes `date`.
    ...(f.year || /(?:19|20)\d{2}/.test(f.date ?? '')
      ? { year: f.year || /(?:19|20)\d{2}/.exec(f.date ?? '')![0] }
      : {}),
    ...(f.publisher || f.school || f.institution || f.organization
      ? { publisher: f.publisher || f.school || f.institution || f.organization }
      : {}),
    ...(f.address || f.location ? { city: f.address || f.location } : {}),
    ...(f.journal || f.journaltitle || f.booktitle
      ? { container: f.journal || f.journaltitle || f.booktitle }
      : {}),
    ...(f.volume ? { volume: f.volume } : {}),
    ...(f.number ? { issue: f.number } : {}),
    ...(f.pages ? { pages: normalizePages(f.pages) } : {}),
    ...(f.edition ? { edition: f.edition } : {}),
    ...(f.isbn || f.issn ? { isbn: f.isbn || f.issn } : {}),
    ...(f.doi ? { doi: f.doi } : {}),
    ...(f.url ? { url: f.url } : {}),
    ...(f.language ? { language: f.language } : {}),
    ...(f.note ? { note: f.note } : {}),
    ...(editors.length > 0 ? { editors } : {}),
    type: TYPE_MAP[entry.type] ?? 'other',
  };
  return { ...citation, ...optional };
}

/** Zotero keywords, as proposed tags for the matched file. */
export function keywordsOf(entry: BibtexEntry): string[] {
  const raw = entry.fields.keywords ?? '';
  return raw
    .split(/[,;]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= 40);
}

/* ---------- Matching ---------- */

/** The file view the matcher needs (BookFile-shaped, citation optional). */
export interface MatchFile {
  id: string;
  name: string;
  displayName?: string | null;
  /** Saved citation DOI, when the file already carries one. */
  doi?: string | null;
  /** Saved citation year, when known. */
  year?: string | null;
  /** Whether the file already has a citation (affects the review UI). */
  hasCitation?: boolean;
}

export interface MatchCandidate {
  fileId: string;
  score: number;
  reason: 'doi' | 'title';
  /** Both sides state a year and they disagree — never auto-apply. */
  yearConflict?: boolean;
}

export interface MatchSuggestion {
  entry: BibtexEntry;
  citation: BookCitation;
  keywords: string[];
  candidates: MatchCandidate[];
  /** auto: apply without asking; suggested: plausible, confirm; none: no file. */
  confidence: 'auto' | 'suggested' | 'none';
}

const AUTO_THRESHOLD = 0.88;
const SUGGESTED_THRESHOLD = 0.72;
/** Two candidates this close are ambiguous — never auto-assign. */
const AMBIGUITY_MARGIN = 0.04;

/** Meaningful-token overlap, order-independent (filenames reorder titles). */
function tokenScore(a: string, b: string): number {
  const stop = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'and', 'or', 'to', 'for', 'with', 'at', 'by']);
  const tokensOf = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((token) => token.length > 1 && !stop.has(token));
  const ta = tokensOf(a);
  if (ta.length === 0) return 0;
  const sb = new Set(tokensOf(b));
  return ta.filter((token) => sb.has(token)).length / ta.length;
}

/** First 4-digit year in a filename-derived title ("… (2012)"). */
function yearInFilename(name: string): string | undefined {
  const match = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(name);
  return match ? match[1] : undefined;
}

function surnameOf(name: string): string {
  const first = name.split(',')[0] ?? name;
  return first.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function similarity(a: string, b: string): number {
  return Math.max(titleSimilarity(a, b), tokenScore(a, b));
}

/** Score every file against one entry's title/authors/DOI/year. */
function candidatesFor(entry: BibtexEntry, files: MatchFile[]): MatchCandidate[] {
  const entryDoi = entry.fields.doi?.toLowerCase();
  const entryYear = entry.fields.year;
  const entryTitle = entry.fields.title || '';
  const surnames = splitBibtexNames(entry.fields.author ?? '').map(surnameOf).filter(Boolean);
  const candidates: MatchCandidate[] = [];
  for (const file of files) {
    const fileTitle = file.displayName || fallbackTitleFromFile(file.name);
    const rawTitle = fallbackTitleFromFile(file.name);
    const fileYear = file.year ?? yearInFilename(file.name);
    const fileDoi = file.doi?.toLowerCase() ?? doiFromFilename(file.name)?.toLowerCase();

    if (entryDoi && fileDoi && entryDoi === fileDoi) {
      candidates.push({ fileId: file.id, score: 1, reason: 'doi' });
      continue;
    }

    const sim = Math.max(similarity(entryTitle, fileTitle), entryTitle === fileTitle ? 1 : similarity(entryTitle, rawTitle));
    if (sim < SUGGESTED_THRESHOLD) continue;
    let score = sim;
    // Year agreement separates same-topic papers; disagreement is a real signal.
    const yearConflict = Boolean(entryYear && fileYear && entryYear !== fileYear);
    if (entryYear && fileYear) score += yearConflict ? -0.15 : 0.05;
    if (surnames.length > 0 && surnames.some((surname) => rawTitle.includes(surname))) score += 0.03;
    candidates.push({ fileId: file.id, score: Math.min(1, score), reason: 'title', ...(yearConflict ? { yearConflict } : {}) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

/** Match every entry against the files, with confidence tiers. */
export function matchEntries(entries: BibtexEntry[], files: MatchFile[]): MatchSuggestion[] {
  return entries.map((entry) => {
    const candidates = candidatesFor(entry, files);
    let confidence: MatchSuggestion['confidence'] = 'none';
    if (candidates.length > 0) {
      const top = candidates[0];
      const rival = candidates[1];
      const clearWinner = !rival || top.score - rival.score >= AMBIGUITY_MARGIN;
      const doiCertain = top.reason === 'doi';
      if (doiCertain || (top.score >= AUTO_THRESHOLD && clearWinner && !top.yearConflict)) confidence = 'auto';
      else if (top.score >= SUGGESTED_THRESHOLD) confidence = 'suggested';
      // An ambiguous strong pair stays 'suggested' even above the threshold.
    }
    return { entry, citation: bibtexToCitation(entry), keywords: keywordsOf(entry), candidates, confidence };
  });
}
