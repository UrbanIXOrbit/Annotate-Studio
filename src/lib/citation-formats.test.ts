import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bibtexKey,
  CITATION_STYLES,
  formatCitation,
  renderExport,
  splitAuthor,
  toBibtex,
  toCslJson,
  toRis,
} from './citation-formats.ts';
import type { BookCitation } from '@/store/books';

const book: BookCitation = {
  title: 'War and Peace',
  authors: ['Tolstoy, Leo'],
  structuredAuthors: [{ family: 'Tolstoy', given: 'Leo' }],
  publisher: 'Penguin',
  city: 'London',
  year: '1869',
  edition: '2nd',
  isbn: '9780140449136',
  type: 'book',
  source: 'manual',
  retrievedAt: '2026-10-30T00:00:00.000Z',
};

const article: BookCitation = {
  title: 'Deep residual learning for image recognition',
  authors: ['He, Kaiming', 'Zhang, Shiming', 'Ren, Shiming', 'Sun, Jian'],
  structuredAuthors: [
    { family: 'He', given: 'Kaiming' },
    { family: 'Zhang', given: 'Shiming' },
    { family: 'Ren', given: 'Shiming' },
    { family: 'Sun', given: 'Jian' },
  ],
  container: 'Nature',
  volume: '521',
  pages: '436-444',
  year: '2015',
  doi: '10.1038/nature14539',
  type: 'article',
  source: 'enriched',
  retrievedAt: '2026-10-30T00:00:00.000Z',
};

test('splitAuthor handles inverted, natural, and particle names', () => {
  assert.deepEqual(splitAuthor('Tolstoy, Leo'), { family: 'Tolstoy', given: 'Leo' });
  assert.deepEqual(splitAuthor('Leo Tolstoy'), { family: 'Tolstoy', given: 'Leo' });
  assert.deepEqual(splitAuthor('Ursula K. Le Guin'), { family: 'Le Guin', given: 'Ursula K.' });
  assert.deepEqual(splitAuthor('Plato'), { family: 'Plato', given: '' });
});

test('Vancouver joined the style list', () => {
  assert.deepEqual(CITATION_STYLES.map((s) => s.id), ['apa', 'harvard', 'mla', 'chicago', 'vancouver']);
});

test('APA renders books and articles per the reference formatters', () => {
  assert.equal(
    formatCitation('apa', book),
    'Tolstoy, L. (1869). War and Peace (2nd ed.). Penguin.',
  );
  assert.equal(
    formatCitation('apa', article),
    'He, K., Zhang, S., Ren, S., & Sun, J. (2015). Deep residual learning for image recognition. Nature, 521, 436–444. https://doi.org/10.1038/nature14539',
  );
});

test('Harvard et-al-es from four authors', () => {
  assert.equal(formatCitation('harvard', book), 'Tolstoy, L. (1869) War and Peace. 2nd edn. Penguin.');
  assert.equal(
    formatCitation('harvard', article),
    'He, K. et al. (2015) ‘Deep residual learning for image recognition’, Nature, 521, pp. 436–444. https://doi.org/10.1038/nature14539',
  );
});

test('MLA renders quotes and volume/no keywords', () => {
  assert.equal(formatCitation('mla', book), 'Tolstoy, Leo. War and Peace. 2nd ed., Penguin, 1869.');
  assert.equal(
    formatCitation('mla', article),
    'He, Kaiming, et al. “Deep residual learning for image recognition.” Nature, vol. 521, 2015, pp. 436–444, https://doi.org/10.1038/nature14539.',
  );
});

test('Chicago author-date renders full author lists for small works', () => {
  assert.equal(formatCitation('chicago', book), 'Tolstoy, Leo. 1869. War and Peace. 2nd ed. Penguin.');
  assert.equal(
    formatCitation('chicago', article),
    'He, Kaiming, Shiming Zhang, Shiming Ren, and Jian Sun. 2015. “Deep residual learning for image recognition.” Nature 521: 436–444. https://doi.org/10.1038/nature14539',
  );
});

test('Vancouver abbreviates names and keeps the hyphen page range', () => {
  assert.equal(formatCitation('vancouver', book), 'Tolstoy L. War and Peace. 2nd ed. Penguin; 1869.');
  assert.equal(
    formatCitation('vancouver', article),
    'He K, Zhang S, Ren S, Sun J. Deep residual learning for image recognition. Nature. 2015;521:436-444. doi:10.1038/nature14539',
  );
});

test('chapters use editors and the container as book title', () => {
  const chapter: BookCitation = {
    ...article,
    type: 'chapter',
    container: 'The Cambridge Handbook',
    editors: ['Katz, Jerome'],
    publisher: 'Cambridge University Press',
    volume: undefined,
    doi: undefined,
    year: '2021',
  };
  assert.equal(
    formatCitation('apa', chapter),
    'He, K., Zhang, S., Ren, S., & Sun, J. (2021). Deep residual learning for image recognition. In J. Katz (Ed.), The Cambridge Handbook (pp. 436–444). Cambridge University Press.',
  );
});

test('BibTeX output folds diacritics into the key and inverts authors', () => {
  const entry = toBibtex({ ...book, structuredAuthors: [{ family: 'García Márquez', given: 'Gabriel' }], authors: ['García Márquez, Gabriel'] });
  assert.match(entry, /^@book\{garciamarquez1869peace,/);
  assert.match(entry, /author = \{García Márquez, Gabriel\}/);
  assert.match(entry, /title = \{\{War and Peace\}\}/);
  assert.equal(bibtexKey(book), 'tolstoy1869peace');
});

test('RIS output is a typed record with one AU line per author', () => {
  const ris = toRis([book, article]);
  assert.match(ris, /^TY  - BOOK\n/);
  assert.match(ris, /AU  - Tolstoy, Leo\n/);
  assert.match(ris, /TY  - JOUR\n/);
  assert.match(ris, /JO  - Nature\n/);
  assert.match(ris, /SP  - 436\nEP  - 444\n/);
  assert.match(ris, /DO  - 10\.1038\/nature14539\n/);
  assert.match(ris, /ER  - /);
});

test('CSL JSON emits structured author, issued and container fields', () => {
  const parsed = JSON.parse(toCslJson([article])) as {
    type: string;
    title: string;
    author: { family: string; given?: string }[];
    'container-title'?: string;
    issued?: { 'date-parts': number[][] };
    page?: string;
  }[];
  assert.equal(parsed[0].type, 'article-journal');
  assert.deepEqual(parsed[0].author[0], { family: 'He', given: 'Kaiming' });
  assert.equal(parsed[0]['container-title'], 'Nature');
  assert.deepEqual(parsed[0].issued, { 'date-parts': [[2015]] });
  assert.equal(parsed[0].page, '436-444');
});

test('renderExport joins formatted citations for text output', () => {
  const second: BookCitation = { ...book, title: 'Anna Karenina' };
  assert.equal(
    renderExport([book, second], 'txt', 'apa'),
    'Tolstoy, L. (1869). War and Peace (2nd ed.). Penguin.\n\nTolstoy, L. (1869). Anna Karenina (2nd ed.). Penguin.\n',
  );
  assert.match(renderExport([book], 'bib', 'apa'), /^@book\{/);
  assert.match(renderExport([book], 'ris', 'apa'), /^TY  - BOOK/);
  assert.match(renderExport([book], 'json', 'apa'), /^\[/);
});
