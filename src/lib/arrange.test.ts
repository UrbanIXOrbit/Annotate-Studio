import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAPS, alignItems, autoSides, boundsOf, chainPairs, distributeItems, orderItems, planLayout, readingOrder, type Sortable } from './arrange.ts';

const card = (id: string, x: number, y: number, extra: Partial<Sortable> = {}): Sortable => ({ id, x, y, width: 320, height: 200, ...extra });

test('bounds cover every item', () => {
  assert.deepEqual(boundsOf([card('a', 100, 50), card('b', 500, 400)]), { x: 100, y: 50, width: 720, height: 550 });
  assert.equal(boundsOf([]), null);
});

test('reading order treats items on one line as a row, then goes down', () => {
  const items = [card('d', 700, 410), card('b', 400, 22), card('a', 50, 10), card('c', 60, 400), card('e', 1000, 15)];
  assert.deepEqual(readingOrder(items).map((i) => i.id), ['a', 'b', 'e', 'c', 'd']);
});

test('page order follows the book, then the page, with unsourced cards last', () => {
  const items = [
    card('loose', 0, 0),
    card('b10', 0, 0, { source: 'Book B', page: 10 }),
    card('a7', 0, 0, { source: 'Book A', page: 7 }),
    card('a2', 0, 0, { source: 'Book A', page: 2 }),
    card('b3', 0, 0, { source: 'Book B', page: 3 }),
  ];
  assert.deepEqual(orderItems(items, 'page').map((i) => i.id), ['a2', 'a7', 'b3', 'b10', 'loose']);
});

test('colour order follows the palette, uncoloured cards last', () => {
  const items = [card('p', 0, 0, { color: '#8B5CF6' }), card('n', 0, 0), card('y', 0, 0, { color: '#ffcd45' }), card('g', 0, 0, { color: '#22C55E' })];
  assert.deepEqual(orderItems(items, 'color').map((i) => i.id), ['y', 'g', 'p', 'n']);
});

test('title order is natural and selection order is respected', () => {
  const items = [card('1', 0, 0, { title: 'Note 10' }), card('2', 0, 0, { title: 'Note 2' }), card('3', 0, 0, { title: 'apple' })];
  assert.deepEqual(orderItems(items, 'title').map((i) => i.id), ['3', '2', '1']);
  assert.deepEqual(orderItems(items, 'selection', ['2', '1', '3']).map((i) => i.id), ['2', '1', '3']);
  assert.deepEqual(orderItems(items, 'selection', ['3']).map((i) => i.id)[0], '3');
});

test('a row lays cards left to right from the selection\'s top-left, keeping sizes', () => {
  const items = [card('a', 100, 100), card('b', 600, 500), card('c', 300, 900)];
  const placed = planLayout(items, { layout: 'row', order: 'position', spacing: 'normal' });
  assert.deepEqual(placed, { a: { x: 100, y: 100 }, b: { x: 100 + 320 + GAPS.normal, y: 100 }, c: { x: 100 + 2 * (320 + GAPS.normal), y: 100 } });
});

test('a column stacks them top to bottom', () => {
  const placed = planLayout([card('a', 0, 0), card('b', 900, 0), card('c', 400, 0)], { layout: 'column', order: 'position', spacing: 'tight' });
  assert.deepEqual(placed, { a: { x: 0, y: 0 }, c: { x: 0, y: 216 }, b: { x: 0, y: 432 } });
});

test('a grid is roughly square and sizes columns and rows to their contents', () => {
  const items = [card('a', 0, 0), card('b', 0, 0, { width: 500 }), card('c', 0, 0), card('d', 0, 0, { height: 350 }), card('e', 0, 0)];
  const placed = planLayout(items, { layout: 'grid', order: 'selection', selectionOrder: ['a', 'b', 'c', 'd', 'e'], spacing: 'normal' });
  // 5 items -> 3 columns. Column 2 is as wide as its widest card (the 500px one).
  assert.deepEqual(placed.a, { x: 0, y: 0 });
  assert.deepEqual(placed.b, { x: 320 + 36, y: 0 });
  assert.deepEqual(placed.c, { x: 320 + 36 + 500 + 36, y: 0 });
  assert.equal(placed.d.x, 0);
  assert.equal(placed.d.y, 200 + 36);
  assert.equal(placed.e.y, 200 + 36);
  assert.equal(placed.e.x, 320 + 36);
});

test('an explicit column count is honoured and capped by the number of cards', () => {
  const items = [card('a', 0, 0), card('b', 0, 0), card('c', 0, 0)];
  assert.equal(planLayout(items, { layout: 'grid', order: 'position', spacing: 'tight', columns: 2 }).c.y, 216);
  assert.equal(planLayout(items, { layout: 'grid', order: 'position', spacing: 'tight', columns: 9 }).c.y, 0);
});

