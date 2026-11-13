import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allTags,
  collectionFileIds,
  matchFile,
  normalizeTags,
  parseTagInput,
  removeTagFromMetas,
  renameTagInMetas,
  tagUsageCount,
  type FileMeta,
} from './library-metadata.ts';

const file = (name: string, file_type = 'pdf') => ({ name, file_type });

test('normalizeTags trims, dedupes case-insensitively and caps count', () => {
  assert.deepEqual(normalizeTags([' Neuroscience ', 'neuroscience', 'memory consolidation', '', 'NEUROSCIENCE']), [
    'Neuroscience',
    'memory consolidation',
  ]);
  assert.deepEqual(normalizeTags(Array.from({ length: 30 }, (_, i) => `tag${i}`)).length, 24);
  assert.deepEqual(normalizeTags(['x'.repeat(60)]), ['x'.repeat(40)]);
});

test('parseTagInput splits on commas', () => {
  assert.deepEqual(parseTagInput('sleep, memory, sleep'), ['sleep', 'memory']);
  assert.deepEqual(parseTagInput('  '), []);
});

test('matchFile filters by type, star and required tags', () => {
  const meta: FileMeta = { tags: ['Neuroscience', 'exam'], starred: true };
  const paper = file('Kandel - Memory.pdf');
  assert.equal(matchFile(paper, meta, { fileTypes: ['pdf'] }), true);
  assert.equal(matchFile(paper, meta, { fileTypes: ['note'] }), false);
  assert.equal(matchFile(paper, meta, { starred: true }), true);
  assert.equal(matchFile(paper, { tags: ['exam'] }, { starred: true }), false);
  assert.equal(matchFile(paper, meta, { tags: ['neuroscience', 'exam'] }), true);
  assert.equal(matchFile(paper, meta, { tags: ['neuroscience', 'sleep'] }), false);
});

test('matchFile requires every query word across name, tags and note', () => {
  const meta: FileMeta = { tags: ['exam'], note: 'review before finals' };
  const paper = file('Kandel - Memory.pdf');
  assert.equal(matchFile(paper, meta, { query: 'kandel' }), true);
  assert.equal(matchFile(paper, meta, { query: 'kandel finals' }), true);
  assert.equal(matchFile(paper, meta, { query: 'kandel missing' }), false);
  assert.equal(matchFile(paper, undefined, { query: 'kandel' }), true);
});

test('collectionFileIds evaluates live and returns matching paths', () => {
  const files = [file('A.pdf'), file('B.pdf'), file('C.md', 'note')];
  const metas: Record<string, FileMeta> = { '/a': { tags: ['core'], starred: true } };
  const ids = collectionFileIds(files, metas, ['/a', '/b', '/c'], { tags: ['core'] });
  assert.deepEqual(ids, ['/a']);
});

test('allTags counts usage across files and sorts by frequency', () => {
  const metas: Record<string, FileMeta> = {
    a: { tags: ['exam', 'Core'] },
    b: { tags: ['exam', 'core', 'sleep'] },
  };
  // exam and core tie at two uses, so they order alphabetically; the display
  // spelling of the first occurrence wins.
  assert.deepEqual(allTags(metas), ['Core', 'exam', 'sleep']);
});

test('renameTagInMetas renames everywhere, case-insensitively, keeping display spelling', () => {
  const metas: Record<string, FileMeta> = {
    a: { tags: ['Exam', 'core'] },
    b: { tags: ['exam'], starred: true },
    c: { tags: ['sleep'], note: 'other' },
  };
  const next = renameTagInMetas(metas, 'exam', 'finals');
  assert.deepEqual(next.a, { tags: ['finals', 'core'] });
  assert.deepEqual(next.b, { tags: ['finals'], starred: true });
  assert.deepEqual(next.c, { tags: ['sleep'], note: 'other' });
  assert.equal(tagUsageCount(next, 'EXAM'), 0);
  assert.equal(tagUsageCount(next, 'Finals'), 2);
  // An empty replacement is a no-op.
  assert.equal(renameTagInMetas(metas, 'exam', '  '), metas);
});

test('removeTagFromMetas drops the tag and prunes now-empty records', () => {
  const metas: Record<string, FileMeta> = {
    a: { tags: ['exam'] },
    b: { tags: ['exam', 'core'], note: 'keep me' },
    c: { tags: ['sleep'], starred: true },
  };
  const next = removeTagFromMetas(metas, 'EXAM');
  assert.equal('a' in next, false);
  assert.deepEqual(next.b, { tags: ['core'], note: 'keep me' });
  assert.deepEqual(next.c, { tags: ['sleep'], starred: true });
  assert.equal(tagUsageCount(next, 'exam'), 0);
});
