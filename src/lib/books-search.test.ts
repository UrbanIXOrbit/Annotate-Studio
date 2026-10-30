import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchLibrary } from './books-search.ts';

/**
 * Books search scopes: the picker in the header can search the viewed project,
 * a hand-picked subset, or the whole library. These tests pin the scoping
 * semantics, including folder membership and tag/note matching.
 */

const file = (id: string, name: string, extra: { tags?: string[]; notes?: string } = {}) => ({
  id,
  name,
  tags: extra.tags ?? [],
  notes: extra.notes ?? '',
});

const projects = [
  { id: 'p1', fileIds: ['a', 'b'] },
  { id: 'p2', fileIds: ['c'] },
  { id: 'p3', fileIds: [] },
];

const folders = [
  { projectId: 'p1', fileIds: ['d'] },
  { projectId: 'p2', fileIds: ['e'] },
  { projectId: 'p3', fileIds: ['f'] },
];

const files = [
  file('a', 'Algebra notes.pdf', { tags: ['math'] }),
  file('b', 'Biology chapter.epub'),
  file('c', 'Calculus primer.pdf'),
  file('d', 'Algebra worksheet.md', { notes: 'practice set' }),
  file('e', 'Chemistry lab.pdf'),
  file('f', 'Physics summary.txt'),
];

const ids = (scope: string | string[] | null, query: string) =>
  searchLibrary(files, projects, folders, query, scope).map((f) => f.id);

test('a single project id searches its root files and its folders only', () => {
  assert.deepEqual(ids('p1', 'algebra'), ['a', 'd']);
  assert.deepEqual(ids('p1', 'chapter'), ['b']);
  // "Chemistry lab" lives in p2 via a folder — invisible to a p1 search.
  assert.deepEqual(ids('p1', 'chem'), []);
});

test('an array of project ids searches the union of their trees', () => {
  assert.deepEqual(ids(['p1', 'p2'], 'algebra'), ['a', 'd']);
  assert.deepEqual(ids(['p1', 'p2'], 'lab'), ['e']);
  assert.deepEqual(ids(['p2', 'p3'], 'summary'), ['f']);
  assert.deepEqual(ids(['p1', 'p3'], 'chem'), []);
});

test('all projects (null) searches the whole library', () => {
  assert.deepEqual(ids(null, 'primer'), ['c']);
  assert.deepEqual(ids(null, 'lab'), ['e']);
  assert.deepEqual(ids(null, 'pdf'), ['a', 'c', 'e']);
});

test('an empty project list matches nothing', () => {
  assert.deepEqual(ids([], 'algebra'), []);
});

test('tags and notes participate in matching', () => {
  assert.deepEqual(ids('p1', 'math'), ['a']);
  assert.deepEqual(ids('p1', 'practice'), ['d']);
});

test('project ids are compared exactly — unknown ids are ignored', () => {
  assert.deepEqual(ids(['nope'], 'algebra'), []);
  assert.deepEqual(ids(['nope', 'p3'], 'summary'), ['f']);
});

test('results are sorted by name regardless of scope', () => {
  assert.deepEqual(
    searchLibrary(files, projects, folders, 'a', null).map((f) => f.name),
    [
      'Algebra notes.pdf',
      'Algebra worksheet.md',
      'Biology chapter.epub',
      'Calculus primer.pdf',
      'Chemistry lab.pdf',
      'Physics summary.txt',
    ],
  );
});
