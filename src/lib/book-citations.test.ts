import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSearchTitle,
  citationGaps,
  citationReview,
  diffCitationFields,
  doiFromFilename,
  duplicateKeys,
  findDuplicateOf,
  findDuplicates,
  isValidDoi,
  isValidIsbn,
  validateCitationField,
  ebookFile,
  isCitationCapable,
  mergedToCitation,
  parseCitationInput,
  sourceDisplayName,
  toSchemaSource,
} from './book-citations.ts';
import type { BookCitation } from '@/store/books';
import { CITATION_SOURCE_NAMES } from './citation-schema.ts';
import { analyseCluster, mk, SOURCE_LABELS } from './reference-lookup.ts';

test('cleanSearchTitle turns filenames into searchable titles', () => {
  assert.equal(cleanSearchTitle('Calculus_Early_Transcendentals_8th_Edition'), 'Calculus Early Transcendentals');
  assert.equal(cleanSearchTitle('Organic Chemistry - 2nd ed'), 'Organic Chemistry');
  assert.equal(cleanSearchTitle('War and Peace'), 'War and Peace');
  assert.equal(cleanSearchTitle('A_File.With.Separators'), 'A File With Separators');
  assert.equal(cleanSearchTitle('8th'), '8th'); // nothing to strip, keeps the word
});

test('isCitationCapable covers pdf and ebook formats only', () => {
  for (const ext of ['pdf', 'epub', 'mobi', 'azw3', 'azw', 'fb2', 'cbz', '.EPUB']) {
    assert.equal(isCitationCapable(ext), true, ext);
  }
  for (const ext of ['md', 'txt', 'png', 'docx', 'jpg']) {
    assert.equal(isCitationCapable(ext), false, ext);
  }
});

test('parseCitationInput pulls identifiers and year out of a pasted reference', () => {
  const parsed = parseCitationInput('Tolstoy, Leo. War and Peace. Penguin, 1869. ISBN 978-0-14-044913-6');
  assert.equal(parsed.isbn, '9780140449136');
  assert.equal(parsed.year, '1869');
  assert.equal(parsed.remainder.includes('978'), false);
  assert.ok(parsed.remainder.includes('War and Peace'));

  const spaced = parseCitationInput('ISBN: 978 0 14 044913 6');
  assert.equal(spaced.isbn, '9780140449136');

  const withDoi = parseCitationInput('Deep Learning. MIT Press, 2016. https://doi.org/10.5555/3295222.3295250');
  assert.equal(withDoi.doi, '10.5555/3295222.3295250');
  assert.equal(withDoi.year, '2016');
  assert.equal(withDoi.isbn, undefined);

  const plain = parseCitationInput('War and Peace');
  assert.equal(plain.isbn, undefined);
  assert.equal(plain.doi, undefined);
  assert.equal(plain.year, undefined);
  assert.equal(plain.remainder, 'War and Peace');
});

test('downloaded-article filenames that are DOIs resolve to the real DOI', () => {
  assert.equal(doiFromFilename('10.1515_9783111611358-005.pdf'), '10.1515/9783111611358-005');
  assert.equal(doiFromFilename('10.1007@978-90-6704-891-0.pdf'), '10.1007/978-90-6704-891-0');
  assert.equal(doiFromFilename('10.3790_schm_138_1_53'), undefined); // no dot in the prefix — too risky
  assert.equal(doiFromFilename('war-and-peace.pdf'), undefined);
  assert.equal(doiFromFilename('notes.txt'), undefined);

  const parsed = parseCitationInput('10.1515_9783111611358-005.pdf');
  assert.equal(parsed.doi, '10.1515/9783111611358-005');
  assert.equal(parsed.remainder, '');
});

test('every engine source maps onto a name the saved-citation schema accepts', () => {
  for (const key of Object.keys(SOURCE_LABELS)) {
    assert.ok((CITATION_SOURCE_NAMES as readonly string[]).includes(toSchemaSource(key)), key);
  }
  assert.equal(toSchemaSource('googlebooks'), 'google-books');
  assert.equal(sourceDisplayName('google-books'), 'Google Books');
  assert.equal(sourceDisplayName('crossref'), 'Crossref');
});

