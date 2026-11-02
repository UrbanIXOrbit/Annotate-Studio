import { fetchWebPage } from './tauri-commands.ts';

/**
 * Reference-lookup engine — a typed port of reference-lookup2.html, which is
 * itself a browser adaptation of the therightbibtex method (AGPL-3.0, Marc Pinet):
 * ask many sources in parallel, group records that describe the same work,
 * separate preprint and published versions, then merge field by field with
 * provenance and report disagreements instead of hiding them.
 *
 * Pure logic is node-testable; the only browser-only API (DOMParser, for the
 * arXiv XML feed) is touched at call time inside one adapter.
 */

/* ---------- Small helpers ---------- */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘',
  '&rdquo;': '”', '&ldquo;': '“', '&shy;': '',
};

/** Strip tags and decode the common entities without touching the DOM. */
export function clean(value: unknown): string {
  const stripped = String(value ?? '').replace(/<[^>]*>/g, '');
  return stripped
    .replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|[a-zA-Z]+);/g, (ent, hex: string, dec: string) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return ENTITY_MAP[ent] ?? ent;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- Identifier detection ---------- */

export type RefKind = 'doi' | 'isbn' | 'pmid' | 'arxiv' | 'title';

export function validIsbn(s: string): boolean {
  let sum = 0;
  if (s.length === 13) {
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  for (let i = 0; i < 10; i++) {
    const c = s[i].toUpperCase();
    sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

export interface Detected {
  kind: RefKind;
  id: string;
  /** ISBN-shaped input whose check digit fails */
  invalid?: boolean;
}

export function detect(line: string): Detected {
  const s = line.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/10\.\d{4,9}\/[^\s"<>]+/))) return { kind: 'doi', id: m[0].replace(/[.,;:]+$/, '') };
  if ((m = s.match(/arxiv(?:\.org\/(?:abs|pdf)\/|\s*:\s*)\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i))) {
    return { kind: 'arxiv', id: m[1] };
  }
  if ((m = s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i))) return { kind: 'pmid', id: m[1] };
  if ((m = s.match(/^pmid\s*:?\s*(\d{1,9})$/i))) return { kind: 'pmid', id: m[1] };
  const compact = s.replace(/^isbn(?:-?1[03])?\s*:?\s*/i, '').replace(/[\s-]/g, '');
  if (/^(97[89]\d{10}|\d{9}[\dXx])$/.test(compact)) {
    const id = compact.toUpperCase();
    return { kind: 'isbn', id, invalid: !validIsbn(id) };
  }
  if (/^\d{5,9}$/.test(s)) return { kind: 'pmid', id: s };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return { kind: 'arxiv', id: s.replace(/v\d+$/, '') };
  return { kind: 'title', id: s.replace(/^["“]|["”]$/g, '') };
}

/* ---------- Names and record helpers ---------- */

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'ter', 'ten']);

export interface RefAuthor {
  family: string;
  given: string;
  org?: boolean;
}

export function parseName(raw: string): RefAuthor | null {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.includes(',')) {
    const [f, ...g] = name.split(',');
    return { family: f.trim(), given: g.join(',').trim() };
  }
  const t = name.split(' ');
  if (t.length === 1) return { family: t[0], given: '' };
  let i = t.length - 1;
  for (let k = 1; k < t.length - 1; k++) {
    if (PARTICLES.has(t[k].toLowerCase())) {
      i = k;
      break;
    }
  }
  return { family: t.slice(i).join(' '), given: t.slice(0, i).join(' ') };
}

function parsePubmedName(name: string): RefAuthor {
  const m = String(name).match(/^(.*)\s+([A-Z]{1,4})$/);
  return m ? { family: m[1], given: m[2].split('').join(' ') } : { family: name, given: '', org: true };
}

export type RefType = 'article' | 'book' | 'chapter' | 'conference' | 'preprint' | 'thesis' | 'other';

export interface RefRecord {
  type: RefType;
  title: string;
  authors: RefAuthor[];
  editors: RefAuthor[];
  year: string;
  container: string;
  containerShort: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  edition: string;
  doi: string;
  isbn: string;
  url: string;
  note: string;
  source: string;
  weight: number;
  dk: string;
  arxiv: string;
  isbns: string[];
  pmid: string;
  related: { kind: string; id: string; rel?: string }[];
  retracted: boolean;
  aggregate: boolean;
  dataset: boolean;
  citations: number;
  firstPubYear: boolean;
  status: 'preprint' | 'published';
  score?: number;
}

type RecordSeed = Partial<Omit<RefRecord, 'authors' | 'editors' | 'year' | 'isbns'>> & {
  authors?: (RefAuthor | null)[];
  editors?: (RefAuthor | null)[];
  year?: string | number;
  isbns?: string[];
  isbn?: string;
  status?: 'preprint' | 'published';
};

function norm(r: RecordSeed): RefRecord {
  return {
    type: 'other', title: '', container: '', containerShort: '', volume: '', issue: '', pages: '',
    publisher: '', edition: '', doi: '', isbn: '', url: '', note: '',
    source: '', weight: 50, dk: '', arxiv: '', pmid: '',
    related: [], retracted: false, aggregate: false, dataset: false, citations: 0, firstPubYear: false,
    status: 'published',
    ...r,
    authors: (r.authors ?? []).filter(Boolean) as RefAuthor[],
    editors: (r.editors ?? []).filter(Boolean) as RefAuthor[],
    year: r.year !== undefined && r.year !== null ? String(r.year) : '',
  } as RefRecord;
}

function expandPages(p: unknown): string {
  const m = String(p || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return String(p || '');
  const [, a, b] = m;
  const end = b.length < a.length ? a.slice(0, a.length - b.length) + b : b;
  return `${a}-${end}`;
}

/* ---------- Network ---------- */

export class NotFoundError extends Error {}

/** A non-2xx from a catalogue API; 429 gets an actionable message. */
export class CatalogueHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 429
        ? 'The online catalogue is rate-limiting requests — try again in a few minutes.'
        : `The online catalogue request failed (${status}).`,
    );
    this.status = status;
  }
}

/**
 * JSON from the webview directly; if CORS or the network blocks it, route the
 * same URL through the desktop-side fetcher and parse its body. HTTP-status
 * failures skip the fallback (same network, same result).
 */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new CatalogueHttpError(response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof CatalogueHttpError) throw error;
    const page = await fetchWebPage(url);
    return JSON.parse(page.html);
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new CatalogueHttpError(response.status);
    return await response.text();
  } catch (error) {
    if (error instanceof CatalogueHttpError) throw error;
    const page = await fetchWebPage(url);
    return page.html;
  }
}

function api(base: string, params: Record<string, string | number | undefined> = {}): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

let contactEmail = '';
/** Crossref/OpenAlex/PubMed answer faster and more reliably to identified clients. */
export function setReferenceContactEmail(email: string): void {
  contactEmail = email.trim();
}
export function getReferenceContactEmail(): string {
  return contactEmail;
}
const mailto = () => contactEmail || undefined;
const doiPath = (d: string) => d.split('/').map(encodeURIComponent).join('/');

/* ---------- Sources: record model, authority weights, API adapters ---------- */

export const SOURCE_LABELS: Record<string, string> = {
  crossref: 'Crossref', openalex: 'OpenAlex', datacite: 'DataCite', europepmc: 'Europe PMC', pubmed: 'PubMed',
  semanticscholar: 'Semantic Scholar', arxiv: 'arXiv', openlibrary: 'Open Library', googlebooks: 'Google Books',
};

