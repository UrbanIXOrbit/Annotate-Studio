import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnippet, searchDocs, tokenize, type SearchDoc } from './global-search.ts';

const doc = (overrides: Partial<SearchDoc>): SearchDoc => ({
  path: 'a.md',
  kind: 'note',
  title: 'Lecture notes',
  text: '',
  ...overrides,
});

test('tokenize splits words and keeps quoted phrases', () => {
  assert.deepEqual(tokenize('  memory   consolidation '), ['memory', 'consolidation']);
  assert.deepEqual(tokenize('"hippocampal replay" sleep'), ['hippocampal replay', 'sleep']);
  assert.deepEqual(tokenize('   '), []);
});

test('searchDocs requires every term to match', () => {
  const docs = [
    doc({ path: 'a', title: 'Memory consolidation', text: 'Sleep consolidates memory.' }),
    doc({ path: 'b', title: 'Sleep diary', text: 'I slept eight hours.' }),
  ];
  const hits = searchDocs(docs, 'sleep memory');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'a');
});

test('title matches outrank body matches', () => {
  const docs = [
    doc({ path: 'body', title: 'Random', text: 'mentions dopamine once' }),
    doc({ path: 'title', title: 'Dopamine', text: 'something else entirely' }),
  ];
  const [first] = searchDocs(docs, 'dopamine');
  assert.equal(first.path, 'title');
});

test('exact phrase scores higher than scattered terms', () => {
  const docs = [
    doc({ path: 'phrase', title: 'Paper', text: 'spaced repetition improves retention' }),
    doc({ path: 'scattered', title: 'Zebra', text: 'retention later, then spaced, then repetition' }),
  ];
  const [first] = searchDocs(docs, 'spaced repetition');
  assert.equal(first.path, 'phrase');
});

test('buildSnippet centres the excerpt on the first match and marks ranges', () => {
  const text = `Intro sentence.\n${'filler '.repeat(30)}KEY finding here.${'more '.repeat(30)}`;
  const { snippet, highlight } = buildSnippet(text, ['key']);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.includes('KEY finding'));
  const highlighted = snippet.slice(highlight[0].start, highlight[0].end);
  assert.equal(highlighted, 'KEY');
});

test('buildSnippet falls back to the start of the text without a match', () => {
  const { snippet, highlight } = buildSnippet('Nothing relevant here', ['zzz']);
  assert.equal(snippet, 'Nothing relevant here');
  assert.deepEqual(highlight, []);
});

test('meta-only matches still produce hits with meta snippets', () => {
  const docs = [doc({ path: 'card', title: 'Highlight card', text: 'unrelated body', meta: 'comment about amygdala' })];
  const [hit] = searchDocs(docs, 'amygdala');
  assert.ok(hit);
  assert.ok(hit.snippet.toLowerCase().includes('amygdala'));
});

test('results are capped and sorted by score', () => {
  const docs = Array.from({ length: 60 }, (_, index) =>
    doc({ path: `d${index}`, title: `Doc ${index}`, text: 'common word', locator: index % 2 === 0 ? { page: 1 } : undefined }),
  );
  const hits = searchDocs(docs, 'common');
  assert.equal(hits.length, 40);
  assert.ok(hits[0].score >= hits[hits.length - 1].score);
});

test('empty query matches nothing', () => {
  assert.deepEqual(searchDocs([doc({ text: 'anything' })], '   '), []);
});