test('a merged record keeps its edition and records Google Books provenance under the schema name', () => {
  const fromBooks = analyseCluster([
    mk('googlebooks', { type: 'book', title: 'The Ecology of Human Development', year: 1979, publisher: 'Harvard University Press', authors: [{ family: 'Bronfenbrenner', given: 'Urie' }] }),
  ]);
  const citation = mergedToCitation(fromBooks.rec);
  assert.equal(citation.fieldSources?.title, 'google-books');
  assert.equal(citation.fieldSources?.publisher, 'google-books');

  const withEdition = analyseCluster([
    mk('crossref', { type: 'book', title: 'Social Work Practice', year: 2018, publisher: 'Sage', edition: '3', authors: [{ family: 'Adebayo', given: 'Tunde' }] }),
  ]);
  const saved = mergedToCitation(withEdition.rec);
  assert.equal(saved.edition, '3');
  assert.equal(saved.fieldSources?.edition, 'crossref');
});

test('ebooks are handed to foliate-js as a named, typed File (a bare Blob makes makeBook throw)', () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const epub = ebookFile(bytes, 'Ecology.epub', 'epub');
  assert.equal(epub.name, 'Ecology.epub');
  assert.equal(epub.type, 'application/epub+zip');
  assert.equal(epub.size, 4);
  assert.equal(ebookFile(bytes, 'strip.cbz', '.CBZ').type, 'application/vnd.comicbook+zip');
  assert.equal(ebookFile(bytes, 'novel.fb2', 'fb2').type, 'application/x-fictionbook+xml');
  // Even a missing name is replaced, because foliate calls name.endsWith(...)
  assert.equal(ebookFile(bytes, '', 'mobi').name, 'book.mobi');
});

test('diffCitationFields names only what would actually change', () => {
  const saved: BookCitation = { title: 'The Ecology of Human Development', authors: ['Bronfenbrenner, Urie'], year: '1979', publisher: 'Harvard University Press', isbn: '9780674224575', source: 'manual', retrievedAt: '' };
  const same = { ...saved, title: 'the ecology of human development', publisher: 'Harvard  University Press.' };
  assert.deepEqual(diffCitationFields(saved, same), []);
  const newer = { ...saved, year: '2005', publisher: 'HUP', isbn: '9780674040441' };
  assert.deepEqual(diffCitationFields(saved, newer), ['publisher', 'year', 'isbn']);
  assert.deepEqual(diffCitationFields(null, newer), [], 'nothing to compare against when no citation is saved');
  // Accents and punctuation do not count as differences
  assert.deepEqual(diffCitationFields({ ...saved, authors: ['Kōhler, Wolfgang'] }, { ...saved, authors: ['Kohler, Wolfgang'] }), []);
});

const base = (over: Partial<BookCitation> = {}): BookCitation => ({
  title: 'Social Work Practice',
  authors: ['Adebayo, Tunde'],
  year: '2018',
  publisher: 'Sage',
  source: 'manual',
  retrievedAt: '',
  ...over,
});

test('ISBN, DOI and year checks catch typing mistakes and stay quiet on empty or valid values', () => {
  assert.equal(isValidIsbn('978-0-674-22457-5'), true);
  assert.equal(isValidIsbn('0-674-22457-4'), true);
  assert.equal(isValidIsbn('978-0-674-22457-4'), false);
  assert.equal(validateCitationField('isbn', ''), null);
  assert.equal(validateCitationField('isbn', '12345'), 'An ISBN has 10 or 13 digits.');
  assert.match(validateCitationField('isbn', '9780674224574') ?? '', /check digit/);
  assert.equal(validateCitationField('isbn', '9780674224575'), null);
  assert.equal(isValidDoi('https://doi.org/10.1191/1478088706qp063oa'), true);
  assert.equal(isValidDoi('doi 10.1191'), false);
  assert.match(validateCitationField('doi', 'nonsense') ?? '', /starts with 10\./);
  assert.equal(validateCitationField('year', '2006'), null);
  assert.equal(validateCitationField('year', 'n.d.'), null);
  assert.equal(validateCitationField('year', '06'), 'Use a four-digit year.');
  assert.equal(validateCitationField('year', '2999', new Date('2026-11-03')), 'Use a four-digit year.');
});

