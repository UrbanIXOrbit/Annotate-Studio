import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseCluster,
  API,
  failedSourceKeys,
  retryFailedSources,
  summarizeProgress,
  setGoogleBooksApiKey,
  setPoliteness,
  statusFromFetchError,
  lookupLine,
  NotFoundError,
  type SourceProgress,
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

/* ---------- Network behaviour (fetch is stubbed; nothing touches the network) ---------- */

setPoliteness({ throttle: false, backoff: [1, 1] });

type Stub = { status: number; body?: unknown };

async function withFetch(handler: (url: URL) => Stub, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const r = handler(new URL(String(input)));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

const ATTENTION_DATACITE = {
  data: {
    id: '10.48550/arxiv.1706.03762',
    attributes: {
      doi: '10.48550/arxiv.1706.03762',
      titles: [{ title: 'Attention Is All You Need' }],
      creators: [{ nameType: 'Personal', givenName: 'Ashish', familyName: 'Vaswani', name: 'Vaswani, Ashish' }],
      publisher: 'arXiv',
      publicationYear: 2017,
      types: { resourceTypeGeneral: 'Preprint' },
      identifiers: [{ identifier: '1706.03762', identifierType: 'arXiv' }],
    },
  },
};

test('DataCite DOI lookup unwraps the data envelope instead of parsing a blank record', async () => {
  await withFetch(() => ({ status: 200, body: ATTENTION_DATACITE }), async () => {
    const [rec] = await API.datacite.doi('10.48550/arXiv.1706.03762');
    assert.equal(rec.title, 'Attention Is All You Need');
    assert.equal(rec.type, 'preprint');
    assert.equal(rec.arxiv, '1706.03762');
    assert.equal(rec.authors[0].family, 'Vaswani');
  });
  await withFetch(() => ({ status: 200, body: {} }), async () => {
    await assert.rejects(() => API.datacite.doi('10.1234/none'), NotFoundError);
  });
});

test('a 404 means "no record", not a failed source', async () => {
  await withFetch(() => ({ status: 404, body: {} }), async () => {
    await assert.rejects(() => API.crossref.doi('10.1234/none'), NotFoundError);
    const en = await lookupLine('10.1234/none');
    assert.equal(en.status, 'error');
    assert.equal(en.error, 'No source has a record for this.');
    for (const p of Object.values(en.progress)) assert.deepEqual(p.errors, []);
  });
});

test('lookupLine reports per-source progress as it goes and the final state at the end', async () => {
  const snapshots: Record<string, SourceProgress>[] = [];
  await withFetch(
    (url) => (url.host === 'api.datacite.org' ? { status: 200, body: ATTENTION_DATACITE } : { status: 404, body: {} }),
    async () => {
      const en = await lookupLine('10.48550/arXiv.1706.03762', { onProgress: (p) => snapshots.push(p) });
      assert.equal(en.status, 'ok');
      assert.equal(en.rec?.title, 'Attention Is All You Need');
      assert.equal(en.rec?.type, 'preprint');
      assert.ok(snapshots.length >= 2, 'progress is reported more than once');
      assert.ok(Object.values(snapshots[0]).some((p) => p.pending > 0), 'the first snapshot has sources still checking');
      const last = snapshots[snapshots.length - 1];
      assert.ok(Object.values(last).every((p) => p.pending === 0), 'nothing is left checking at the end');
      assert.ok(last.datacite.found >= 1);
      assert.ok(last.crossref.none >= 1 && last.crossref.errors.length === 0);
    },
  );
});

test('a rate-limited source is shown as an error while the others still answer', async () => {
  await withFetch(
    (url) => (url.host === 'api.datacite.org' ? { status: 200, body: ATTENTION_DATACITE } : url.host === 'api.semanticscholar.org' ? { status: 429, body: {} } : { status: 404, body: {} }),
    async () => {
      const en = await lookupLine('10.48550/arXiv.1706.03762');
      assert.equal(en.status, 'ok');
      assert.ok(en.progress.semanticscholar.errors.some((m) => /rate-limiting/.test(m)));
      assert.equal(en.progress.crossref.errors.length, 0);
    },
  );
});

test('when versions tie on status, the one backed by more records is chosen', () => {
  const doiA = mk('crossref', { type: 'article', title: 'A study', doi: '10.1/a', year: 2020, container: 'Journal A' });
  const doiB1 = mk('crossref', { type: 'article', title: 'A study', doi: '10.1/b', year: 2020, container: 'Journal B' });
  const doiB2 = mk('pubmed', { type: 'article', title: 'A study', doi: '10.1/b', year: 2020, container: 'Journal B', pmid: '1' });
  const { versions, chosen } = analyseCluster([doiA, doiB1, doiB2]);
  assert.equal(versions.length, 2);
  assert.equal(versions[chosen].records.length, 2);
});

/* ---------- Title searches for books: every edition is its own choice ---------- */

function isbn13From(prefix12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(prefix12[i]) * (i % 2 ? 3 : 1);
  return prefix12 + ((10 - (sum % 10)) % 10);
}

test('a title search lists each edition of a book separately instead of merging them', async () => {
  const title = 'The Ecology of Human Development';
  const a = isbn13From('978067422457'), c = isbn13From('978067404044'), d = isbn13From('978067411551');
  const author = 'Urie Bronfenbrenner';
  const bodies: Record<string, unknown> = {
    'openlibrary.org': {
      docs: [
        { title, author_name: [author], first_publish_year: 1979, publisher: ['Harvard University Press'], isbn: [a] },
        { title, author_name: [author], first_publish_year: 1979, publisher: ['Harvard University Press'], isbn: [c] },
      ],
    },
    'www.googleapis.com': {
      items: [
        { volumeInfo: { title, authors: [author], publisher: 'Harvard University Press', publishedDate: '1979', industryIdentifiers: [{ identifier: a }] } },
        { volumeInfo: { title, authors: [author], publisher: 'Harvard University Press', publishedDate: '2005', industryIdentifiers: [{ identifier: c }] } },
        { volumeInfo: { title, authors: [author], publisher: 'Harvard University Press', publishedDate: '1996', industryIdentifiers: [{ identifier: d }] } },
      ],
    },
  };
  await withFetch(
    (url) => (url.host in bodies ? { status: 200, body: bodies[url.host] } : { status: 200, body: { message: { items: [] }, results: [], resultList: { result: [] }, data: [] } }),
    async () => {
      const en = await lookupLine(`${title} Bronfenbrenner`);
      assert.equal(en.status, 'choose', 'several editions: the user chooses, nothing is applied silently');
      const years = en.cands.map((c) => c.rec.year).sort();
      assert.deepEqual(years, ['1979', '1996', '2005']);
      // The 2005 edition keeps its own year even though Open Library only knows the first-publication year.
      const edition2005 = en.cands.find((c) => c.rec.year === '2005')!;
      assert.equal(edition2005.rec.isbn, c);
      assert.equal(edition2005.rec.note, '');
    },
  );
});

test('an ISBN lookup still resolves to the one edition it names', async () => {
  const title = 'Social Work Practice';
  const isbn = isbn13From('978019876543');
  await withFetch(
    (url) =>
      url.host === 'openlibrary.org'
        ? { status: 200, body: { [`ISBN:${isbn}`]: { title, authors: [{ name: 'Tunde Adebayo' }], publish_date: '2018', publishers: [{ name: 'Sage' }] } } }
        : { status: 404, body: {} },
    async () => {
      const en = await lookupLine(isbn);
      assert.equal(en.status, 'ok');
      assert.equal(en.rec?.year, '2018');
      assert.equal(en.cands.length, 1);
    },
  );
});

/* ---------- Rate-limited sources ---------- */

test('the desktop fetcher\'s error text is turned back into an HTTP status', () => {
  assert.equal(
    statusFromFetchError('The page returned an error: HTTP status client error (429 Too Many Requests) for url (https://api.semanticscholar.org/x)'),
    429,
  );
  assert.equal(statusFromFetchError('The page returned an error: HTTP status client error (404 Not Found) for url (https://a/b)'), 404);
  assert.equal(statusFromFetchError('Could not fetch this page: error sending request'), null);
});

test('Semantic Scholar is retried after a 429 and succeeds on the next attempt', async () => {
  setPoliteness({ throttle: false, backoff: [1, 1] });
  let calls = 0;
  await withFetch(
    () => (++calls < 3 ? { status: 429, body: {} } : { status: 200, body: { title: 'A study', year: 2020, authors: [{ name: 'Ada Lovelace' }], externalIds: { DOI: '10.1234/study' } } }),
    async () => {
      const [rec] = await API.semanticscholar.lookup('DOI:10.1234/study');
      assert.equal(rec.title, 'A study');
      assert.equal(calls, 3);
    },
  );
});

test('a source that keeps answering 429 ends as a rate-limit error, not a missing record', async () => {
  setPoliteness({ throttle: false, backoff: [1, 1] });
  await withFetch(() => ({ status: 429, body: {} }), async () => {
    await assert.rejects(() => API.semanticscholar.lookup('DOI:10.1234/study'), /rate-limiting/);
  });
});

test('Google Books sends the API key when one is set, and reports a quota refusal clearly', async () => {
  setPoliteness({ throttle: false, backoff: [1] });
  setGoogleBooksApiKey('test-key');
  const seen: string[] = [];
  await withFetch(
    (url) => {
      seen.push(url.searchParams.get('key') ?? '');
      return { status: 403, body: {} };
    },
    async () => {
      await assert.rejects(() => API.googlebooks.search('anything'), /refused the request \(403\)/);
    },
  );
  assert.deepEqual(seen, ['test-key']);
  setGoogleBooksApiKey('');
});

/* ---------- Summary line and retrying only the failed sources ---------- */

test('summarizeProgress describes the whole lookup in one sentence', () => {
  const p = (found: number, none: number, errors: string[] = [], pending = 0): SourceProgress => ({ found, none, errors, pending });
  const done = summarizeProgress({
    crossref: p(1, 0),
    openalex: p(1, 0),
    datacite: p(0, 1),
    europepmc: p(0, 1),
    semanticscholar: p(0, 0, ['The online catalogue is rate-limiting requests — try again in a few minutes.']),
  });
  assert.equal(done.text, 'Checked 5 sources — 2 found a record, 2 had none; Semantic Scholar was rate-limited.');
  assert.deepEqual(done.failed.map((f) => f.key), ['semanticscholar']);
  const running = summarizeProgress({ crossref: p(1, 0), openalex: p(0, 0, [], 1) });
  assert.equal(running.text, 'Checking 1 of 2 sources…');
  assert.equal(summarizeProgress({}).text, '');
  assert.equal(summarizeProgress({ crossref: p(1, 0) }).text, 'Checked 1 source — 1 found a record.');
});

test('retrying failed sources asks only those sources and keeps what the others returned', async () => {
  setPoliteness({ throttle: false, backoff: [1, 1] });
  const crossrefBody = {
    message: {
      type: 'journal-article',
      title: ['A study of things'],
      author: [{ given: 'Ada', family: 'Lovelace' }],
      'container-title': ['Journal of Things'],
      DOI: '10.1234/study',
      'published-print': { 'date-parts': [[2020]] },
    },
  };
  const s2Body = { title: 'A study of things', year: 2020, authors: [{ name: 'Ada Lovelace' }], externalIds: { DOI: '10.1234/study' } };
  let en!: Awaited<ReturnType<typeof lookupLine>>;
  await withFetch(
    (url) => (url.host === 'api.crossref.org' ? { status: 200, body: crossrefBody } : url.host === 'api.semanticscholar.org' ? { status: 429, body: {} } : { status: 404, body: {} }),
    async () => {
      en = await lookupLine('10.1234/study');
    },
  );
  assert.equal(en.status, 'ok');
  assert.deepEqual(failedSourceKeys(en.progress), ['semanticscholar']);

  const hosts = new Set<string>();
  await withFetch(
    (url) => {
      hosts.add(url.host);
      return url.host === 'api.semanticscholar.org' ? { status: 200, body: s2Body } : { status: 404, body: {} };
    },
    async () => {
      await retryFailedSources(en);
    },
  );
  assert.deepEqual([...hosts], ['api.semanticscholar.org'], 'only the failed source is asked again');
  assert.equal(en.status, 'ok');
  assert.equal(en.progress.semanticscholar.found, 1);
  assert.deepEqual(en.progress.semanticscholar.errors, []);
  assert.ok(en.progress.crossref.found >= 1, 'the earlier answers are kept');
  assert.ok(en.rec?.sources.includes('Semantic Scholar') && en.rec.sources.includes('Crossref'));
  assert.deepEqual(failedSourceKeys(en.progress), []);
  // Nothing failed any more: a second retry is a no-op
  assert.equal(await retryFailedSources(en), en);
});
