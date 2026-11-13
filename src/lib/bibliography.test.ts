import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderBibliography,
  renderBibliography,
  resolveBibliographyEntries,
  type BibliographyEntry,
  type BibliographyFile,
} from './bibliography.ts';
import type { BookCitation } from '../store/books.ts';

const cite = (title: string, authors: string[] = [], year?: string): BookCitation => ({
  title,
  authors,
  ...(year ? { year } : {}),
  source: 'manual',
  retrievedAt: new Date().toISOString(),
});

const file = (name: string, citation?: BookCitation): BibliographyFile => ({ name, citation });

const entry = (overrides: Partial<BibliographyEntry> & { id: string }): BibliographyEntry => ({
  included: true,
  ...overrides,
});

test('resolveBibliographyEntries uses the live citation of library files', () => {
  const files = { f1: file('paper.epub', cite('Kandel', ['Kandel, Eric'], '2012')) };
  const [resolved] = resolveBibliographyEntries(files, [entry({ id: 'a', fileId: 'f1' })]);
  assert.equal(resolved.citation?.title, 'Kandel');
  assert.equal(resolved.label, 'paper.epub');
  assert.equal(resolved.missing, false);
});

test('file entries whose file is gone are flagged missing, not dropped', () => {
  const [resolved] = resolveBibliographyEntries({}, [entry({ id: 'a', fileId: 'gone' })]);
  assert.equal(resolved.missing, true);
  assert.equal(resolved.citation, null);
  assert.equal(resolved.label, 'Missing source');
});

test('manual entries carry their own record and are never missing', () => {
  const [resolved] = resolveBibliographyEntries({}, [entry({ id: 'a', manual: cite('A brief history') })]);
  assert.equal(resolved.missing, false);
  assert.equal(resolved.citation?.title, 'A brief history');
});

test('later entries describing the same work are marked as duplicates', () => {
  const files = {
    f1: file('a.pdf', cite('Same work', ['Smith, John'], '2001')),
    f2: file('b.pdf', cite('Same work', ['Smith, John'], '2001')),
  };
  const entries = [entry({ id: 'a', fileId: 'f1' }), entry({ id: 'b', fileId: 'f2' })];
  const [first, second] = resolveBibliographyEntries(files, entries);
  assert.equal(first.duplicateOfId, undefined);
  assert.equal(second.duplicateOfId, 'a');
});

test('author–date styles sort alphabetically by first author, omitted rows are excluded', () => {
  const resolved = resolveBibliographyEntries(
    {
      f1: file('b', cite('Zebra book', ['Adams, Bob'], '2001')),
      f2: file('a', cite('Apple paper', ['Carter, Ann'], '2003')),
      f3: file('c', cite('Middle', ['Brown, Cal'], '2002')),
    },
    [entry({ id: '1', fileId: 'f1' }), entry({ id: '2', fileId: 'f2' }), entry({ id: '3', fileId: 'f3' }), entry({ id: '4', fileId: 'f3', included: false })],
  );
  const ordered = orderBibliography(resolved, 'apa');
  assert.deepEqual(ordered.map((item) => item.citation?.title), ['Zebra book', 'Middle', 'Middle', 'Apple paper']);
});

test('vancouver keeps the entry (first-cited) order', () => {
  const files = {
    f1: file('b', cite('Zebra', ['Adams'], '2001')),
    f2: file('a', cite('Apple', ['Carter'], '2003')),
  };
  const resolved = resolveBibliographyEntries(files, [entry({ id: '1', fileId: 'f2' }), entry({ id: '2', fileId: 'f1' })]);
  const ordered = orderBibliography(resolved, 'vancouver');
  assert.deepEqual(ordered.map((item) => item.citation?.title), ['Apple', 'Zebra']);
});

test('renderBibliography skips duplicates and missing citations, renders every format', () => {
  const files = {
    f1: file('a.pdf', cite('Same work', ['Smith'], '2001')),
    f2: file('b.pdf', cite('Same work', ['Smith'], '2001')),
    f3: file('c.pdf'),
  };
  const resolved = resolveBibliographyEntries(files, [
    entry({ id: '1', fileId: 'f1' }),
    entry({ id: '2', fileId: 'f2' }),
    entry({ id: '3', fileId: 'f3' }),
  ]);
  const rendered = renderBibliography(resolved, 'apa');
  assert.equal(rendered.citations.length, 1);
  assert.ok(rendered.text.includes('Same work'));

  const bibtex = renderBibliography(resolved, 'apa', 'bib');
  assert.match(bibtex.text, /@book\{|@article\{|@misc\{/);
  assert.equal(bibtex.html, '');
});