// How far each source is trusted when two sources disagree about a field.
const WEIGHTS: Record<string, number> = { crossref: 90, pubmed: 82, europepmc: 80, arxiv: 76, datacite: 72, openlibrary: 70, semanticscholar: 60, googlebooks: 60, openalex: 55 };
const FIELD_BONUS: Record<string, Record<string, number>> = {
  title: { arxiv: 8, pubmed: 4, europepmc: 2, crossref: -2, semanticscholar: -5, openalex: -8, googlebooks: -4 },
  authors: { crossref: 4, arxiv: 2, datacite: 2, pubmed: -2, semanticscholar: -15, openalex: -10, googlebooks: -5 },
  venue: { crossref: 12, pubmed: 8, europepmc: 8, semanticscholar: -20, openalex: -20 },
  numbers: { crossref: 8, pubmed: 8, europepmc: 5, semanticscholar: -20, openalex: -15 },
  publisher: { crossref: 10, openlibrary: 8, openalex: -30, semanticscholar: -40 },
  year: { crossref: 4, arxiv: 6, pubmed: 4, openalex: -10, semanticscholar: -5 },
};

const PREPRINT_PREFIXES = ['10.48550/arxiv.', '10.31219/', '10.31234/', '10.31235/', '10.2139/ssrn.', '10.20944/', '10.21203/', '10.31223/', '10.26434/', '10.36227/', '10.22541/', '10.31730/'];
const REPOSITORY_PREFIXES = ['10.5281/', '10.6084/', '10.17605/', '10.5061/', '10.17632/', '10.7910/'];
export const isPreprintDoi = (d: string) => {
  const v = (d || '').toLowerCase();
  return PREPRINT_PREFIXES.some((p) => v.startsWith(p)) || /^10\.1101\/(\d{4}\.\d{2}\.\d{2}\.|\d{6})/.test(v);
};
export const isRepositoryDoi = (d: string) => REPOSITORY_PREFIXES.some((p) => (d || '').toLowerCase().startsWith(p));
const arxivFromDoi = (d: string) => {
  const m = String(d || '').match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : '';
};
export const arxivDoi = (id: string) => `10.48550/arXiv.${id}`;

export function isbn13(s: string): string {
  const c = String(s || '').replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(c)) return c;
  if (/^\d{9}[\dX]$/.test(c)) {
    const body = '978' + c.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
    return body + String((10 - (sum % 10)) % 10);
  }
  return '';
}

/** One normalised record: one version of a work as described by ONE source. */
export function mk(source: string, o: RecordSeed): RefRecord {
  const r = norm({ ...o });
  r.source = source;
  r.weight = WEIGHTS[source] ?? 50;
  r.doi = String(o.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  r.dk = r.doi.toLowerCase();
  r.arxiv = o.arxiv || arxivFromDoi(r.doi) || '';
  r.isbns = [...new Set((o.isbns || (o.isbn ? [o.isbn] : [])).map(isbn13).filter(Boolean))];
  r.isbn = r.isbns[0] || '';
  r.pmid = o.pmid ? String(o.pmid) : '';
  r.related = o.related || [];
  const pre = o.status === 'preprint' || r.type === 'preprint' || isPreprintDoi(r.doi);
  r.status = pre ? 'preprint' : 'published';
  if (pre) r.type = 'preprint';
  r.title = clean(r.title);
  return r;
}

const CR_TYPES: Record<string, RefType> = {
  'journal-article': 'article', 'book': 'book', 'monograph': 'book', 'edited-book': 'book', 'reference-book': 'book',
  'report': 'book', 'book-chapter': 'chapter', 'book-section': 'chapter', 'book-part': 'chapter',
  'proceedings-article': 'conference', 'posted-content': 'preprint', 'dissertation': 'thesis',
};

interface CrossrefPerson { family?: string; given?: string; name?: string }
interface CrossrefWork {
  type?: string; title?: string[]; subtitle?: string[]; author?: CrossrefPerson[]; editor?: CrossrefPerson[];
  'published-print'?: { 'date-parts'?: number[][] }; published?: { 'date-parts'?: number[][] };
  issued?: { 'date-parts'?: number[][] }; 'published-online'?: { 'date-parts'?: number[][] };
  'container-title'?: string[]; 'short-container-title'?: string[]; volume?: string; issue?: string;
  page?: string; 'article-number'?: string; publisher?: string; 'edition-number'?: string; DOI?: string;
  'isbn-type'?: { value?: string }[]; ISBN?: string[]; URL?: string;
  relation?: Record<string, { 'id-type'?: string; id?: string }[]>;
}

function fromCrossref(m: CrossrefWork): RefRecord {
  const person = (a: CrossrefPerson): RefAuthor => (a.family ? { family: a.family, given: a.given || '' } : { family: a.name || '', given: '', org: true });
  const dp = (m['published-print'] || m.published || m.issued || m['published-online'])?.['date-parts']?.[0]?.[0];
  let title = clean(m.title?.[0] || '');
  const sub = clean(m.subtitle?.[0] || '');
  if (sub && !title.toLowerCase().includes(sub.toLowerCase())) title += `: ${sub}`;
  const related: { kind: string; id: string; rel?: string }[] = [];
  for (const [k, list] of Object.entries(m.relation || {})) {
    if (!/preprint|version|identical/.test(k)) continue;
    for (const x of list ?? []) if (x['id-type'] === 'doi' && x.id) related.push({ kind: 'doi', id: x.id.toLowerCase(), rel: k });
  }
  return mk('crossref', {
    type: CR_TYPES[m.type ?? ''] || 'other', status: m.type === 'posted-content' ? 'preprint' : undefined, title,
    authors: (m.author || []).map(person), editors: (m.editor || []).map(person), year: dp !== undefined ? String(dp) : '',
    container: clean(m['container-title']?.[0] || ''), containerShort: clean(m['short-container-title']?.[0] || ''),
    volume: m.volume ?? '', issue: m.issue ?? '', pages: m.page || m['article-number'] || '', publisher: clean(m.publisher || ''),
    edition: m['edition-number'] ?? '', doi: m.DOI ?? '', isbns: [...(m['isbn-type'] || []).map((x) => x.value ?? ''), ...(m.ISBN || [])],
    url: m.URL ?? '', related,
    dataset: ['dataset', 'component'].includes(m.type ?? '') || /^replication data/i.test(title),
  });
}

const OA_TYPES: Record<string, RefType> = {
  'article': 'article', 'review': 'article', 'letter': 'article', 'editorial': 'article', 'erratum': 'article',
  'book': 'book', 'report': 'book', 'standard': 'book', 'book-chapter': 'chapter', 'book-section': 'chapter',
  'conference-paper': 'conference', 'proceedings-article': 'conference', 'preprint': 'preprint', 'dissertation': 'thesis',
};
const OA_SELECT = 'id,doi,display_name,publication_year,type,authorships,primary_location,biblio,ids,is_retracted,cited_by_count';

interface OpenAlexWork {
  type?: string; title?: string; display_name?: string; publication_year?: number; doi?: string;
  authorships?: { raw_author_name?: string; author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string; host_organization_name?: string } };
  biblio?: { volume?: string; issue?: string; first_page?: string; last_page?: string };
  ids?: { pmid?: string }; is_retracted?: boolean; cited_by_count?: number;
}

