import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseCluster,
  authorsOverlap,
  cluster,
  detect,
  isbn13,
  mk,
  normTitle,
  parseName,
  recordMatch,
  sameWork,
  titleSimilarity,
  validIsbn,
} from './reference-lookup.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const retrieved = { retrievedAt: NOW }; // ignored by the engine — records carry no timestamps

function crossref(seed: Record<string, unknown>) {
  return mk('crossref', { type: 'article', ...seed });
}

test('detect classifies identifiers and validates ISBN check digits', () => {
  assert.deepEqual(detect('10.1191/1478088706qp063oa'), { kind: 'doi', id: '10.1191/1478088706qp063oa' });
  assert.equal(detect('https://doi.org/10.1038/nature14539.').id, '10.1038/nature14539');
  assert.equal(detect('978-0-674-22457-5').kind, 'isbn');
  assert.equal(detect('978-0-674-22457-5').invalid, false);
  assert.equal(detect('978-0-674-22457-6').invalid, true); // bad check digit
  assert.equal(detect('9780674224575').kind, 'isbn');
  assert.equal(detect('arXiv:1706.03762').kind, 'arxiv');
  assert.equal(detect('1706.03762').kind, 'arxiv');
  assert.equal(detect('PMID 11556941').kind, 'pmid');
  assert.equal(detect('pubmed.ncbi.nlm.nih.gov/11556941/').kind, 'pmid');
  assert.equal(detect('Bowling alone Putnam').kind, 'title');
});

test('validIsbn and isbn13 conversions', () => {
  assert.equal(validIsbn('9780674224575'), true);
  assert.equal(validIsbn('9780674224576'), false);
  assert.equal(validIsbn('0140449132'), true); // ISBN-10 twin of 9780140449136
  assert.equal(isbn13('0-14-044913-2'), '9780140449136');
  assert.equal(isbn13('9780140449136'), '9780140449136');
  assert.equal(isbn13('nope'), '');
});

test('parseName splits natural order, inverted order and particles', () => {
  assert.deepEqual(parseName('Tolstoy, Leo'), { family: 'Tolstoy', given: 'Leo' });
  assert.deepEqual(parseName('Leo Tolstoy'), { family: 'Tolstoy', given: 'Leo' });
  assert.deepEqual(parseName('Ursula K. Le Guin'), { family: 'Le Guin', given: 'Ursula K.' });
  assert.deepEqual(parseName('Vincent van Gogh'), { family: 'van Gogh', given: 'Vincent' });
  assert.deepEqual(parseName('Plato'), { family: 'Plato', given: '' });
});

test('title similarity ignores cosmetics and punishes real differences', () => {
  assert.equal(titleSimilarity('War and Peace', 'War  and PEACE'), 1);
  assert.ok(titleSimilarity('War and Peace', 'War and Peace: A Novel') >= 0.6);
  assert.ok(titleSimilarity('Deep Learning', 'Digestive Health') < 0.4);
  // Ligatures are not transliterated — they are treated as separators (matches the reference implementation).
  assert.equal(normTitle('Optimisation of æronautics'), 'optimisation of ronautics');
});

test('author overlap uses family names with substring tolerance', () => {
  const a = [{ family: 'He', given: 'Kaiming' }, { family: 'Zhang', given: 'Shiming' }];
  const b = [{ family: 'He', given: 'K.' }, { family: 'Zhang', given: 'S.' }, { family: 'Sun', given: 'J.' }];
  assert.equal(authorsOverlap(a, b), 1);
  const other = [{ family: 'Vaswani', given: 'A.' }];
  assert.equal(authorsOverlap(a, other), 0);
  assert.equal(authorsOverlap([], other), -1);
});

test('sameWork keeps errata and supplements apart', () => {
  const paper = crossref({ title: 'Attention is all you need', authors: [{ family: 'Vaswani', given: 'Ashish' }], year: 2017 });
  const copy = crossref({ title: 'Attention Is All You Need!', authors: [{ family: 'Vaswani', given: 'A.' }], year: 2017 });
  assert.equal(sameWork(paper, copy), true);

  const erratum = crossref({ title: 'Attention is all you need: erratum', authors: [{ family: 'Vaswani', given: 'A.' }], year: 2018 });
  assert.equal(sameWork(paper, erratum), false);

  const different = crossref({ title: 'Attention is all you need, revisited', authors: [{ family: 'Smith', given: 'J.' }], year: 2019 });
  assert.equal(sameWork(paper, different), false);
});

