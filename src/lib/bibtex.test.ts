import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBibtex } from './bibtex.ts';

const SAMPLE = String.raw`% comment line
@Comment{this is ignored}
@String{acme = "Acme Press"}

@article{kandel2012principles,
  author  = {Kandel, Eric R. and Squire, Larry R."},
  title   = {Principles of {Neural Science}},
  journal = {Neuron},
  year    = 2012,
  volume  = "74",
  pages   = {12--30},
  doi     = {10.1234/neuron.2012}
}

@book{kahneman2011,
  author    = {Kahneman, Daniel},
  title     = "Thinking, {Fast} and {Slow}",
  publisher = acme,
  address   = {New York},
  year      = 2011,
  month     = oct
}

@InCollection{friston2010,
  author    = {Friston, Karl},
  title     = {The free-energy principle},
  booktitle = {Attention and Brain},
  editor    = {Helmholtz, Hermann von},
  pages     = {5--9},
  year      = {2010}
}`;

test('parseBibtex reads Zotero-shaped entries, skipping comments and macros', () => {
  const result = parseBibtex(SAMPLE);
  assert.equal(result.entries.length, 3);
  assert.equal(result.duplicates, 0);
  assert.equal(result.malformed, 0);

  const [article, book, chapter] = result.entries;
  assert.equal(article.key, 'kandel2012principles');
  assert.equal(article.type, 'article');
  assert.equal(article.fields.title, 'Principles of {Neural Science}');
  assert.equal(article.fields.journal, 'Neuron');
  assert.equal(article.fields.year, '2012');
  assert.equal(article.fields.pages, '12--30');

  assert.equal(book.type, 'book');
  // @string macro and month macro both resolve.
  assert.equal(book.fields.publisher, 'Acme Press');
  assert.equal(book.fields.month, '10');
  // Quoted value with braces inside survives.
  assert.equal(book.fields.title, 'Thinking, {Fast} and {Slow}');

  assert.equal(chapter.type, 'incollection');
  assert.equal(chapter.fields.editor, 'Helmholtz, Hermann von');
});

test('parseBibtex handles nested braces and CRLF input', () => {
  const result = parseBibtex("@book{a,\r\n title = {The {\\emph {deep}} {nested {brace}} test},\r\n year = {2001},\r\n}");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].fields.title, 'The {\\emph {deep}} {nested {brace}} test');
  assert.equal(result.entries[0].fields.year, '2001');
});

test('parseBibtex dedupes keys and counts malformed entries', () => {
  const result = parseBibtex(
    '@article{same, title={One}}\n@Article{SAME, title={Two}}\n@book{broken, title = {never closed',
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].fields.title, 'One');
  assert.equal(result.duplicates, 1);
  assert.equal(result.malformed, 1);
});

test('parseBibtex joins # concatenation', () => {
  const result = parseBibtex('@misc{c, note = {"see " # "page " # {12}}\n}');
  assert.equal(result.entries[0].fields.note, 'see page 12');
});
