import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sortable } from './arrange.ts';
import type { Group } from './groups.ts';
import { planTidy, planOverlapTidy, tidyMovesSomething } from './tidy.ts';

const item = (id: string, x: number, y: number, width = 200, height = 150): Sortable => ({ id, x, y, width, height, title: id });

const group = (id: string, title: string, members: string[], collapsed = false): Group => ({ id, title, color: '#ffcd45', members, collapsed });

test('planTidy keeps a group as one block: its members stay clustered', () => {
  const a = item('a', 0, 0), b = item('b', 500, 0), c = item('c', 1500, 900);
  const far = item('d', 4000, 4000);
  const placement = planTidy([a, b, c, far], [group('g1', 'G', ['a', 'b', 'c'])]);
  const aSpot = placement['a']!;
  const bSpot = placement['b']!;
  const cSpot = placement['c']!;
  // members land in a grid adjacent to each other, with the shared member gap (normal spacing = 36)
  assert.equal(bSpot.y, aSpot.y);
  assert.equal(cSpot.y, aSpot.y + 150 + 36);
  assert.ok(Math.abs(bSpot.x - (aSpot.x + 200 + 36)) < 1);
  // ungrouped window sits outside the group block, with the rhythm's column gap of 48
  // (the arranged group block is 436 wide: two 200px members + the 36px member gap)
  assert.equal(placement['d']!.x, aSpot.x + 436 + 48);
});

test('planTidy mirrors spine order: left stays left, high stays high', () => {
  // two groups far apart; after the tidy the left one is left of the right one
  const left = [item('l1', 0, 0), item('l2', 0, 400)];
  const right = [item('r1', 3000, 0), item('r2', 3000, 400)];
  const placement = planTidy([...left, ...right], [group('gl', 'L', ['l1', 'l2']), group('gr', 'R', ['r1', 'r2'])]);
  assert.ok(placement['l1']!.x < placement['r1']!.x);
  assert.ok(placement['l2']!.x < placement['r2']!.x);
});

test('planTidy covers every item exactly once and snaps the origin to the rhythm', () => {
  const items = [item('a', 7, 13), item('b', 210, 400, 400), item('c', -98, 30)];
  const placement = planTidy(items, []);
  assert.equal(Object.keys(placement).length, 3);
  assert.deepEqual(Object.keys(placement).sort(), ['a', 'b', 'c']);
  // origin snapped down to the 20px unit grid
  const minX = Math.min(...Object.values(placement).map((p) => p.x));
  assert.ok(minX % 20 === 0);
});

test('planTidy ignores collapsed groups and lone group members', () => {
  const a = item('a', 0, 0), b = item('b', 900, 900);
  const placement = planTidy([a, b], [group('g1', 'G', ['a', 'b'], true), group('g2', 'H', ['a'])]);
  // two singleton blocks in a row, second one a column gap (48) after the first
  assert.equal(placement['b']!.x, 200 + 48);
});

test('planTidy leaves a tidy arrangement in place', () => {
  const a = item('a', 0, 0), b = item('b', 248, 0);
  const placement = planTidy([a, b], []);
  assert.deepEqual(placement['b'], { x: 248, y: 0 });
  assert.equal(tidyMovesSomething([a, b]), false);
  const messy = item('b', 250, 3);
  assert.equal(tidyMovesSomething([a, messy]), true);
});

test('planTidy of one item is empty', () => {
  assert.deepEqual(planTidy([item('a', 10, 10)]), {});
});

test('linked items stay attached: a chain becomes one block in chain order', () => {
  const a = item('a', 0, 0, 300, 200);
  const b = item('b', 2000, 1500, 300, 200);
  const c = item('c', 4000, 300, 300, 200);
  const d = item('d', 9000, 9000);
  const placement = planTidy([a, b, c, d], [], [['a', 'b'], ['b', 'c']]);
  // the chain is laid out left-to-right in chain order (a→b→c) with the member gap
  assert.equal(placement['a']!.y, placement['b']!.y);
  assert.equal(placement['b']!.y, placement['c']!.y);
  assert.equal(placement['b']!.x, placement['a']!.x + 300 + 36);
  assert.equal(placement['c']!.x, placement['b']!.x + 300 + 36);
  // the chain block is 972 wide (3×300 + 2×36); the unlinked window sits a column gap after it
  assert.equal(placement['d']!.x, placement['a']!.x + 972 + 48);
});

test('planOverlapTidy leaves reasonably spaced windows untouched', () => {
  const apart0 = item('a', 0, 0);
  const apart1 = item('b', 500, 500);
  assert.deepEqual(planOverlapTidy([apart0, apart1], [], []), {});
});

test('planOverlapTidy re-arranges only the pile that overlaps', () => {
  const far0 = item('a', 0, 0, 200, 150);
  const far1 = item('b', 400, 0, 200, 150);
  const pile0 = item('c', 1000, 1000, 200, 150);
  const pile1 = item('d', 1030, 1020, 200, 150); // overlaps pile0
  const tidy = planOverlapTidy([far0, far1, pile0, pile1], [], []);
  assert.ok(!('a' in tidy), 'unrelated windows must not move');
  assert.ok(!('b' in tidy), 'unrelated windows must not move');
  assert.ok('c' in tidy && 'd' in tidy, 'the overlapping pair is re-arranged');
  assert.ok(tidy['c']!.y !== pile0.y || tidy['c']!.x !== pile0.x || tidy['d']!.y !== pile1.y || tidy['d']!.x !== pile1.x);
});

test('linked but untouched windows are left alone by the overlap tidy', () => {
  const a = item('a', 0, 0, 200, 150);
  const b = item('b', 400, 0, 200, 150); // linked to a but not overlapping anything
  const tidy = planOverlapTidy([a, b], [], [['a', 'b']]);
  assert.deepEqual(tidy, {});
});