test('cluster groups records that share a DOI and agree on the title', () => {
  const a = crossref({ title: 'Deep residual learning for image recognition', doi: '10.1038/nature14539', year: 2015 });
  const b = mk('openalex', { type: 'article', title: 'Deep Residual Learning for Image Recognition', doi: '10.1038/NATURE14539', year: 2015 });
  const c = crossref({ title: 'Deep learning', doi: '10.1038/nature14541', year: 2015 });
  const groups = cluster([a, b, c]);
  assert.equal(groups.length, 2);
  const grouped = groups.find((g) => g.length === 2);
  assert.ok(grouped, 'the two same-DOI records are one group');
});

test('analyseCluster separates versions and merges fields from the most reliable source', () => {
  const records = [
    crossref({ title: 'War and Peace', doi: '10.1093/oxford/978.x', year: 1869, publisher: 'Oxford University Press', authors: [{ family: 'Tolstoy', given: 'Leo' }] }),
    mk('openlibrary', { type: 'book', title: 'War and Peace', year: 1869, publisher: 'Penguin', isbn: '9780140449136' }),
    mk('googlebooks', { type: 'book', title: 'War and Peace', year: 1869, publisher: 'Vintage' }),
  ];
  const { versions, chosen, rec } = analyseCluster(records);
  assert.ok(versions.length >= 1);
  assert.equal(rec.title, 'War and Peace');
  assert.equal(rec.publisher, 'Oxford University Press'); // crossref wins publisher
  assert.equal(rec.isbn, '9780140449136'); // openlibrary supplies the ISBN
  assert.equal(chosen, 0);
  assert.equal(versions[chosen].status, 'published');
});

test('disagreements between trustworthy sources are flagged as conflicts', () => {
  const records = [
    crossref({ title: 'A study', doi: '10.1/study', year: 1869, publisher: 'A Press' }),
    mk('datacite', { type: 'book', title: 'A study', doi: '10.1/study', year: 1868, publisher: 'B Press' }),
  ];
  const { rec } = analyseCluster(records);
  const fields = (rec.conflicts ?? []).map((c) => c.field);
  assert.ok(fields.includes('year'));
  const yearConflict = (rec.conflicts ?? []).find((c) => c.field === 'year');
  assert.deepEqual(yearConflict?.values.map((v) => v.value).sort(), ['1868', '1869']);
});

test('confidence reflects how many independent evidence groups cross-checked', () => {
  const solo = analyseCluster([crossref({ title: 'Solo work', doi: '10.1/solo', year: 2000 })]);
  assert.equal(solo.rec.confidence, 'low');

  // Crossref+OpenAlex collapse into one "registry" group; a third independent
  // group needs a non-registry source.
  const trio = analyseCluster([
    crossref({ title: 'Cross-checked work', doi: '10.1/cc', year: 2000 }),
    mk('openlibrary', { type: 'book', title: 'Cross-checked work', year: 2000, isbn: '9780140449136' }),
    mk('pubmed', { type: 'article', title: 'Cross-checked work', year: 2000, pmid: '11556941' }),
  ]);
  assert.equal(trio.rec.confidence, 'high');
  assert.equal(trio.rec.nSources, 3);
});

test('recordMatch scores full titles above partial hints and rejects unrelated ones', () => {
  const r = crossref({ title: 'Bowling alone: the collapse and revival of American community', year: 2000, authors: [{ family: 'Putnam', given: 'Robert' }] });
  assert.ok(recordMatch(r, 'Bowling Alone') >= 0.45);
  assert.ok(recordMatch(r, 'Bowling alone: the collapse and revival of American community') >= 0.9);
  assert.ok(recordMatch(r, 'The theory of monetary economics') < 0.3);
});
