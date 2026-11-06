import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sortable } from './arrange.ts';
import { frameRect, GROUP_HEADER, GROUP_PAD, type Group } from './groups.ts';
import { overlaps } from './placement.ts';
import { frameMargin, planTidy, planOverlapTidy, tidyMovesSomething } from './tidy.ts';

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
  // ungrouped window sits outside the group's drawn frame, with the rhythm's column gap of 48 between
  // them: the arranged group block is 436 wide (two 200px members + the 36px member gap) and its frame
  // reaches GROUP_PAD (28px) beyond the members.
  assert.equal(placement['d']!.x, aSpot.x + 436 + GROUP_PAD + 48);
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

const placedAt = (items: Sortable[], placement: Record<string, { x: number; y: number }>) => items.map((i) => ({ ...i, ...(placement[i.id] ?? {}) }));

test('planTidy keeps the reading order of a two-dimensional layout', () => {
  // [A B / C D]: used to come back transposed as [A C / B D].
  const two = [item('A', 0, 0), item('B', 400, 0), item('C', 0, 300), item('D', 400, 300)];
  const p = planTidy(two);
  assert.ok(p['A']!.x < p['B']!.x && p['A']!.y === p['B']!.y, 'B stays to the right of A');
  assert.ok(p['A']!.y < p['C']!.y && p['A']!.x === p['C']!.x, 'C stays below A');
  assert.equal(p['D']!.x, p['B']!.x);
  assert.equal(p['D']!.y, p['C']!.y);

  // [A B C / D E F]: used to come back as [A D B / E C F].
  const six = [item('A', 0, 0), item('B', 400, 0), item('C', 800, 0), item('D', 0, 300), item('E', 400, 300), item('F', 800, 300)];
  const q = planTidy(six);
  const rowOf = (id: string) => q[id]!.y;
  assert.ok(rowOf('A') === rowOf('B') && rowOf('B') === rowOf('C'), 'A B C share a row');
  assert.ok(rowOf('D') === rowOf('E') && rowOf('E') === rowOf('F'), 'D E F share a row');
  assert.ok(rowOf('D') > rowOf('A'));
  assert.ok(q['A']!.x < q['B']!.x && q['B']!.x < q['C']!.x, 'A B C run left to right');
  assert.ok(q['D']!.x < q['E']!.x && q['E']!.x < q['F']!.x, 'D E F run left to right');
});

test('tidied groups keep their drawn frames clear of each other', () => {
  const items = [item('a1', 0, 0, 300, 200), item('a2', 350, 0, 300, 200), item('b1', 0, 700, 300, 200), item('b2', 350, 700, 300, 200)];
  const groups = [group('A', 'A', ['a1', 'a2']), group('B', 'B', ['b1', 'b2'])];
  const placed = placedAt(items, planTidy(items, groups));
  const frame = (ids: string[]) => frameRect(placed.filter((i) => ids.includes(i.id)))!;
  assert.equal(overlaps(frame(['a1', 'a2']), frame(['b1', 'b2'])), false, 'frame A and frame B do not overlap');
  // and the gap between the frames is the rhythm's column gap, not less
  const fa = frame(['a1', 'a2']);
  const fb = frame(['b1', 'b2']);
  const horizontal = fb.x - (fa.x + fa.width);
  const vertical = fb.y - (fa.y + fa.height);
  assert.ok(horizontal >= 48 || vertical >= 48, `frames are ${horizontal}px / ${vertical}px apart`);
});

test('planTidy keeps the top-left of the original bounds even when the first block is a group', () => {
  const items = [item('a1', 100, 100), item('a2', 400, 100), item('x', 900, 100)];
  const p = planTidy(items, [group('A', 'A', ['a1', 'a2'])]);
  const first = Math.min(p['a1']!.x, p['a2']!.x);
  assert.equal(first, 100, 'members start where the original bounds started, not shifted by the frame padding');
  assert.equal(Math.min(p['a1']!.y, p['a2']!.y), 100);
});

test('frameMargin only applies to blocks that are actually framed', () => {
  const g = [group('A', 'A', ['a', 'b'])];
  assert.deepEqual(frameMargin(['a', 'b', 'c'], g), { top: GROUP_PAD + GROUP_HEADER, right: GROUP_PAD, bottom: GROUP_PAD, left: GROUP_PAD });
  assert.deepEqual(frameMargin(['a', 'c'], g), {}, 'a group with fewer than two members in the set draws no frame');
  assert.deepEqual(frameMargin(['a', 'b'], [group('A', 'A', ['a', 'b'], true)]), {}, 'a collapsed group is not framed');
  assert.deepEqual(frameMargin(['a', 'b'], []), {});
});

test('planOverlapTidy never lands a tidied pile on a window that was not part of it', () => {
  const pile = [item('p1', 0, 0, 300, 200), item('p2', 150, 50, 300, 200), item('p3', 100, 100, 300, 200)];
  const bystander = item('x', 0, 330, 300, 200); // just below the pile, not overlapping it
  const all = [...pile, bystander];
  const placement = planOverlapTidy(all);
  assert.equal(placement['x'], undefined, 'the bystander is never moved');
  const after = placedAt(all, placement);
  for (let i = 0; i < after.length; i += 1) for (let j = i + 1; j < after.length; j += 1) {
    assert.equal(overlaps(after[i]!, after[j]!), false, `${after[i]!.id} overlaps ${after[j]!.id}`);
  }
});

test('planOverlapTidy keeps two tidied piles off each other', () => {
  const heapA = [item('a1', 0, 0, 300, 200), item('a2', 100, 50, 300, 200), item('a3', 50, 80, 300, 200)];
  const heapB = [item('b1', 500, 0, 300, 200), item('b2', 600, 50, 300, 200), item('b3', 550, 80, 300, 200)];
  const all = [...heapA, ...heapB];
  const after = placedAt(all, planOverlapTidy(all));
  for (let i = 0; i < after.length; i += 1) for (let j = i + 1; j < after.length; j += 1) {
    assert.equal(overlaps(after[i]!, after[j]!), false, `${after[i]!.id} overlaps ${after[j]!.id}`);
  }
});