function fromOpenAlex(w: OpenAlexWork): RefRecord {
  const b = w.biblio || {};
  const src = w.primary_location?.source;
  const names = (w.authorships || []).map((a): RefAuthor | null => {
    const raw = a.raw_author_name;
    return parseName(raw && raw.includes(',') ? raw : (a.author?.display_name || raw || ''));
  });
  return mk('openalex', {
    type: OA_TYPES[w.type ?? ''] || 'other', title: w.title || w.display_name || '', authors: names, year: w.publication_year,
    container: clean(src?.display_name || ''), publisher: clean(src?.host_organization_name || ''),
    volume: b.volume ?? '', issue: b.issue ?? '',
    pages: b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}-${b.last_page}` : b.first_page) : '',
    doi: w.doi ?? '', pmid: (w.ids?.pmid || '').match(/(\d+)\/?$/)?.[1] ?? '', retracted: !!w.is_retracted, citations: w.cited_by_count,
    dataset: ['dataset', 'software'].includes(w.type ?? ''),
  });
}

const DC_TYPES: Record<string, RefType> = { Preprint: 'preprint', JournalArticle: 'article', Book: 'book', BookChapter: 'chapter', Dissertation: 'thesis', ConferencePaper: 'conference' };

interface DataCiteDoi {
  attributes?: {
    types?: { resourceTypeGeneral?: string }; titles?: { title?: string }[];
    creators?: { familyName?: string; givenName?: string; name?: string; nameType?: string }[];
    publicationYear?: number; container?: { title?: string; volume?: string; issue?: string; firstPage?: string; lastPage?: string };
    publisher?: string | { name?: string }; doi?: string; url?: string;
    relatedIdentifiers?: { relatedIdentifierType?: string; relationType?: string; relatedIdentifier?: string }[];
    identifiers?: { identifierType?: string; identifier?: string }[];
  };
}

function fromDataCite(d: DataCiteDoi): RefRecord {
  const a = d.attributes ?? {};
  const c = a.container || {};
  const pub = typeof a.publisher === 'string' ? a.publisher : a.publisher?.name;
  const related = (a.relatedIdentifiers || [])
    .filter((x) => x.relatedIdentifierType === 'DOI' && /Version|Identical|Preprint|Variant/.test(x.relationType || ''))
    .map((x) => ({ kind: 'doi', id: String(x.relatedIdentifier).toLowerCase(), rel: x.relationType }));
  const ax = (a.identifiers || []).find((x) => x.identifierType === 'arXiv')?.identifier;
  return mk('datacite', {
    type: DC_TYPES[a.types?.resourceTypeGeneral ?? ''] || 'other', title: a.titles?.[0]?.title || '',
    authors: (a.creators || []).map((x): RefAuthor => (x.familyName ? { family: x.familyName, given: x.givenName || '' } : x.nameType === 'Organizational' ? { family: x.name || '', given: '', org: true } : parseName(x.name || '') ?? { family: x.name || '', given: '' })),
    year: a.publicationYear, container: clean(c.title || ''), volume: c.volume ?? '', issue: c.issue ?? '',
    pages: c.firstPage ? (c.lastPage ? `${c.firstPage}-${c.lastPage}` : c.firstPage) : '',
    publisher: pub ?? '', doi: a.doi ?? '', url: a.url ?? '', arxiv: ax ?? '', related,
    dataset: ['Dataset', 'Software'].includes(a.types?.resourceTypeGeneral ?? ''),
  });
}

interface EpmcResult {
  source?: string; title?: string; authorList?: { author?: { lastName?: string; firstName?: string; initials?: string; fullName?: string; collectiveName?: string }[] };
  journalInfo?: { yearOfPublication?: number; journal?: { title?: string; medlineAbbreviation?: string }; volume?: string; issue?: string };
  pubTypeList?: { pubType?: string[] }; pubYear?: string; pageInfo?: string; doi?: string; pmid?: string; id?: number;
  bookOrReportDetails?: { publisher?: string };
}

function fromEpmc(x: EpmcResult): RefRecord {
  const authors = (x.authorList?.author || []).map((a): RefAuthor => (a.lastName
    ? { family: a.lastName, given: a.firstName || (a.initials ? a.initials.split('').join(' ') : '') }
    : { family: a.fullName || a.collectiveName || '', given: '', org: true }));
  const j = x.journalInfo || {};
  const types = x.pubTypeList?.pubType || [];
  return mk('europepmc', {
    type: x.source === 'PPR' ? 'preprint' : x.bookOrReportDetails ? 'book' : 'article',
    title: String(x.title || '').replace(/\.$/, ''), authors,
    year: x.pubYear || (j.yearOfPublication !== undefined ? String(j.yearOfPublication) : ''),
    container: clean(j.journal?.title || ''), containerShort: clean(j.journal?.medlineAbbreviation || ''),
    volume: j.volume ?? '', issue: j.issue ?? '', pages: x.pageInfo ?? '', doi: x.doi ?? '',
    pmid: x.source === 'MED' ? x.pmid || String(x.id ?? '') : x.pmid ?? '',
    retracted: types.includes('Retracted Publication'), publisher: x.bookOrReportDetails?.publisher ?? '',
  });
}

interface PubmedSummary {
  title?: string; authors?: { name?: string; authtype?: string }[]; pubdate?: string; epubdate?: string;
  fulljournalname?: string; source?: string; volume?: string; issue?: string; pages?: string; uid?: string;
  pubtype?: string[]; articleids?: { idtype?: string; value?: string }[];
}

function fromPubmed(s: PubmedSummary): RefRecord {
  return mk('pubmed', {
    type: 'article', title: clean(s.title || '').replace(/\.$/, ''),
    authors: (s.authors || []).filter((a) => !a.authtype || a.authtype === 'Author').map((a) => parsePubmedName(a.name || '')),
    year: (s.pubdate || s.epubdate || '').match(/\d{4}/)?.[0] ?? '', container: s.fulljournalname ?? '', containerShort: s.source ?? '',
    volume: s.volume ?? '', issue: s.issue ?? '', pages: expandPages(s.pages), pmid: s.uid ?? '',
    doi: (s.articleids || []).find((x) => x.idtype === 'doi')?.value ?? '',
    retracted: (s.pubtype || []).includes('Retracted Publication'),
  });
}

interface S2Paper {
  title?: string; year?: number; authors?: { name?: string }[]; venue?: string;
  journal?: { name?: string; volume?: string; pages?: string }; externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string };
  publicationTypes?: string[]; citationCount?: number;
}
const S2_FIELDS = 'title,year,authors,venue,journal,externalIds,publicationTypes,citationCount';

function fromS2(p: S2Paper): RefRecord {
  const types = p.publicationTypes || [];
  const venue = p.journal?.name || p.venue || '';
  const arx = p.externalIds?.ArXiv || '';
  const isPre = /^arxiv/i.test(venue) || (!!arx && !p.journal?.name && !p.venue);
  return mk('semanticscholar', {
    type: isPre ? 'preprint' : types.includes('Conference') ? 'conference' : types.includes('Book') ? 'book' : 'article',
    title: p.title || '', authors: (p.authors || []).map((a) => parseName(a.name || '') ?? { family: a.name || '', given: '' }),
    year: p.year, container: isPre ? '' : clean(venue), volume: p.journal?.volume ?? '', pages: p.journal?.pages ?? '',
    doi: p.externalIds?.DOI ?? '', arxiv: arx, pmid: p.externalIds?.PubMed ?? '', citations: p.citationCount, aggregate: true,
  });
}

interface XmlElementLike {
  getElementsByTagName(tag: string): XmlElementLike[];
  textContent?: string;
}

function fromArxivEntry(en: XmlElementLike): RefRecord | null {
  const t = (tag: string) => (en.getElementsByTagName(tag)[0]?.textContent || '').replace(/\s+/g, ' ').trim();
  const idUrl = t('id');
  const id = (idUrl.match(/abs\/(.+?)(v\d+)?$/) || [])[1];
  if (!id) return null;
  const title = t('title');
  if (!title || title === 'Error') return null;
  const jdoi = t('arxiv:doi');
  return mk('arxiv', {
    type: 'preprint', title,
    authors: [...en.getElementsByTagName('author')].map((a) => parseName(a.getElementsByTagName('name')[0]?.textContent || '') ?? { family: '', given: '' }),
    year: (t('published').match(/\d{4}/) || [''])[0], container: 'arXiv', arxiv: id, doi: arxivDoi(id),
    related: jdoi ? [{ kind: 'doi', id: jdoi.toLowerCase(), rel: 'journal-doi' }] : [],
  });
}

interface OpenLibraryBookData {
  title?: string; subtitle?: string; authors?: { name?: string }[]; publish_date?: string;
  publishers?: { name?: string }[];
}

interface OpenLibraryDoc {
  title?: string; subtitle?: string; author_name?: string[]; first_publish_year?: number;
  publisher?: string[]; isbn?: string[];
}

interface GoogleVolume {
  volumeInfo?: { title?: string; subtitle?: string; authors?: string[]; publishedDate?: string; publisher?: string; industryIdentifiers?: { identifier?: string }[] };
}

// Adapters have heterogeneous signatures (doi/isbn/search/query) and some
// delegate through `this`; `any` keeps the heterogeneous table honest without
// casting at every call site.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type SourceFn = (...args: any[]) => Promise<RefRecord[]>;
interface SourceApi {
  [fn: string]: SourceFn;
}

/* Every adapter returns an array of records and throws NotFoundError when the source has nothing. */
export const API: Record<string, SourceApi> = {
  crossref: {
    async doi(id) {
      const j = (await fetchJson(api(`https://api.crossref.org/works/${doiPath(id)}`, { mailto: mailto() }))) as { message?: CrossrefWork };
      return [fromCrossref(j.message ?? {})];
    },
    async isbn(id) {
      const j = (await fetchJson(api('https://api.crossref.org/works', { filter: `isbn:${id}`, rows: 3, mailto: mailto() }))) as { message?: { items?: CrossrefWork[] } };
      return (j.message?.items ?? []).map(fromCrossref);
    },
    async search(q) {
      const j = (await fetchJson(api('https://api.crossref.org/works', { 'query.bibliographic': q, rows: 8, mailto: mailto() }))) as { message?: { items?: CrossrefWork[] } };
      return (j.message?.items ?? []).map(fromCrossref);
    },
  },
  openalex: {
    async doi(id) {
      return [fromOpenAlex((await fetchJson(api(`https://api.openalex.org/works/doi:${doiPath(id)}`, { select: OA_SELECT, mailto: mailto() }))) as OpenAlexWork)];
    },
    async pmid(id) {
      return [fromOpenAlex((await fetchJson(api(`https://api.openalex.org/works/pmid:${id}`, { select: OA_SELECT, mailto: mailto() }))) as OpenAlexWork)];
    },
    async search(q) {
      const j = (await fetchJson(api('https://api.openalex.org/works', { search: q, per_page: 8, select: OA_SELECT, mailto: mailto() }))) as { results?: OpenAlexWork[] };
      return (j.results ?? []).map(fromOpenAlex);
    },
  },
  datacite: {
    async doi(id) {
      return [fromDataCite((await fetchJson(`https://api.datacite.org/dois/${doiPath(id.toLowerCase())}`)) as DataCiteDoi)];
    },
    async search(q) {
      const j = (await fetchJson(api('https://api.datacite.org/dois', { query: `titles.title:"${q.replace(/"/g, '')}"`, 'page[size]': 6 }))) as { data?: DataCiteDoi[] };
      return (j.data ?? []).map(fromDataCite);
    },
  },
  europepmc: {
    async query(query: string, size = 5) {
      const j = (await fetchJson(api('https://www.ebi.ac.uk/europepmc/webservices/rest/search', { query, format: 'json', resultType: 'core', pageSize: size }))) as { resultList?: { result?: EpmcResult[] } };
      const rs = (j.resultList?.result || []).map(fromEpmc);
      if (!rs.length) throw new NotFoundError();
      return rs;
    },
    doi(id: string) { return this.query(`DOI:"${id}"`, 2); },
    pmid(id: string) { return this.query(`EXT_ID:${id} AND SRC:MED`, 2); },
    search(q: string) { return this.query(q.replace(/[:"()]/g, ' '), 6); },
  },
  pubmed: {
    async pmid(id) {
      const j = (await fetchJson(api('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', { db: 'pubmed', id, retmode: 'json', tool: 'annotate-studio', email: mailto() }))) as { result?: Record<string, PubmedSummary> };
      const s = j.result?.[id];
      if (!s || (s as { error?: unknown }).error || !s.title) throw new NotFoundError();
      return [fromPubmed(s)];
    },
  },
  semanticscholar: {
    async lookup(ext) {
      return [fromS2((await fetchJson(api(`https://api.semanticscholar.org/graph/v1/paper/${encodeURI(ext)}`, { fields: S2_FIELDS }))) as S2Paper)];
    },
    async search(q) {
      const j = (await fetchJson(api('https://api.semanticscholar.org/graph/v1/paper/search', { query: q, limit: 6, fields: S2_FIELDS }))) as { data?: S2Paper[] };
      return (j.data ?? []).map(fromS2);
    },
  },
  arxiv: {
    async feed(params: Record<string, string | number>) {
      const xml = await fetchText(api('https://export.arxiv.org/api/query', params));
      if (typeof DOMParser === 'undefined') throw new NotFoundError();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const recs = [...doc.getElementsByTagName('entry')].map((entry) => fromArxivEntry(entry as unknown as XmlElementLike)).filter((r): r is RefRecord => !!r);
      if (!recs.length) throw new NotFoundError();
      return recs;
    },
    id(id: string) { return this.feed({ id_list: id, max_results: 1 }); },
    search(q: string) { return this.feed({ search_query: `ti:"${q.replace(/"/g, '')}"`, max_results: 5 }); },
  },
  openlibrary: {
    async isbn(id) {
      const j = (await fetchJson(api('https://openlibrary.org/api/books', { bibkeys: `ISBN:${id}`, format: 'json', jscmd: 'data' }))) as Record<string, OpenLibraryBookData | undefined>;
      const b = j[`ISBN:${id}`];
      if (!b) throw new NotFoundError();
      return [mk('openlibrary', {
        type: 'book', title: (b.title || '') + (b.subtitle ? `: ${b.subtitle}` : ''), authors: (b.authors || []).map((a) => parseName(a.name || '') ?? { family: a.name || '', given: '' }),
        year: (b.publish_date || '').match(/\d{4}/)?.[0] ?? '', publisher: b.publishers?.[0]?.name ?? '', isbn: id,
      })];
    },
    async search(q) {
      const j = (await fetchJson(api('https://openlibrary.org/search.json', { q, limit: 6, fields: 'key,title,subtitle,author_name,first_publish_year,publisher,isbn' }))) as { docs?: OpenLibraryDoc[] };
      return (j.docs ?? []).map((d) => mk('openlibrary', {
        type: 'book', title: (d.title || '') + (d.subtitle ? `: ${d.subtitle}` : ''), authors: (d.author_name || []).map((n) => parseName(n) ?? { family: n, given: '' }),
        year: d.first_publish_year, publisher: d.publisher?.[0] ?? '', isbn: d.isbn?.[0] ?? '', firstPubYear: true,
        note: 'The year is the first publication year. Check it against the edition you used.',
      }));
    },
  },
  googlebooks: {
    async query(q: string, n: number) {
      const j = (await fetchJson(api('https://www.googleapis.com/books/v1/volumes', { q, maxResults: n, printType: 'books' }))) as { items?: GoogleVolume[] };
      return (j.items ?? []).map((it) => {
        const v = it.volumeInfo || {};
        const ids = (v.industryIdentifiers || []).map((x) => x.identifier ?? '');
        return mk('googlebooks', {
          type: 'book', title: (v.title || '') + (v.subtitle ? `: ${v.subtitle}` : ''), authors: (v.authors || []).map((a) => parseName(a) ?? { family: a, given: '' }),
          year: (v.publishedDate || '').match(/\d{4}/)?.[0] ?? '', publisher: v.publisher ?? '', isbns: ids,
        });
      });
    },
    isbn(id: string) { return this.query(`isbn:${id}`, 1); },
    search(q: string) { return this.query(q, 6); },
  },
};

// Which sources are asked for each kind of input. All of them are asked at once.
export const PLAN: Record<RefKind, (id: string) => [string, string, string][]> = {
  doi: (id) => [
    ['crossref', 'doi', id], ['openalex', 'doi', id], ['datacite', 'doi', id], ['europepmc', 'doi', id],
    ['semanticscholar', 'lookup', `DOI:${id}`],
    ...(arxivFromDoi(id) ? [['arxiv', 'id', arxivFromDoi(id)] as [string, string, string]] : []),
  ],
  pmid: (id) => [['pubmed', 'pmid', id], ['europepmc', 'pmid', id], ['openalex', 'pmid', id], ['semanticscholar', 'lookup', `PMID:${id}`]],
  arxiv: (id) => [['arxiv', 'id', id], ['datacite', 'doi', arxivDoi(id)], ['openalex', 'doi', arxivDoi(id)], ['semanticscholar', 'lookup', `ARXIV:${id}`]],
  isbn: (id) => [['openlibrary', 'isbn', id], ['googlebooks', 'isbn', id], ['crossref', 'isbn', id]],
  title: (id) => [
    ['crossref', 'search', id], ['openalex', 'search', id], ['europepmc', 'search', id], ['semanticscholar', 'search', id],
    ['arxiv', 'search', id], ['datacite', 'search', id], ['openlibrary', 'search', id], ['googlebooks', 'search', id],
  ],
};

/* ---------- Matching helpers (title, author and identifier comparison) ---------- */

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'to', 'with', 'is', 'are', 'by', 'at', 'from', 'as', 'or']);
const stripAcc = (s: unknown) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const normTitle = (s: unknown) => stripAcc(clean(s)).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string) => normTitle(s).split(' ').filter(Boolean);

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const ratio = (a: string, b: string) => {
  const L = Math.max(a.length, b.length);
  return L ? 1 - lev(a, b) / L : 1;
};

