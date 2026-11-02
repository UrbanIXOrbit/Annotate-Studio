/**
 * Citation schema constants shared by the books store and the citation engine.
 * Kept dependency-free so both sides (and the node test runner) can import it.
 */

/** Every citable field, in the order the merge engine considers them. */
export const CITATION_FIELDS = [
  'title',
  'authors',
  'publisher',
  'city',
  'year',
  'edition',
  'isbn',
  'doi',
  'language',
  'pageCount',
  'container',
  'volume',
  'issue',
  'pages',
] as const;

export type CitationField = (typeof CITATION_FIELDS)[number];

/** Where a citation field's value came from. */
export const CITATION_SOURCE_NAMES = [
  'openlibrary',
  'google-books',
  'crossref',
  'file',
  'manual',
  'openalex',
  'datacite',
  'europepmc',
  'pubmed',
  'semanticscholar',
  'arxiv',
] as const;

export type CitationSourceName = (typeof CITATION_SOURCE_NAMES)[number];