test('citationGaps lists what a reference in the chosen style would be missing', () => {
  assert.deepEqual(citationGaps(base(), 'apa'), []);
  assert.deepEqual(citationGaps(base({ publisher: undefined, year: undefined }), 'mla').map((g) => g.field), ['year', 'publisher']);
  const article = base({ type: 'article', container: 'Journal of Things', publisher: undefined });
  assert.deepEqual(citationGaps(article, 'apa').map((g) => g.field), ['volume', 'pages', 'doi']);
  assert.deepEqual(citationGaps(article, 'mla').map((g) => g.field), ['volume', 'pages'], 'MLA does not expect a DOI');
  assert.equal(citationGaps(article, 'apa').every((g) => !g.required), true);
  const chapter = base({ type: 'chapter', container: 'Handbook of Care', publisher: 'Oxford' });
  assert.deepEqual(citationGaps(chapter, 'apa').map((g) => g.field), ['pages', 'editors']);
  assert.deepEqual(citationGaps(chapter, 'vancouver').map((g) => g.field), ['pages']);
  assert.equal(citationGaps(base({ title: '', authors: [] }), 'apa')[0].required, true);
});

test('citationReview separates trustworthy citations from ones that need a look, with reasons', () => {
  assert.equal(citationReview(null).state, 'missing');
  assert.equal(citationReview(base()).state, 'matched');
  const embedded = citationReview(base({ source: 'embedded' }));
  assert.equal(embedded.state, 'review');
  assert.match(embedded.reasons[0], /not checked online/);
  const conflicted = citationReview(base({ source: 'enriched', confidence: 'high', conflicts: ['year', 'publisher'] }));
  assert.match(conflicted.reasons[0], /disagree on year, publisher/i);
  assert.match(citationReview(base({ retracted: true })).reasons[0], /retracted/);
  assert.match(citationReview(base({ source: 'enriched', confidence: 'low' })).reasons[0], /one independent source/);
  assert.match(citationReview(base({ publisher: undefined })).reasons[0], /Missing publisher/);
  assert.equal(citationReview(base({ source: 'enriched', confidence: 'high' })).state, 'matched');
});

test('duplicates: ISBN-10 and ISBN-13 match, DOIs ignore case, and title+author+year is the fallback', () => {
  assert.deepEqual(duplicateKeys(base({ isbn: '0-674-22457-4' })), ['isbn:9780674224575']);
  assert.deepEqual(duplicateKeys(base({ doi: 'https://doi.org/10.1191/ABC' })), ['doi:10.1191/abc']);
  assert.equal(duplicateKeys(base())[0].startsWith('work:social work practice|adebayo|2018'), true);
  assert.deepEqual(duplicateKeys(null), []);

  const files = [
    { id: 'a', citation: base({ isbn: '9780674224575' }) },
    { id: 'b', citation: base({ title: 'Other', isbn: '0674224574' }) },
    { id: 'c', citation: base({ title: 'Third', doi: '10.1/ABC'.replace('10.1/', '10.1234/') }) },
    { id: 'd', citation: base({ title: 'Third again', doi: '10.1234/abc' }) },
    { id: 'e', citation: undefined },
    { id: 'f', citation: base({ title: 'Unique', isbn: '9781234567897' }) },
  ];
  const { of, groups } = findDuplicates(files);
  assert.equal(of.get('b'), 'a');
  assert.equal(of.get('d'), 'c');
  assert.equal(of.has('f'), false);
  assert.equal(of.has('e'), false);
  assert.deepEqual(groups, [['a', 'b'], ['c', 'd']]);

  const store = Object.fromEntries(files.map((f) => [f.id, { id: f.id, name: `${f.id}.pdf`, citation: f.citation } as never]));
  assert.equal(findDuplicateOf(store, base({ isbn: '9780674224575' }), 'zzz')?.id, 'a');
  assert.equal(findDuplicateOf(store, base({ isbn: '9780674224575' }), 'a')?.id, 'b', 'the file itself is excluded');
  assert.equal(findDuplicateOf(store, base({ title: 'Nothing like it', isbn: '9780306406157' }), null), null);
});