// Word-level overlap; two long, nearly identical words (optimisation/optimization) count as equal.
function tokenSim(ta: string[], tb: string[]): number {
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  const common = [...sa].filter((x) => sb.has(x)).length;
  const restB = [...sb].filter((x) => !sa.has(x));
  let fuzzy = 0;
  for (const w of [...sa].filter((x) => !sb.has(x))) {
    if (w.length < 5) continue;
    const k = restB.findIndex((v) => v.length >= 5 && ratio(w, v) >= 0.88);
    if (k >= 0) {
      fuzzy++;
      restB.splice(k, 1);
    }
  }
  const inter = common + fuzzy;
  return inter / (sa.size + sb.size - inter);
}

export function titleSimilarity(a: string, b: string): number {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.min(ratio(na, nb), tokenSim(na.split(' '), nb.split(' ')) + 0.15);
}

// Share of a's meaningful words that appear in b (a missing subtitle or a translated title still passes).
function titleContain(a: string, b: string): number {
  const ta = toks(a).filter((t) => !STOP.has(t));
  const sb = new Set(toks(b));
  return ta.length ? ta.filter((t) => sb.has(t)).length / ta.length : 0;
}

const famKey = (a: RefAuthor) => stripAcc(a.family || '').toLowerCase().replace(/[^a-z]/g, '');

