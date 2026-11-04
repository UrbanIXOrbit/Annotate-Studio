import type { BookCitation, CitationAuthorName } from '@/store/books';

/**
 * Citation formatting — a port of reference-lookup2.html's formatters (the
 * therightbibtex method's output layer): APA 7, Harvard, MLA 9, Chicago
 * author-date and Vancouver, plus BibTeX/RIS/CSL-JSON for reference managers.
 * Plain-text output; works for articles, chapters, conference papers and books.
 */

export type CitationStyle = 'apa' | 'harvard' | 'mla' | 'chicago' | 'vancouver';

export const CITATION_STYLES: { id: CitationStyle; label: string }[] = [
  { id: 'apa', label: 'APA 7' },
  { id: 'harvard', label: 'Harvard' },
  { id: 'mla', label: 'MLA 9' },
  { id: 'chicago', label: 'Chicago (author-date)' },
  { id: 'vancouver', label: 'Vancouver' },
];

export type ExportFormat = 'txt' | 'bib' | 'ris' | 'json';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; extension: string; mime: string }[] = [
  { id: 'txt', label: 'Formatted citations (.txt)', extension: 'txt', mime: 'text/plain' },
  { id: 'bib', label: 'BibTeX (.bib)', extension: 'bib', mime: 'application/x-bibtex' },
  { id: 'ris', label: 'RIS (.ris)', extension: 'ris', mime: 'application/x-research-info-systems' },
  { id: 'json', label: 'CSL JSON (.json)', extension: 'json', mime: 'application/json' },
];

export interface SplitAuthor {
  family: string;
  given: string;
}

/**
 * Split a display name into family/given. "Tolstoy, Leo" is unambiguous;
 * "Leo Tolstoy" assumes the last word is the family name. Compound particles
 * (van, von, de, …) stay with the family name.
 */
export function splitAuthor(name: string): SplitAuthor {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) return { family: '', given: '' };
  if (trimmed.includes(',')) {
    const [family = '', ...rest] = trimmed.split(',');
    return { family: family.trim(), given: rest.join(',').trim() };
  }
  const words = trimmed.split(' ');
  const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'bin', 'al', 'el', 'ter', 'ten']);
  let cut = words.length - 1;
  while (cut > 0 && PARTICLES.has(words[cut - 1].toLowerCase())) cut -= 1;
  return { family: words.slice(cut).join(' '), given: words.slice(0, cut).join(' ') };
}

/* ---------- Record helpers (ported) ---------- */

/**
 * Italics are carried through the formatters as private-use marks (\uE000 … \uE001)
 * so one set of formatters yields both the plain-text reference and the rich one
 * (journal and book titles in italics) used when copying into Word or Docs.
 */
const IT0 = '\uE000';
const IT1 = '\uE001';
const I = (s: string | undefined) => (s ? `${IT0}${s}${IT1}` : '');
const stripMarks = (s: string) => s.replace(/[\uE000\uE001]/g, '');