test('flow wraps when a line would get too wide', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => card(id, i * 10, 0));
  const placed = planLayout(items, { layout: 'flow', order: 'position', spacing: 'normal', maxRowWidth: 1000 });
  // 320 + 36 per card: three fit in 1000px (3*320 + 2*36 = 1032 > 1000 -> two fit)
  assert.deepEqual(Object.values(placed).map((p) => p.y), [0, 0, 236, 236, 472]);
  assert.equal(placed.c.x, 0);
});

test('page order can drive a layout so cards read like the book', () => {
  const items = [card('late', 0, 0, { source: 'X', page: 40 }), card('early', 900, 0, { source: 'X', page: 3 })];
  const placed = planLayout(items, { layout: 'row', order: 'page', spacing: 'tight' });
  assert.ok(placed.early.x < placed.late.x);
});

test('a single item or an empty selection is left alone', () => {
  assert.deepEqual(planLayout([], { layout: 'grid', order: 'position', spacing: 'normal' }), {});
  assert.deepEqual(planLayout([card('a', 40, 60)], { layout: 'grid', order: 'position', spacing: 'normal' }), { a: { x: 40, y: 60 } });
});

test('aligning moves only what needs to move', () => {
  const items = [card('a', 100, 0), card('b', 400, 300, { width: 200 }), card('c', 250, 150)];
  assert.deepEqual(alignItems(items, 'left'), { b: { x: 100, y: 300 }, c: { x: 100, y: 150 } });
  assert.deepEqual(alignItems(items, 'right'), { a: { x: 280, y: 0 }, c: { x: 280, y: 150 } });
  assert.deepEqual(alignItems(items, 'top'), { b: { x: 400, y: 0 }, c: { x: 250, y: 0 } });
  assert.deepEqual(alignItems(items, 'bottom'), { a: { x: 100, y: 300 }, c: { x: 250, y: 300 } });
  // bounds span x 100..600, so the centre line is 350: a (320 wide) -> 190, b (200 wide) -> 250, c -> 190
  assert.deepEqual(alignItems(items, 'center'), { a: { x: 190, y: 0 }, b: { x: 250, y: 300 }, c: { x: 190, y: 150 } });
  assert.deepEqual(alignItems([card('only', 5, 5)], 'left'), {});
});

test('centre and middle use the centre of the selection', () => {
  const items = [card('a', 0, 0), card('b', 600, 0, { width: 100, height: 100 })];
  // bounds are 700 x 200: the small card centres at x = 300 and y = 50; the big one already fills the height
  assert.deepEqual(alignItems(items, 'center'), { a: { x: 190, y: 0 }, b: { x: 300, y: 0 } });
  assert.deepEqual(alignItems(items, 'middle'), { b: { x: 600, y: 50 } });
});

test('distribute spaces items evenly and keeps the outer two in place', () => {
  const items = [card('a', 0, 0), card('b', 100, 0), card('c', 1000, 0)];
  const moved = distributeItems(items, 'x');
  // free space = 1320 - 960 = 360 -> 180 gaps; b ends up at 320 + 180
  assert.deepEqual(moved, { b: { x: 500, y: 0 } });
  assert.deepEqual(distributeItems([card('a', 0, 0), card('b', 5, 0)], 'x'), {}, 'needs three or more');
  // vertically: 0..1200 span, 600 of card height, so two 300px gaps -> the middle card lands at y = 500
  assert.deepEqual(distributeItems([card('a', 0, 0), card('b', 0, 50), card('c', 0, 1000)], 'y'), { b: { x: 0, y: 500 } });
});

test('chains link neighbours, optionally closing into a loop', () => {
  assert.deepEqual(chainPairs(['a', 'b', 'c']), [['a', 'b'], ['b', 'c']]);
  assert.deepEqual(chainPairs(['a', 'b', 'c'], true), [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  assert.deepEqual(chainPairs(['a', 'b'], true), [['a', 'b']], 'two cards cannot loop');
  assert.deepEqual(chainPairs(['a']), []);
});

test('connector ends attach to the sides that face each other', () => {
  const a = card('a', 0, 0);
  assert.deepEqual(autoSides(a, card('b', 700, 0)), { fromSide: 'e', toSide: 'w' });
  assert.deepEqual(autoSides(a, card('b', -700, 0)), { fromSide: 'w', toSide: 'e' });
  assert.deepEqual(autoSides(a, card('b', 0, 600)), { fromSide: 's', toSide: 'n' });
  assert.deepEqual(autoSides(a, card('b', 0, -600)), { fromSide: 'n', toSide: 's' });
});