export function authorsOverlap(a: RefAuthor[], b: RefAuthor[]): number {
  const ka = new Set(a.map(famKey).filter(Boolean));
  const kb = new Set(b.map(famKey).filter(Boolean));
  if (!ka.size || !kb.size) return -1;
  const [small, big] = ka.size <= kb.size ? [ka, kb] : [kb, ka];
  let hits = 0;
  for (const k of small) if (big.has(k) || [...big].some((o) => k.length > 3 && (o.includes(k) || k.includes(o)))) hits++;
  return hits / small.size;
}

const DISTINCT = /\b(invited|talk|keynote|erratum|errata|correction|corrigendum|retraction|retracted|reply|response|comment|comments|commentary|supplementary|supplement|supplemental|poster|demo|demonstration|tutorial|review|preface|abstracts|summary|withdrawn|addendum|discussion|rejoinder|retrospective|reproducibility|replication)\b/g;
const SUPP_RE = /^(replication|supplementary|supplemental|supporting|reproducibility|reproduction)\s+(data|dataset|datasets|code|software|materials?|information|files?|package)\b/;
const isSupplement = (r: RefRecord) => r.dataset || isRepositoryDoi(r.doi) || SUPP_RE.test(normTitle(r.title));

// A same-work test that errs towards keeping different papers apart.
export function sameWork(a: RefRecord, b: RefRecord): boolean {
  const ta = normTitle(a.title), tb = normTitle(b.title);
  if (!ta || !tb) return false;
  const ma = new Set(ta.match(DISTINCT) || []);
  const mb = new Set(tb.match(DISTINCT) || []);
  if (ma.size !== mb.size || [...ma].some((x) => !mb.has(x))) return false;
  if (isSupplement(a) !== isSupplement(b)) return false;
  const sim = ta === tb ? 1 : titleSimilarity(a.title, b.title);
  if (sim < 0.9) return false;
  const ov = authorsOverlap(a.authors, b.authors);
  if (ov !== -1 && ov < 0.5) return false;
  const ya = +a.year, yb = +b.year;
  if (ya && yb && Math.abs(ya - yb) > 3) return false;
  if (ta.split(' ').length <= 3 && (ov === -1 || !(ya && yb && Math.abs(ya - yb) <= 1))) return false;
  return sim >= 0.94 || ov >= 0.75;
}

// Two records that share an identifier: do they really describe the same text?
function titlesAgree(a: RefRecord, b: RefRecord): boolean {
  if (Math.max(titleContain(a.title, b.title), titleContain(b.title, a.title)) >= 0.6) return true;
  const ov = authorsOverlap(a.authors, b.authors);
  return ov >= 0.5 && !(+a.year && +b.year && Math.abs(+a.year - +b.year) > 2);
}

function idKeys(r: RefRecord): Set<string> {
  const k = new Set<string>();
  if (r.dk) k.add('doi:' + r.dk);
  if (r.arxiv) {
    k.add('arxiv:' + r.arxiv.toLowerCase());
    k.add('doi:' + arxivDoi(r.arxiv).toLowerCase());
  }
  if (r.pmid) k.add('pmid:' + r.pmid);
  r.isbns.forEach((i) => k.add('isbn:' + i));
  r.related.forEach((x) => x.id && k.add(`${x.kind}:${x.id}`));
  return k;
}

// OpenAlex or Semantic Scholar sometimes attach a DOI that belongs to another paper.
// The registry that issued the DOI (Crossref, DataCite) decides: a record that disagrees loses it.
function dropForeignIds(records: RefRecord[]): void {
  const byDoi: Record<string, RefRecord[]> = {};
  const byArxiv: Record<string, RefRecord[]> = {};
  for (const r of records) {
    if (r.dk && ['crossref', 'datacite'].includes(r.source)) (byDoi[r.dk] ||= []).push(r);
    if (r.arxiv && r.source === 'arxiv') (byArxiv[r.arxiv] ||= []).push(r);
  }
  for (const r of records) {
    if (r.dk && !['crossref', 'datacite'].includes(r.source) && byDoi[r.dk] && !byDoi[r.dk].some((a) => titlesAgree(a, r))) {
      r.doi = '';
      r.dk = '';
    }
    if (r.arxiv && r.source !== 'arxiv' && byArxiv[r.arxiv] && !byArxiv[r.arxiv].some((a) => titlesAgree(a, r))) r.arxiv = '';
  }
}

export function cluster(records: RefRecord[]): RefRecord[][] {
  dropForeignIds(records);
  const n = records.length;
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) p[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owners: Record<string, number[]> = {};
  records.forEach((r, i) => {
    for (const k of idKeys(r)) {
      const list = (owners[k] ||= []);
      const m = list.find((o) => titlesAgree(records[o], r));
      if (m === undefined) list.push(i);
      else union(m, i);
    }
  });
  const nt = records.map((r) => normTitle(r.title));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (Math.abs(nt[i].length - nt[j].length) > Math.max(12, 0.25 * Math.max(nt[i].length, nt[j].length))) continue;
      if (sameWork(records[i], records[j])) union(i, j);
    }
  }
  const groups: Record<number, RefRecord[]> = {};
  records.forEach((r, i) => (groups[find(i)] ||= []).push(r));
  return Object.values(groups);
}

