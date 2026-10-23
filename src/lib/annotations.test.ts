import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_GROUPS,
  buildReport,
  charIndicesInRects,
  countByGroup,
  escapeMarkdown,
  exportFileStem,
  filterEntries,
  groupByPage,
  indicesToRanges,
  joinSlices,
  normalizeColor,
  reportToMarkdown,
  sortEntries,
  type AnnotationEntry,
  type BookAnnotations,
} from './annotations.ts';

const entry = (over: Partial<AnnotationEntry>): AnnotationEntry => ({
  id: Math.random().toString(36).slice(2),
  page: 1,
  kind: 'highlight',
  text: '',
  comment: '',
  x: 0,
  y: 0,
  ...over,
});

// A line of ten 10pt-wide glyphs at y=100..112, then a second line at y=130..142.
const runs = [
  { charStart: 0, glyphs: Array.from({ length: 10 }, (_, i) => ({ x: 50 + i * 10, y: 100, width: 10, height: 12 })) },
  { charStart: 10, glyphs: Array.from({ length: 10 }, (_, i) => ({ x: 50 + i * 10, y: 130, width: 10, height: 12 })) },
];

test('charIndicesInRects selects glyphs whose centre lies inside the rectangle', () => {
  // Covers glyphs 2..5 on line one (x from 70 to 110).
  const hits = charIndicesInRects(runs, [{ origin: { x: 70, y: 99 }, size: { width: 40, height: 14 } }]);
  assert.deepEqual(hits, [2, 3, 4, 5]);
});

test('a rectangle that only clips the edge of a glyph does not select it', () => {
  // Starts at x=76: glyph 2 spans 70..80 (centre 75) so it is excluded, glyph 3 (centre 85) is included.
  const hits = charIndicesInRects(runs, [{ origin: { x: 76, y: 99 }, size: { width: 20, height: 14 } }]);
  assert.deepEqual(hits, [3, 4]);
});

test('multi-rectangle highlights spanning two lines collect both lines in order', () => {
  const hits = charIndicesInRects(runs, [
    { origin: { x: 120, y: 99 }, size: { width: 30, height: 14 } },
    { origin: { x: 50, y: 129 }, size: { width: 30, height: 14 } },
  ]);
  assert.deepEqual(hits, [7, 8, 9, 10, 11, 12]);
});

test('vertical tolerance absorbs a quad that is slightly off the text line', () => {
  const hits = charIndicesInRects(runs, [{ origin: { x: 50, y: 103 }, size: { width: 20, height: 8 } }]);
  assert.deepEqual(hits, [0, 1]);
  // But it never bleeds onto the next line 18pt below.
  assert.ok(!hits.includes(10));
});

test('indicesToRanges bridges tiny gaps and splits large ones', () => {
  assert.deepEqual(indicesToRanges([1, 2, 3, 5, 6]), [{ charIndex: 1, charCount: 6 }]);
  assert.deepEqual(indicesToRanges([1, 2, 3, 10, 11]), [
    { charIndex: 1, charCount: 3 },
    { charIndex: 10, charCount: 2 },
  ]);
  assert.deepEqual(indicesToRanges([]), []);
  assert.deepEqual(indicesToRanges([7]), [{ charIndex: 7, charCount: 1 }]);
});

test('joinSlices produces one clean quotation', () => {
  assert.equal(joinSlices(['Social plan-\r\nning is', ' a process.\u200b']), 'Social planning is a process.');
  assert.equal(joinSlices([]), '');
});

test('normalizeColor accepts hex forms and rejects junk', () => {
  assert.equal(normalizeColor('#FFCD45'), '#ffcd45');
  assert.equal(normalizeColor('FFCD45'), 'ffcd45'.replace(/^/, '#'));
  assert.equal(normalizeColor('#FFCD45CC'), '#ffcd45');
  assert.equal(normalizeColor('#fc4'), '#ffcc44');
  assert.equal(normalizeColor('red'), undefined);
  assert.equal(normalizeColor(42), undefined);
});