const end = (s: string) => (/[.?!]\uE001?[”"’']?$/.test(s) ? s : s + '.');
const pg = (p: string) => String(p).replace(/\s*[-–—]+\s*/g, '–');
const pgV = (p: string) => String(p).replace(/\s*[-–—]+\s*/g, '-');
const isRange = (p: string) => /[-–—]/.test(p);
const ord = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const edOrd = (x: string) => (/^\d+$/.test(String(x)) ? ord(Number(x)) : String(x));
const doiUrl = (c: BookCitation) => (c.doi ? `https://doi.org/${c.doi}` : '');
const contOf = (c: BookCitation) => c.container || (c.type === 'preprint' ? c.publisher ?? '' : '');

function kindOf(c: BookCitation): 'article' | 'chapter' | 'book' {
  if ((c.type === 'chapter' || c.type === 'conference') && c.container) return 'chapter';
  if (c.type === 'book' || c.type === 'thesis') return 'book';
  return c.container || ['article', 'preprint', 'conference'].includes(c.type ?? '') ? 'article' : 'book';
}

function structuredOf(c: BookCitation): CitationAuthorName[] {
  if (c.structuredAuthors?.length) return c.structuredAuthors;
  return c.authors.map((name) => {
    const { family, given } = splitAuthor(name);
    return { family, given };
  });
}

function editorsOf(c: BookCitation): CitationAuthorName[] {
  return (c.editors ?? []).map((name) => {
    const { family, given } = splitAuthor(name);
    return { family, given };
  });
}

function initials(given: string): string {
  return String(given)
    .replace(/\./g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split('-').filter(Boolean).map((x) => x[0].toUpperCase() + '.').join('-'))
    .join(' ');
}
const initialsPlain = (g: string) => initials(g).replace(/[.\s-]/g, '');
const first = (x: CitationAuthorName) => (x.given ? `${x.family}, ${x.given}` : x.family);
const nat = (x: CitationAuthorName) => (x.given ? `${x.given} ${x.family}` : x.family);

/* ---------- APA 7 (ported) ---------- */

function apaAuthors(a: CitationAuthorName[]): string {
  const n = a.map((x) => (x.given ? `${x.family}, ${initials(x.given)}` : x.family));
  if (n.length <= 1) return n[0] || '';
  if (n.length <= 20) return `${n.slice(0, -1).join(', ')}, & ${n[n.length - 1]}`;
  return `${n.slice(0, 19).join(', ')}, . . . ${n[n.length - 1]}`;
}
function apaEditors(a: CitationAuthorName[]): string {
  const n = a.map((x) => (x.given ? `${initials(x.given)} ${x.family}` : x.family));
  return n.length < 3 ? n.join(' & ') : `${n.slice(0, -1).join(', ')}, & ${n[n.length - 1]}`;
}
function fmtAPA(c: BookCitation): string {
  const k = kindOf(c);
  const t = c.title || 'Untitled';
  const A = apaAuthors(structuredOf(c));
  const yr = `(${c.year || 'n.d.'})`;
  const doi = doiUrl(c);
  const head = (th: string): string[] => (A ? [end(A), `${yr}.`, end(th)] : [end(th), `${yr}.`]);
  let out: string[];
  if (k === 'article') {
    let src = I(contOf(c));
    if (c.volume) src += `${src ? ', ' : ''}${I(c.volume)}${c.issue ? `(${c.issue})` : ''}`;
    if (c.pages) src += `${src ? ', ' : ''}${pg(c.pages)}`;
    out = [...head(t), src ? `${src}.` : '', doi];
  } else if (k === 'chapter') {
    const eds = editorsOf(c);
    const ed = eds.length ? `${apaEditors(eds)} (${eds.length > 1 ? 'Eds.' : 'Ed.'}), ` : '';
    out = [...head(t), `In ${ed}${I(contOf(c))}${c.pages ? ` (pp. ${pg(c.pages)})` : ''}.`, c.publisher ? end(c.publisher) : '', doi];
  } else {
    out = [...head(`${I(t)}${c.edition ? ` (${edOrd(c.edition)} ed.)` : ''}`), c.publisher ? end(c.publisher) : '', doi];
  }
  return out.filter(Boolean).join(' ');
}

/* ---------- Harvard (Cite Them Right, ported) ---------- */

function harvAuthors(a: CitationAuthorName[]): string {
  const n = a.map((x) => (x.given ? `${x.family}, ${initials(x.given).replace(/\s/g, '')}` : x.family));
  if (!n.length) return '';
  if (n.length >= 4) return `${n[0]} et al.`;
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}
function fmtHarvard(c: BookCitation): string {
  const k = kindOf(c);
  const A = harvAuthors(structuredOf(c));
  const yr = `(${c.year || 'n.d.'})`;
  const t = c.title || 'Untitled';
  const lead = A ? `${A} ${yr}` : `${t} ${yr}`;
  let s: string;
  if (k === 'article') {
    const bits: string[] = [];
    if (contOf(c)) bits.push(I(contOf(c)));
    if (c.volume) bits.push(`${c.volume}${c.issue ? `(${c.issue})` : ''}`);
    if (c.pages) bits.push(`${isRange(c.pages) ? 'pp.' : 'p.'} ${pg(c.pages)}`);
    s = `${lead}${A ? ` ‘${t}’` : ''}${bits.length ? `, ${bits.join(', ')}` : ''}.`;
  } else if (k === 'chapter') {
    const eds = editorsOf(c);
    const ed = eds.length ? `${harvAuthors(eds)} (${eds.length > 1 ? 'eds' : 'ed.'}) ` : '';
    s = `${lead}${A ? ` ‘${t}’` : ''}, in ${ed}${I(contOf(c))}.${c.publisher ? ` ${c.publisher}` : ''}${c.pages ? `${c.publisher ? ',' : ''} ${isRange(c.pages) ? 'pp.' : 'p.'} ${pg(c.pages)}` : ''}${c.publisher || c.pages ? '.' : ''}`;
  } else {
    s = `${lead}${A ? ` ${I(t)}` : ''}.${c.edition ? ` ${edOrd(c.edition)} edn.` : ''}${c.publisher ? ` ${end(c.publisher)}` : ''}`;
  }
  const doi = doiUrl(c);
  return doi ? `${s} ${doi}` : s;
}

/* ---------- MLA 9 (ported) ---------- */

function mlaNames(a: CitationAuthorName[]): string {
  if (!a.length) return '';
  if (a.length === 1) return first(a[0]);
  if (a.length === 2) return `${first(a[0])}, and ${nat(a[1])}`;
  return `${first(a[0])}, et al.`;
}
function mlaEditors(a: CitationAuthorName[]): string {
  if (a.length < 3) return a.map(nat).join(' and ');
  return `${nat(a[0])} et al.`;
}
function fmtMLA(c: BookCitation): string {
  const k = kindOf(c);
  const A = mlaNames(structuredOf(c));
  const tr = c.title || 'Untitled';
  const doi = doiUrl(c);
  const T = `“${tr}${/[.?!]$/.test(tr) ? '' : '.'}”`;
  const au = A ? `${end(A)} ` : '';
  const yr = c.year || 'n.d.';
  const tail = (a: (string | false | undefined)[]) => a.filter(Boolean).join(', ') + '.';
  const pp = c.pages ? `${isRange(c.pages) ? 'pp.' : 'p.'} ${pg(c.pages)}` : '';
  if (k === 'article') {
    return `${au}${T} ${tail([I(contOf(c)), c.volume && `vol. ${c.volume}`, c.issue && `no. ${c.issue}`, yr, pp, doi])}`;
  }
  if (k === 'chapter') {
    const eds = editorsOf(c);
    return `${au}${T} ${tail([I(contOf(c)), eds.length > 0 && `edited by ${mlaEditors(eds)}`, c.publisher, yr, pp, doi])}`;
  }
  return `${au}${end(I(tr))} ${tail([c.edition && `${edOrd(c.edition)} ed.`, c.publisher, yr, doi])}`;
}

/* ---------- Chicago author-date (ported) ---------- */

function chiNames(a: CitationAuthorName[], limit = 10): string {
  if (!a.length) return '';
  if (a.length === 1) return first(a[0]);
  const list = a.length > limit ? a.slice(0, 7) : a;
  const n = list.map((x, i) => (i === 0 ? first(x) : nat(x)));
  if (a.length > limit) return `${n.join(', ')}, et al.`;
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n.slice(0, -1).join(', ')}, and ${n[n.length - 1]}`;
}
function chiEditors(a: CitationAuthorName[]): string {
  const n = a.map(nat);
  if (n.length < 3) return n.join(' and ');
  return `${n.slice(0, -1).join(', ')}, and ${n[n.length - 1]}`;
}
function fmtChicago(c: BookCitation): string {
  const k = kindOf(c);
  const A = chiNames(structuredOf(c));
  const tr = c.title || 'Untitled';
  const yr = c.year || 'n.d.';
  const doi = doiUrl(c);
  const T = `“${tr}${/[.?!]$/.test(tr) ? '' : '.'}”`;
  const lead = (title: string) => (A ? [end(A), `${yr}.`, title] : [title, `${yr}.`]);
  let out: string[];
  if (k === 'article') {
    let src = I(contOf(c));
    if (c.volume) src += `${src ? ' ' : ''}${c.volume}${c.issue ? ` (${c.issue})` : ''}`;
    if (c.pages) src += `${src ? ': ' : ''}${pg(c.pages)}`;
    out = [...lead(T), src ? `${src}.` : '', doi];
  } else if (k === 'chapter') {
    const eds = editorsOf(c);
    out = [...lead(T), `In ${I(contOf(c))}${eds.length ? `, edited by ${chiEditors(eds)}` : ''}${c.pages ? `, ${pg(c.pages)}` : ''}.`, c.publisher ? end(c.publisher) : '', doi];
  } else {
    out = [...lead(end(I(tr)) + (c.edition ? ` ${edOrd(c.edition)} ed.` : '')), c.publisher ? end(c.publisher) : '', doi];
  }
  return out.filter(Boolean).join(' ');
}

/* ---------- Vancouver (ported) ---------- */

function vanAuthors(a: CitationAuthorName[]): string {
  const n = a.map((x) => (x.given ? `${x.family} ${initialsPlain(x.given)}` : x.family));
  return n.length > 6 ? `${n.slice(0, 6).join(', ')}, et al` : n.join(', ');
}
function fmtVancouver(c: BookCitation): string {
  const k = kindOf(c);
  const A = vanAuthors(structuredOf(c));
  const t = c.title || 'Untitled';
  const yr = c.year || '';
  const doi = c.doi ? `doi:${c.doi}` : '';
  const au = A ? end(A) : '';
  let out: string[];
  if (k === 'article') {
    const j = c.containerShort || contOf(c);
    let ref = (j ? `${end(j)} ` : '') + yr;
    if (c.volume) ref += `;${c.volume}${c.issue ? `(${c.issue})` : ''}`;
    if (c.pages) ref += `:${pgV(c.pages)}`;
    out = [au, end(t), `${ref}.`, doi];
  } else if (k === 'chapter') {
    const eds = editorsOf(c);
    const ed = eds.length ? `In: ${vanAuthors(eds)}, editors. ` : 'In: ';
    out = [au, end(t), `${ed}${end(contOf(c))}`, `${c.publisher ? `${c.publisher}; ` : ''}${yr}.${c.pages ? ` p. ${pgV(c.pages)}.` : ''}`, doi];
  } else {
    out = [au, end(t), c.edition ? `${edOrd(c.edition)} ed.` : '', `${c.publisher ? `${c.publisher}; ` : ''}${yr}.`, doi];
  }
  return out.filter(Boolean).join(' ');
}

const FORMATTERS: Record<CitationStyle, (c: BookCitation) => string> = {
  apa: fmtAPA,
  harvard: fmtHarvard,
  mla: fmtMLA,
  chicago: fmtChicago,
  vancouver: fmtVancouver,
};

function styled(style: CitationStyle, c: BookCitation): string {
  return FORMATTERS[style](c).replace(/\s+/g, ' ').trim();
}

/** Render a citation as a plain-text reference in the chosen style. */
export function formatCitation(style: CitationStyle, c: BookCitation): string {
  return stripMarks(styled(style, c));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

/** The same reference with journal and book titles in <i> — safe HTML (everything else is escaped). */
export function formatCitationHtml(style: CitationStyle, c: BookCitation): string {
  return escapeHtml(styled(style, c)).replace(/\uE000/g, '<i>').replace(/\uE001/g, '</i>');
}

/**
 * A bibliography as clipboard content: hanging-indent paragraphs (what Word and
 * Docs expect for reference lists) plus a plain-text twin. Vancouver is numbered
 * in the order given; the other styles are expected to arrive already sorted.
 */
export function renderBibliographyRich(citations: BookCitation[], style: CitationStyle): { html: string; text: string } {
  const numbered = style === 'vancouver';
  const html = citations
    .map((c, i) => {
      const body = formatCitationHtml(style, c);
      const para = numbered ? `${i + 1}. ${body}` : body;
      return `<p style="margin:0 0 8pt 36pt;text-indent:-36pt;font-family:'Times New Roman',serif;font-size:12pt">${para}</p>`;
    })
    .join('');
  const text = citations.map((c, i) => (numbered ? `${i + 1}. ` : '') + formatCitation(style, c)).join('\n\n');
  return { html, text };
}

/* ---------- BibTeX (ported) ---------- */

function bibEsc(s: unknown): string {
  return String(s ?? '').replace(/([&%#_$])/g, '\\$1');
}

const BIB_STOP = new Set(['this', 'that', 'with', 'from', 'what', 'their', 'using', 'about']);

/** BibTeX citation key, e.g. "vaswani2017attention" — first author family + year + first significant word. */
export function bibtexKey(c: BookCitation): string {
  const authors = structuredOf(c);
  const fam = (authors[0]?.family || 'anon')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase();
  const w =
    (c.title || '')
      .toLowerCase()
      .split(/\s+/)
      .map((x) => x.replace(/[^a-z]/g, ''))
      .find((x) => x.length >= 4 && !BIB_STOP.has(x)) || '';
  return `${fam}${c.year ?? ''}${w}`;
}

/** One work as a BibTeX entry. */
export function toBibtex(c: BookCitation, key?: string): string {
  const k = kindOf(c);
  const type = c.type === 'conference' ? 'inproceedings' : k === 'chapter' ? 'incollection' : k === 'article' ? (c.type === 'preprint' ? 'misc' : 'article') : 'book';
  const f: string[] = [];
  const add = (n: string, v: string | number | undefined) => {
    if (v !== undefined && v !== null && v !== '') f.push(`  ${n} = {${v}}`);
  };
  const names = (a: CitationAuthorName[]) =>
    a.map((x) => (x.given ? `${bibEsc(x.family)}, ${bibEsc(x.given)}` : `{${bibEsc(x.family)}}`)).join(' and ');
  const authors = structuredOf(c);
  if (authors.length) add('author', names(authors));
  const eds = editorsOf(c);
  if (eds.length) add('editor', names(eds));
  // Doubled braces keep the title's capitalization — BibTeX styles downcase titles by default.
  add('title', `{${bibEsc(c.title)}}`);
  if (type === 'article') add('journal', bibEsc(contOf(c)));
  else if (type === 'incollection' || type === 'inproceedings') add('booktitle', bibEsc(contOf(c)));
  else if (type === 'misc') add('howpublished', bibEsc(contOf(c)));
  add('year', c.year);
  add('volume', bibEsc(c.volume));
  add('number', bibEsc(c.issue));
  add('pages', c.pages ? String(c.pages).replace(/\s*[-–—]+\s*/g, '--') : undefined);
  add('publisher', bibEsc(c.publisher));
  add('edition', bibEsc(c.edition));
  add('doi', c.doi);
  add('isbn', c.isbn);
  return `@${type}{${key || bibtexKey(c)},\n${f.join(',\n')}\n}`;
}

/* ---------- RIS (ported) ---------- */

/** One or more works in RIS (the universal Zotero/Mendeley/EndNote interchange). */
export function toRis(citations: BookCitation[]): string {
  const types: Record<string, string> = { article: 'JOUR', book: 'BOOK', chapter: 'CHAP', conference: 'CPAPER', preprint: 'UNPB', thesis: 'THES' };
  return (
    citations
      .map((c) => {
        const L: string[] = [`TY  - ${types[c.type ?? ''] || 'GEN'}`];
        const add = (t: string, v: string | number | undefined) => {
          if (v !== undefined && v !== null && v !== '') L.push(`${t}  - ${String(v).replace(/\r?\n/g, ' ')}`);
        };
        for (const a of structuredOf(c)) add('AU', a.given ? `${a.family}, ${a.given}` : a.family);
        for (const a of editorsOf(c)) add('ED', a.given ? `${a.family}, ${a.given}` : a.family);
        add('TI', c.title);
        add(c.type === 'article' ? 'JO' : 'T2', contOf(c));
        add('PY', c.year);
        add('VL', c.volume);
        add('IS', c.issue);
        const [sp, ep] = String(c.pages || '').split(/\s*[-–—]+\s*/);
        add('SP', sp);
        add('EP', ep);
        add('PB', c.publisher);
        add('DO', c.doi);
        add('SN', c.isbn);
        add('UR', c.url || doiUrl(c));
        L.push('ER  - ');
        return L.join('\n');
      })
      .join('\n\n') + '\n'
  );
}

/* ---------- CSL JSON ---------- */

const CSL_TYPES: Record<string, string> = {
  article: 'article-journal', chapter: 'chapter', conference: 'paper-conference',
  preprint: 'post', thesis: 'thesis', book: 'book', other: 'book',
};

/** One or more works as a CSL JSON array (Zotero's native import format). */
export function toCslJson(citations: BookCitation[]): string {
  const items = citations.map((c) => {
    const authors = structuredOf(c);
    const item: Record<string, unknown> = {
      type: CSL_TYPES[c.type ?? ''] ?? 'book',
      title: c.title,
      author: authors.map((a) => (a.given ? { family: a.family, given: a.given } : { family: a.family })),
    };
    const eds = editorsOf(c);
    if (eds.length) item.editor = eds.map((a) => (a.given ? { family: a.family, given: a.given } : { family: a.family }));
    if (contOf(c)) item['container-title'] = contOf(c);
    if (c.publisher) item.publisher = c.publisher;
    if (c.city) item['publisher-place'] = c.city;
    const year = (c.year ?? '').match(/\d{4}/)?.[0];
    if (year) item.issued = { 'date-parts': [[Number(year)]] };
    if (c.volume) item.volume = c.volume;
    if (c.issue) item.issue = c.issue;
    if (c.pages) item.page = c.pages;
    if (c.edition) item.edition = c.edition;
    if (c.isbn) item.ISBN = c.isbn;
    if (c.doi) item.DOI = c.doi;
    if (c.language) item.language = c.language;
    if (c.pageCount) item['number-of-pages'] = c.pageCount;
    if (c.url) item.URL = c.url;
    return item;
  });
  return JSON.stringify(items, null, 2);
}

/** Combined text for the chosen export format. */
export function renderExport(citations: BookCitation[], format: ExportFormat, style: CitationStyle): string {
  if (format === 'bib') return `${citations.map((c) => toBibtex(c)).join('\n\n')}\n`;
  if (format === 'ris') return toRis(citations);
  if (format === 'json') return `${toCslJson(citations)}\n`;
  return `${citations.map((c) => formatCitation(style, c)).join('\n\n')}\n`;
}