/* ---------- Versions: preprint, published, other ---------- */

const PUBLISHED_KINDS: RefType[] = ['article', 'conference', 'chapter', 'book', 'thesis'];
const statusOf = (r: RefRecord) => (r.dataset || isRepositoryDoi(r.doi) ? 'other' : r.status);

function versionKey(r: RefRecord, st: string): string {
  if (st === 'preprint') return r.arxiv ? `pre|arxiv:${r.arxiv.toLowerCase()}` : r.dk ? `pre|doi:${r.dk}` : `pre|${r.source}:${normTitle(r.title).slice(0, 40)}`;
  if (st === 'published') return r.dk ? `pub|doi:${r.dk}` : `pubnd|${r.isbn || 'x'}`;
  return `other|${r.dk || r.source}`;
}

const yearsClose = (a: RefRecord[], b: RefRecord[]) => {
  const ya = a.map((r) => +r.year).filter(Boolean);
  const yb = b.map((r) => +r.year).filter(Boolean);
  return !ya.length || !yb.length || Math.min(...ya.flatMap((x) => yb.map((y) => Math.abs(x - y)))) <= 1;
};

interface RefVersion {
  key: string;
  status: string;
  records: RefRecord[];
  rec: MergedRef;
  label: string;
}

export interface MergedRef {
  type: RefType;
  title: string;
  authors: RefAuthor[];
  editors: RefAuthor[];
  year: string;
  container: string;
  containerShort: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  edition: string;
  doi: string;
  isbn: string;
  url: string;
  note: string;
  pmid: string;
  prov: Record<string, string>;
  conflicts: { field: string; values: { value: string; sources: string[] }[] }[];
  confidence: 'high' | 'medium' | 'low';
  nSources: number;
  sources: string[];
  retracted: boolean;
  source: string;
}

function buildVersions(records: RefRecord[]): { key: string; status: string; records: RefRecord[] }[] {
  const groups: Record<string, RefRecord[]> = {};
  for (const r of records) (groups[versionKey(r, statusOf(r))] ||= []).push(r);
  // Records with no DOI (Open Library, Google Books, PubMed-only) join the one published version of the same period.
  const pubs = Object.keys(groups).filter((k) => k.startsWith('pub|'));
  for (const k of Object.keys(groups).filter((k) => k.startsWith('pubnd|'))) {
    const target = pubs.length === 1 && yearsClose(groups[k], groups[pubs[0]]) ? pubs[0] : null;
    if (target) {
      groups[target].push(...groups[k]);
      delete groups[k];
    }
  }
  return Object.entries(groups).map(([key, recs]) => ({
    key,
    status: ({ pre: 'preprint', pub: 'published', pubnd: 'published' } as Record<string, string>)[key.split('|')[0]] || 'other',
    records: recs,
  }));
}

/* ---------- Merging fields from the most reliable source ---------- */

const initialsOnly = (a: RefAuthor) => !a.given || /^[A-Z](?:[\s.\-]*[A-Z])*\.?$/.test(a.given.trim());

function fieldWeight(r: RefRecord, field: string): number {
  let w = r.weight + (FIELD_BONUS[field]?.[r.source] || 0);
  if (field === 'authors') {
    if (!r.authors.length) return -1e9;
    if (r.authors.filter((a) => !a.org).every(initialsOnly)) w -= 40;
  }
  if (field === 'year' && r.firstPubYear) w -= 25;
  return w;
}

function pick(recs: RefRecord[], bonusField: string, get: (r: RefRecord) => unknown, field?: string): [string, string] {
  let best = '', bw = -1e18, src = '';
  for (const r of recs) {
    const v = get(r);
    if (v === undefined || v === null || v === '') continue;
    const w = fieldWeight(r, field || bonusField);
    if (w > bw) {
      best = String(v);
      bw = w;
      src = r.source;
    }
  }
  return [best, src];
}

// Author list from the best source among those whose author count matches the majority
// (some records are truncated or list a consortium).
function authorConsensus(recs: RefRecord[]): [RefAuthor[], string] {
  const cands = recs.filter((r) => r.authors.length);
  if (!cands.length) return [[], ''];
  const counts: Record<number, number> = {};
  cands.forEach((r) => (counts[r.authors.length] = (counts[r.authors.length] || 0) + 1));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]));
  const n = top[0][1] === 1 ? Math.max(...Object.keys(counts).map(Number)) : Number(top[0][0]);
  const pool = cands.filter((r) => r.authors.length === n);
  const best = pool.reduce((a, b) => (fieldWeight(b, 'authors') > fieldWeight(a, 'authors') ? b : a));
  return [best.authors, best.source];
}

function yearVote(recs: RefRecord[]): [string, string] {
  const votes: Record<string, number> = {};
  const best: Record<string, [number, string]> = {};
  for (const r of recs) {
    if (!+r.year) continue;
    const w = Math.max(1, fieldWeight(r, 'year'));
    votes[r.year] = (votes[r.year] || 0) + w;
    if (!best[r.year] || w > best[r.year][0]) best[r.year] = [w, r.source];
  }
  const ys = Object.keys(votes);
  if (!ys.length) return ['', ''];
  const y = ys.reduce((a, b) => (votes[b] > votes[a] ? b : a));
  return [y, best[y][1]];
}

// Initials become full first names when another record of the same work has them.
function enrichAuthors(authors: RefAuthor[], pool: RefRecord[]): RefAuthor[] {
  const index: Record<string, RefAuthor[]> = {};
  for (const r of pool) {
    for (const b of r.authors) {
      if (b.given && !initialsOnly(b)) (index[famKey(b)] ||= []).push(b);
    }
  }
  return authors.map((a) => {
    if (a.org || (a.given && !initialsOnly(a))) return a;
    const ini = (a.given || '').charAt(0).toLowerCase();
    const c = (index[famKey(a)] || []).filter((b) => !ini || b.given.charAt(0).toLowerCase() === ini);
    if (!c.length) return a;
    const best = c.reduce((x, y) => (y.given.length > x.given.length ? y : x));
    return { family: best.family.length >= a.family.length ? best.family : a.family, given: best.given };
  });
}

const normPagesKey = (p: unknown) => String(p).replace(/\s*[-–—]+\s*/g, '-');

function evidenceGroups(recs: RefRecord[]): Set<string> {
  const g = new Set<string>();
  for (const r of recs) g.add(['crossref', 'openalex', 'datacite'].includes(r.source) ? 'registry' : ['pubmed', 'europepmc'].includes(r.source) ? 'pubmed' : r.source);
  return g;
}

