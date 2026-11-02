import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSearchTitle,
  doiFromFilename,
  isCitationCapable,
  parseCitationInput,
} from './book-citations.ts';

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