test('entries sort by page, then top-to-bottom, then left-to-right', () => {
  const sorted = sortEntries([
    entry({ id: 'c', page: 2, y: 10 }),
    entry({ id: 'b', page: 1, y: 300 }),
    entry({ id: 'a2', page: 1, y: 50, x: 200 }),
    entry({ id: 'a1', page: 1, y: 50, x: 20 }),
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['a1', 'a2', 'b', 'c']);
  const groups = groupByPage(sorted);
  assert.deepEqual(groups.map((g) => [g.page, g.entries.length]), [[1, 3], [2, 1]]);
});

test('filters by kind group and by text, comment, label or page', () => {
  const entries = [
    entry({ kind: 'highlight', text: 'Programme evaluation matters' }),
    entry({ kind: 'note', comment: 'Ask supervisor about EVALUATION', page: 4 }),
    entry({ kind: 'drawing', page: 9 }),
  ];
  assert.equal(filterEntries(entries, { groups: ALL_GROUPS, query: '' }).length, 3);
  assert.equal(filterEntries(entries, { groups: ALL_GROUPS, query: 'evaluation' }).length, 2);
  assert.equal(filterEntries(entries, { groups: { ...ALL_GROUPS, notes: false }, query: 'evaluation' }).length, 1);
  assert.equal(filterEntries(entries, { groups: ALL_GROUPS, query: 'page 9' }).length, 1);
  assert.equal(filterEntries(entries, { groups: ALL_GROUPS, query: 'drawing' }).length, 1);
  assert.deepEqual(countByGroup(entries), { highlights: 1, markup: 0, notes: 1, drawings: 1 });
});

const books: BookAnnotations[] = [
  { path: 'b10.pdf', title: 'Book 10.pdf', pageCount: 50, entries: [entry({ page: 3, text: 'ten', y: 1 })] },
  { path: 'empty.pdf', title: 'Empty.pdf', pageCount: 5, entries: [] },
  {
    path: 'b2.pdf',
    title: 'Book 2.pdf',
    pageCount: 90,
    entries: [
      entry({ page: 12, text: 'late', y: 5 }),
      entry({ page: 2, kind: 'note', comment: 'early note', y: 5 }),
      entry({ page: 2, text: 'early quote', comment: 'my comment', y: 1, color: '#ffcd45' }),
    ],
  },
];

test('report orders books naturally, pages ascending, and drops empty books', () => {
  const report = buildReport(books, { groups: ALL_GROUPS, query: '' }, 'All books', new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual(report.books.map((b) => b.title), ['Book 2.pdf', 'Book 10.pdf']);
  assert.equal(report.totalCount, 4);
  assert.deepEqual(report.books[0].pages.map((p) => p.page), [2, 12]);
  assert.deepEqual(report.books[0].pages[0].items.map((i) => i.text || i.comment), ['early quote', 'early note']);
});

test('markdown lists books, then pages, then annotations with comments', () => {
  const report = buildReport(books, { groups: ALL_GROUPS, query: '' }, 'All books', new Date('2026-10-15T10:00:00Z'));
  const md = reportToMarkdown(report);
  assert.match(md, /^# Annotations: All books\n/);
  assert.match(md, /\*Exported 15 October 2026 · 4 annotations from 2 books\*/);
  assert.ok(md.indexOf('## Book 2.pdf') < md.indexOf('## Book 10.pdf'));
  assert.ok(md.indexOf('### Page 2') < md.indexOf('### Page 12'));
  assert.match(md, /- \*\*Highlight\*\* — early quote\n  - \*\*Comment:\*\* my comment/);
  assert.match(md, /- \*\*Note\*\* — early note/);
  assert.ok(!md.includes('Empty.pdf'));
});

test('markdown escapes formatting characters and handles an empty report', () => {
  assert.equal(escapeMarkdown('a_b *c* [d]'), 'a\\_b \\*c\\* \\[d\\]');
  assert.equal(escapeMarkdown('# not a heading'), '\\# not a heading');
  assert.equal(escapeMarkdown('1. not a list'), '1\\. not a list');
  const empty = reportToMarkdown(buildReport([], { groups: ALL_GROUPS, query: '' }, 'X', new Date('2026-01-01T00:00:00Z')));
  assert.match(empty, /No annotations to export/);
});

test('export file stems are safe for every operating system', () => {
  assert.equal(exportFileStem('My Book: Vol/2?.pdf'), 'My Book Vol 2');
  assert.equal(exportFileStem('   '), 'Annotations');
});