function mergeVersion(v: { key: string; status: string; records: RefRecord[] }, pool: RefRecord[]): MergedRef {
  const recs = v.records;
  const primary = recs.filter((r) => !r.aggregate).length ? recs.filter((r) => !r.aggregate) : recs;
  const prov: Record<string, string> = {};
  const L = (s: string) => (s ? SOURCE_LABELS[s] || s : '');
  let type: RefType;
  if (v.status === 'preprint') type = 'preprint';
  else {
    const auth = [...primary].sort((a, b) => b.weight - a.weight);
    type = auth.find((r) => PUBLISHED_KINDS.includes(r.type))?.type || 'other';
    if (type === 'chapter' && primary.some((r) => r.type === 'conference')) type = 'conference';
  }
  const [title, ts] = pick(recs, 'title', (r) => r.title);
  prov.title = ts;
  let [authors, as] = authorConsensus(recs);
  prov.authors = as;
  if (authors.some((a) => !a.org && initialsOnly(a))) authors = enrichAuthors(authors, pool);
  const [year, ys] = yearVote(primary.some((r) => +r.year) ? primary : recs);
  prov.year = ys;
  const out: MergedRef = {
    type, title, authors, editors: [], year, container: '', containerShort: '', volume: '', issue: '', pages: '',
    publisher: '', edition: '', doi: '', isbn: '', url: '', note: '', pmid: '',
    prov: {}, conflicts: [], confidence: 'low', nSources: 0, sources: [], retracted: false, source: recs[0]?.source ?? '',
  };
  if (v.status === 'preprint') {
    const ax = recs.find((r) => r.arxiv);
    out.container = ax ? 'arXiv' : primary.find((r) => r.container)?.container || primary.find((r) => r.publisher)?.publisher || 'Preprint';
    out.doi = recs.find((r) => r.source === 'arxiv' || r.source === 'datacite')?.doi || recs.find((r) => r.doi)?.doi || '';
    prov.doi = recs.find((r) => r.doi)?.source ?? '';
  } else {
    const [venue, vs] = pick(recs, 'venue', (r) => r.container);
    out.container = venue;
    prov.container = vs;
    const [short, ss] = pick(recs, 'venue', (r) => r.containerShort);
    out.containerShort = short;
    if (short) prov.containerShort = ss;
    for (const f of ['volume', 'issue', 'pages'] as const) {
      const [val, s] = pick(recs, 'numbers', (r) => r[f]);
      out[f] = val;
      if (val) prov[f] = s;
    }
    const [pub, ps] = pick(primary, 'publisher', (r) => r.publisher);
    out.publisher = pub;
    if (pub) prov.publisher = ps;
    const [ed] = pick(primary, 'publisher', (r) => r.edition);
    out.edition = ed;
    const doiRec = v.key.startsWith('pub|') ? primary.find((r) => r.dk === v.key.replace(/^pub\|doi:/, '')) : primary.find((r) => r.doi);
    out.doi = doiRec?.doi || '';
    if (out.doi && doiRec) prov.doi = doiRec.source;
    out.editors = (primary.find((r) => r.editors.length) || { editors: [] }).editors;
  }
  out.isbn = recs.find((r) => r.isbn)?.isbn || '';
  out.note = recs.map((r) => r.note).find(Boolean) || '';
  out.pmid = recs.find((r) => r.pmid)?.pmid || '';
  Object.keys(prov).forEach((k) => {
    if (!prov[k]) delete prov[k];
    else prov[k] = L(prov[k]);
  });

  // Disagreements between trustworthy sources are reported, never silently merged.
  const strong = recs.filter((r) => r.weight >= 70 && !r.aggregate);
  const conflicts: MergedRef['conflicts'] = [];
  const bucket = (name: string, get: (r: RefRecord) => unknown, fmt: (x: unknown) => unknown = (x) => x) => {
    const m: Record<string, Set<string>> = {};
    strong.forEach((r) => {
      const val = get(r);
      if (val) (m[String(fmt(val))] ||= new Set()).add(L(r.source));
    });
    if (Object.keys(m).length > 1) conflicts.push({ field: name, values: Object.entries(m).map(([value, s]) => ({ value, sources: [...s].sort() })) });
  };
  bucket('year', (r) => +r.year || '');
  bucket('pages', (r) => r.pages, normPagesKey);
  bucket('number of authors', (r) => (r.authors.length ? String(r.authors.length) : ''));

  const groups = evidenceGroups(recs);
  const retracted = recs.some((r) => r.retracted);
  let confidence: MergedRef['confidence'] = groups.size >= 3 ? 'high' : groups.size === 2 ? 'medium' : 'low';
  if (conflicts.length && confidence === 'high') confidence = 'medium';
  Object.assign(out, {
    prov,
    conflicts,
    confidence,
    nSources: groups.size,
    sources: [...new Set(recs.map((r) => L(r.source)))],
    retracted,
  });
  return out;
}

const verLabel = (v: { status: string; records: RefRecord[] }, rec: MergedRef) =>
  v.status === 'preprint'
    ? `Preprint${rec.container ? ` (${rec.container})` : ''}${rec.year ? `, ${rec.year}` : ''}`
    : v.status === 'published'
      ? `Published${rec.container || rec.publisher ? `: ${rec.container || rec.publisher}` : ''}${rec.year ? `, ${rec.year}` : ''}`
      : 'Other record';

export function analyseCluster(recs: RefRecord[]): { versions: RefVersion[]; chosen: number; rec: MergedRef } {
  const versions: RefVersion[] = buildVersions(recs).map((v) => {
    const rec = mergeVersion(v, recs);
    return { status: v.status, records: v.records, rec, key: v.key, label: verLabel(v, rec) };
  });
  const rank = (v: RefVersion) => ({ published: 3, preprint: 2, other: 0 }[v.status] ?? 0 + v.records.length * 0.01);
  let chosen = 0;
  versions.forEach((v, i) => {
    if (rank(v) > rank(versions[chosen])) chosen = i;
  });
  return { versions, chosen, rec: versions[chosen].rec };
}

/* ---------- Scoring candidates against what was typed ---------- */

function mainTitleMatch(q: string, title: string): number {
  const main = String(title).split(/\s*[:?!]\s+|\s+[-–—]\s+/)[0];
  return normTitle(q) && normTitle(q) === normTitle(main) ? 0.97 : 0;
}

function keywordScore(q: string, r: RefRecord): number {
  const y = (q.match(/\b(?:19|20)\d{2}\b/) || [])[0];
  const qt = toks(q).filter((t) => !STOP.has(t) && t !== y);
  if (qt.length < 2) return 0;
  const hay = [...toks(r.title), ...r.authors.map(famKey)];
  const matched = qt.filter((t) => hay.some((h) => h === t || (t.length >= 4 && h.startsWith(t)))).length / qt.length;
  return matched >= 0.99 ? 0.9 : matched >= 0.75 ? 0.7 * matched : 0;
}

export function recordMatch(r: RefRecord, q: string): number {
  if (!r.title) return 0;
  const nq = normTitle(q);
  const nr = normTitle(r.title);
  let s = titleSimilarity(q, r.title);
  if (nq.length < nr.length * 0.8 && nq.split(' ').length >= 2) {
    const partial = nr.includes(nq) ? 1 : 0.9 * titleContain(q, r.title);
    s = Math.max(s, partial * 0.92 * Math.min(1, 0.55 + nq.length / Math.max(nr.length, 1)));
  }
  s = Math.max(s, mainTitleMatch(q, r.title), keywordScore(q, r));
  if (isSupplement(r) && !SUPP_RE.test(nq)) s -= 0.2;
  const y = (q.match(/\b(?:19|20)\d{2}\b/) || [])[0];
  if (y && +r.year) {
    const dy = Math.abs(+y - +r.year);
    s += dy <= 1 ? 0.03 : dy <= 3 ? -0.03 : -0.08;
  }
  return Math.max(0, Math.min(1, s));
}

function clusterScore(recs: RefRecord[]): number {
  const base = Math.max(...recs.map((r) => r.score || 0));
  const groups = evidenceGroups(recs);
  const curated = ['pubmed', 'arxiv'].some((g) => groups.has(g));
  let bonus = Math.min(0.045, 0.015 * Math.max(0, groups.size - 1)) + (curated ? 0.015 : 0);
  if (recs.every((r) => r.aggregate)) bonus -= 0.05;
  bonus += Math.min(0.005, Math.log10(1 + Math.max(...recs.map((r) => r.citations || 0))) * 0.001);
  return base + bonus;
}

interface ClusterRec { recs: RefRecord[]; score: number }

