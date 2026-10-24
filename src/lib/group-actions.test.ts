import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignItems, chainPairs, planLayout, orderItems } from './arrange.ts';
import { addMembers, bucketBySource, defaultGroupTitle, frameRect, migrateGroups, reconcileMembership, removeMembers } from './groups.ts';
import { formatCardsClip, appendClip } from './note-clip.ts';

// These tests pin down the behaviour the canvas actions rely on, expressed through the pure functions
// they call. The store and the UI are exercised by the browser tests.

const card = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, x, y, width: 320, height: 200, ...extra });

test('grouping a multi-selection and then moving the group moves the frame with it', () => {
  const cards = [card('a', 0, 0), card('b', 400, 0)];
  const before = frameRect(cards)!;
  const moved = cards.map((c) => ({ ...c, x: c.x + 500, y: c.y + 300 }));
  const after = frameRect(moved)!;
  assert.deepEqual({ w: after.width, h: after.height }, { w: before.width, h: before.height }, 'frame keeps its size');
  assert.equal(after.x - before.x, 500);
  assert.equal(after.y - before.y, 300);
});

test('arranging a group keeps its membership and updates its frame', () => {
  const groups = migrateGroups([{ id: 'g', members: ['a', 'b', 'c'] }], new Set(['a', 'b', 'c']), () => 'x');
  const items = [card('a', 0, 0), card('b', 900, 700), card('c', 40, 300)];
  const placed = planLayout(items, { layout: 'row', order: 'position', spacing: 'tight' });
  const arranged = items.map((i) => ({ ...i, ...placed[i.id] }));
  assert.deepEqual(groups[0].members, ['a', 'b', 'c']);
  // The frame is recomputed from the new positions: it now wraps the row, not the scattered start.
  const frame = frameRect(arranged)!;
  for (const c of arranged) {
    assert.ok(c.x >= frame.x && c.x + c.width <= frame.x + frame.width, `${c.id} inside the frame horizontally`);
    assert.ok(c.y >= frame.y && c.y + c.height <= frame.y + frame.height, `${c.id} inside the frame vertically`);
  }
});

test('a drag-to-chain edge uses the same ordering the arrange panel shows', () => {
  const items = [card('late', 0, 900, { title: 'Z' }), card('early', 0, 0, { title: 'A' })];
  assert.deepEqual(chainPairs(orderItems(items, 'position').map((i) => i.id)), [['early', 'late']]);
  assert.deepEqual(chainPairs(orderItems(items, 'title').map((i) => i.id)), [['early', 'late']]);
});

test('aligning a selection never changes sizes', () => {
  const items = [card('a', 0, 0), card('b', 300, 40, { width: 500 })];
  const moved = alignItems(items, 'top');
  assert.equal(Object.keys(moved).length, 1);
  assert.equal(moved.b.y, 0);
});

test('group by book produces one group per book with at least two cards', () => {
  const info = [
    { id: '1', source: 'Book A' },
    { id: '2', source: 'Book A' },
    { id: '3', source: 'Book B' },
    { id: '4' },
  ];
  const worthy = bucketBySource(info).filter((bucket) => bucket.ids.length >= 2);
  assert.deepEqual(worthy, [{ source: 'Book A', ids: ['1', '2'] }]);
  assert.equal(defaultGroupTitle(info.filter((c) => c.source === 'Book A'), 0), 'Book A');
});

test('a card moving from one group into a second is in only one group afterwards', () => {
  let groups = migrateGroups([{ id: 'g1', members: ['a', 'x'] }, { id: 'g2', members: ['b'] }], new Set(['a', 'x', 'b']), () => 'n');
  groups = addMembers(groups, 'g2', ['x']);
  const owners = groups.filter((g) => g.members.includes('x'));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].id, 'g2');
  groups = removeMembers(groups, ['a']);
  assert.deepEqual(groups.map((g) => g.id), ['g2'], 'g1 emptied and removed');
});

test('a dropped card lands in the smallest frame it sits inside', () => {
  const groups = migrateGroups([{ id: 'wide', members: ['p', 'q'] }, { id: 'tight', members: ['r'] }], new Set(['p', 'q', 'r', 'c']), () => 'n');
  const boxes = new Map([
    ['p', card('p', 0, 0)],
    ['q', card('q', 1400, 1100)],
    ['r', card('r', 600, 500)],
    ['c', card('c', 640, 520)],
  ]);
  const result = reconcileMembership(groups, boxes as never, new Set(['c']));
  assert.ok(result.find((g) => g.id === 'tight')!.members.includes('c'));
});

test('sending several cards to a note keeps their order and sources', () => {
  const clip = formatCardsClip(
    [
      { text: 'One', comment: '', source: { title: 'Book.pdf', page: 4 } },
      { text: 'Two', comment: 'note on two', source: { title: 'Book.pdf', page: 9 } },
    ],
    'markdown',
    'Group X',
  );
  const note = appendClip('# Notes\n', clip);
  assert.ok(note.indexOf('> One') < note.indexOf('> Two'));
  assert.ok(note.includes('p. 4') && note.includes('p. 9') && note.includes('note on two') && note.includes('### Group X'));
});