function rankClusters(records: RefRecord[], kind: RefKind, id: string): ClusterRec[] {
  const clusters = cluster(records).map((recs) => ({ recs, score: 0 }));
  if (kind === 'title') {
    clusters.forEach((c) => {
      c.recs.forEach((r) => (r.score = recordMatch(r, id)));
      c.score = clusterScore(c.recs);
    });
  } else {
    const q = new Set<string>();
    if (kind === 'doi') q.add('doi:' + id.toLowerCase());
    if (kind === 'arxiv') {
      q.add('arxiv:' + id.toLowerCase());
      q.add('doi:' + arxivDoi(id).toLowerCase());
    }
    if (kind === 'pmid') q.add('pmid:' + id);
    if (kind === 'isbn') q.add('isbn:' + isbn13(id));
    clusters.forEach((c) => {
      const ids = new Set<string>();
      c.recs.forEach((r) => idKeys(r).forEach((k) => ids.add(k)));
      c.score = ([...q].some((k) => ids.has(k)) ? 10 : 0) + evidenceGroups(c.recs).size + Math.max(...c.recs.map((r) => r.weight)) / 1000;
    });
  }
  return clusters.sort((a, b) => b.score - a.score);
}

/* ---------- One lookup: ask every source, expand, cluster, merge ---------- */

const PHASE_BUDGET = 16000;
const EXPAND_BUDGET = 10000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withBudget = (promises: Promise<unknown>[], ms: number) => Promise.race([Promise.allSettled(promises), sleep(ms)]);

export interface SourceProgress {
  pending: number;
  found: number;
  none: number;
  errors: string[];
}

export interface LookupEntry {
  kind: RefKind;
  id: string;
  raw: string;
  invalid?: boolean;
  status: 'loading' | 'ok' | 'choose' | 'empty' | 'error';
  error: string;
  versions: RefVersion[];
  chosen: number;
  rec: MergedRef | null;
  cands: { score: number; versions: RefVersion[]; chosen: number; rec: MergedRef }[];
  progress: Record<string, SourceProgress>;
}

export interface LookupOptions {
  /** Per-source on/off switches, keyed by SOURCE_LABELS keys */
  enabled?: Record<string, boolean>;
}

function applyCand(en: LookupEntry, i: number): void {
  const c = en.cands[i];
  en.status = 'ok';
  en.versions = c.versions;
  en.chosen = c.chosen;
  en.rec = c.versions[c.chosen].rec;
}

/**
 * Look up one line of input (identifier or title) across every applicable
 * source, then expand the best cluster's related identifiers. Mutates and
 * returns the entry.
 */
export async function lookupEntry(en: LookupEntry, opts: LookupOptions = {}): Promise<LookupEntry> {
  en.status = 'loading';
  en.error = '';
  en.rec = null;
  en.versions = [];
  en.cands = [];
  en.progress = {};
  if (en.invalid) {
    en.status = 'error';
    en.error = 'This looks like an ISBN, but its check digit does not match. Check it for a typing mistake.';
    return en;
  }
  const records: RefRecord[] = [];
  const done = new Set<string>();
  let closed = false;
  const enabled = opts.enabled ?? {};
  const isEnabled = (src: string) => enabled[src] !== false;

  const call = (src: string, fn: string, arg: string): Promise<unknown> | null => {
    const key = `${src}:${fn}:${arg}`;
    if (done.has(key) || !isEnabled(src)) return null;
    done.add(key);
    const pr = (en.progress[src] ||= { pending: 0, found: 0, none: 0, errors: [] });
    pr.pending++;
    return (async () => {
      try {
        const recs = await API[src][fn](arg);
        if (!closed) {
          records.push(...recs);
          pr.found += recs.length;
        }
      } catch (err) {
        if (err instanceof NotFoundError) pr.none++;
        else if (err instanceof Error) pr.errors.push(err.message);
        else pr.errors.push(String(err));
      } finally {
        pr.pending--;
      }
    })();
  };
  const runPlan = (plan: [string, string, string][]) => plan.map(([src, fn, arg]) => call(src, fn, arg)).filter((x): x is Promise<unknown> => !!x);

  // Phase 1: every relevant source at once.
  await withBudget(runPlan(PLAN[en.kind](en.id)), PHASE_BUDGET);

  // Phase 2: follow what phase 1 revealed (published DOI of a preprint, arXiv id, PubMed id) in the best clusters.
  if (records.length) {
    const top = rankClusters(records, en.kind, en.id).slice(0, en.kind === 'title' ? 2 : 1);
    const tasks: Promise<unknown>[] = [];
    for (const c of top) {
      const dois = new Map<string, string>();
      const arxivs = new Set<string>();
      const pmids = new Set<string>();
      const have = new Set(c.recs.map((r) => r.source));
      c.recs.forEach((r) => {
        if (r.doi) dois.set(r.dk, r.doi);
        r.related.forEach((x) => x.kind === 'doi' && x.id && dois.set(x.id, x.id));
        if (r.arxiv) arxivs.add(r.arxiv);
        if (r.pmid) pmids.add(r.pmid);
      });
      const ordered = [...dois.values()].sort((a, b) => Number(isPreprintDoi(a)) - Number(isPreprintDoi(b))).slice(0, 4);
      for (const d of ordered) {
        tasks.push(...runPlan([[isPreprintDoi(d) || isRepositoryDoi(d) ? 'datacite' : 'crossref', 'doi', d], ['openalex', 'doi', d], ['europepmc', 'doi', d]]));
        if (!have.has('semanticscholar')) tasks.push(...runPlan([['semanticscholar', 'lookup', `DOI:${d}`]]));
      }
      for (const a of [...arxivs].slice(0, 2)) if (!have.has('arxiv')) tasks.push(...runPlan([['arxiv', 'id', a]]));
      for (const p of [...pmids].slice(0, 1)) if (!have.has('pubmed')) tasks.push(...runPlan([['pubmed', 'pmid', p]]));
    }
    if (tasks.length) await withBudget(tasks, EXPAND_BUDGET);
  }
  closed = true;
  return finish(en, records);
}

function finish(en: LookupEntry, records: RefRecord[]): LookupEntry {
  if (!records.length) {
    en.status = 'error';
    const msgs = Object.values(en.progress).flatMap((p) => p.errors);
    const allFailed = msgs.length > 0 && Object.values(en.progress).every((p) => p.errors.length || !(p.found + p.none));
    en.error = allFailed
      ? [...new Set(msgs)].length === 1
        ? msgs[0]
        : Object.entries(en.progress)
            .flatMap(([s, p]) => p.errors.map((m) => `${SOURCE_LABELS[s]}: ${m}`))
            .join(' ')
      : en.kind === 'title'
        ? 'No matches found. Try more of the title, or add the first author’s surname.'
        : 'No source has a record for this.';
    return en;
  }
  const ranked = rankClusters(records, en.kind, en.id);
  if (en.kind === 'title') {
    const good = ranked.filter((c) => c.score >= 0.45).slice(0, 4);
    if (!good.length) {
      en.status = 'error';
      en.error = 'No close matches found. Try more of the title, or add the first author’s surname.';
      return en;
    }
    en.cands = good.map((c) => ({ score: c.score, ...analyseCluster(c.recs) }));
    const [a, b] = en.cands;
    if (a.score >= 0.95 && (!b || a.score - b.score >= 0.04)) applyCand(en, 0);
    else en.status = 'choose';
  } else {
    en.cands = [{ score: 1, ...analyseCluster(ranked[0].recs) }];
    applyCand(en, 0);
  }
  return en;
}

/** Detect and look up one line of input. */
export async function lookupLine(raw: string, opts: LookupOptions = {}): Promise<LookupEntry> {
  const detected = detect(raw);
  const en: LookupEntry = {
    kind: detected.kind,
    id: detected.id,
    raw,
    invalid: detected.invalid,
    status: 'loading',
    error: '',
    versions: [],
    chosen: 0,
    rec: null,
    cands: [],
    progress: {},
  };
  return lookupEntry(en, opts);
}
