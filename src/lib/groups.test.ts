import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSED_WIDTH,
  GROUP_HEADER,
  GROUP_PAD,
  addMembers,
  bucketByColor,
  bucketBySource,
  collapsedRect,
  colorName,
  defaultGroupColor,
  defaultGroupTitle,
  frameRect,
  groupOf,
  hiddenIds,
  liveMembers,
  migrateGroups,
  nextGroupColor,
  reconcileMembership,
  removeMembers,
  type Group,
} from './groups.ts';

const group = (id: string, members: string[], extra: Partial<Group> = {}): Group => ({ id, title: id.toUpperCase(), color: '#ffcd45', members, collapsed: false, ...extra });
const box = (x: number, y: number, width = 320, height = 200) => ({ x, y, width, height });
let n = 0;
const makeId = () => `new-${++n}`;

test('loading drops unknown cards, repeated membership, empty and malformed groups', () => {
  const valid = new Set(['a', 'b', 'c']);
  const loaded = migrateGroups(
    [
      { id: 'g1', title: '  Ideas ', color: '#3B82F6', members: ['a', 'ghost', 'a', 'b'], collapsed: true },
      { id: 'g2', title: 'Dupe', members: ['b', 'c'] },
      { id: 'g3', members: ['nobody'] },
      'junk',
      null,
      { id: 'g1', members: [] },
    ],
    valid,
    makeId,
  );
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded[0], { id: 'g1', title: 'Ideas', color: '#3B82F6', members: ['a', 'b'], collapsed: true });
  assert.deepEqual(loaded[1].members, ['c'], 'a card keeps only its first group');
  assert.equal(loaded[1].color, '#FFCD45', 'a missing colour falls back to the palette');
  assert.equal(loaded[1].collapsed, false);
  assert.deepEqual(migrateGroups('not a list', valid, makeId), []);
});

test('duplicate group ids and bad titles are repaired', () => {
  const loaded = migrateGroups([{ id: 'x', members: ['a'], title: 5 }, { id: 'x', members: ['b'] }], new Set(['a', 'b']), makeId);
  assert.notEqual(loaded[0].id, loaded[1].id);
  assert.equal(loaded[0].title, 'Group 1');
  assert.equal(loaded[1].title, 'Group 2');
});

test('the frame wraps its cards with padding and room for the header', () => {
  const frame = frameRect([box(100, 100), box(500, 400, 200, 100)])!;
  assert.deepEqual(frame, { x: 100 - GROUP_PAD, y: 100 - GROUP_PAD - GROUP_HEADER, width: 600 + GROUP_PAD * 2, height: 400 + GROUP_PAD * 2 + GROUP_HEADER });
  assert.equal(frameRect([]), null);
});

test('a collapsed group is a header-sized chip at the frame\'s corner', () => {
  const frame = frameRect([box(0, 0)])!;
  const chip = collapsedRect(frame);
  assert.deepEqual({ x: chip.x, y: chip.y, height: chip.height }, { x: frame.x, y: frame.y, height: GROUP_HEADER });
  assert.ok(chip.width <= COLLAPSED_WIDTH && chip.width >= 180);
});

test('collapsed groups hide only their live members', () => {
  const groups = [group('a', ['1', '2', 'gone'], { collapsed: true }), group('b', ['3'])];
  const existing = new Set(['1', '2', '3']);
  assert.deepEqual([...hiddenIds(groups, existing)].sort(), ['1', '2']);
  assert.deepEqual(liveMembers(groups[0], existing), ['1', '2']);
});

test('adding cards to a group takes them out of their old group, and empty groups disappear', () => {
  const groups = [group('a', ['1', '2']), group('b', ['3'])];
  const moved = addMembers(groups, 'a', ['3']);
  assert.deepEqual(moved.map((g) => [g.id, g.members]), [['a', ['1', '2', '3']]]);
  const regrouped = addMembers(groups, 'b', ['1']);
  assert.deepEqual(regrouped.map((g) => [g.id, g.members]), [['a', ['2']], ['b', ['3', '1']]]);
  assert.equal(groupOf(regrouped, '1')?.id, 'b');
});

test('removing cards drops groups left empty', () => {
  const groups = [group('a', ['1']), group('b', ['2', '3'])];
  assert.deepEqual(removeMembers(groups, ['1', '2']).map((g) => g.id), ['b']);
  assert.deepEqual(removeMembers(groups, ['9']), groups);
});

test('new groups prefer an unused palette colour', () => {
  assert.equal(nextGroupColor([]), '#FFCD45');
  assert.equal(nextGroupColor([group('a', ['1'], { color: '#ffcd45' })]), '#F97316');
  assert.equal(nextGroupColor(['#FFCD45', '#F97316', '#E44234', '#22C55E', '#3B82F6', '#8B5CF6'].map((c, i) => group(`g${i}`, [`m${i}`], { color: c }))).length, 7);
});

test('default names come from the book when all cards share one', () => {
  assert.equal(defaultGroupTitle([{ id: '1', source: 'Social Planning.pdf' }, { id: '2', source: 'Social Planning.pdf' }], 3), 'Social Planning');
  assert.equal(defaultGroupTitle([{ id: '1', source: 'A.pdf' }, { id: '2', source: 'B.pdf' }], 3), 'Group 4');
  assert.equal(defaultGroupTitle([{ id: '1', source: 'A.pdf' }, { id: '2' }], 0), 'Group 1');
});

test('default colour is the cards\' shared colour, else the next free one', () => {
  assert.equal(defaultGroupColor([{ id: '1', color: '#3B82F6' }, { id: '2', color: '#3b82f6' }], []), '#3b82f6');
  assert.equal(defaultGroupColor([{ id: '1', color: '#3B82F6' }, { id: '2' }], []), '#FFCD45');
});

test('cards bucket by book and by colour', () => {
  const cards = [{ id: '1', source: 'A', color: '#22C55E' }, { id: '2', source: 'B', color: '#22c55e' }, { id: '3', source: 'A' }, { id: '4' }];
  assert.deepEqual(bucketBySource(cards), [{ source: 'A', ids: ['1', '3'] }, { source: 'B', ids: ['2'] }]);
  assert.deepEqual(bucketByColor(cards), [{ color: '#22c55e', ids: ['1', '2'] }, { color: undefined, ids: ['3', '4'] }]);
  assert.equal(colorName('#22C55E'), 'Green');
  assert.equal(colorName(undefined), 'No colour');
  assert.equal(colorName('#123456'), 'Other');
});

// Two cards at x=100 and x=500 (320 wide, 200 tall): the frame spans x 72..848, y 32..328+.
const boxes = (extra: Record<string, ReturnType<typeof box>> = {}) =>
  new Map<string, ReturnType<typeof box>>(Object.entries({ a: box(100, 100), b: box(500, 100), ...extra }));

test('dropping a card inside a group\'s frame makes it a member', () => {
  const groups = [group('g', ['a', 'b'])];
  const result = reconcileMembership(groups, boxes({ c: box(300, 120) }), new Set(['c']));
  assert.deepEqual(result[0].members, ['a', 'b', 'c']);
});

test('dropping it well outside leaves it ungrouped', () => {
  const groups = [group('g', ['a', 'b'])];
  assert.deepEqual(reconcileMembership(groups, boxes({ c: box(2000, 2000) }), new Set(['c']))[0].members, ['a', 'b']);
});

test('dragging a member out of the frame removes it; staying close keeps it', () => {
  const groups = [group('g', ['a', 'b', 'c'])];
  assert.deepEqual(reconcileMembership(groups, boxes({ c: box(2000, 2000) }), new Set(['c']))[0].members, ['a', 'b']);
  // nudged a little but still near the others: stays
  assert.deepEqual(reconcileMembership(groups, boxes({ c: box(300, 150) }), new Set(['c']))[0].members, ['a', 'b', 'c']);
});

test('moving a whole group together changes nothing', () => {
  const groups = [group('g', ['a', 'b'])];
  const moved = new Map([['a', box(900, 900)], ['b', box(1300, 900)]]);
  assert.deepEqual(reconcileMembership(groups, moved, new Set(['a', 'b'])), groups);
});

test('a card dragged from one group into another switches groups', () => {
  const groups = [group('g1', ['a', 'x']), group('g2', ['b', 'y'])];
  const layout = new Map([['a', box(0, 0)], ['x', box(400, 0)], ['b', box(2000, 0)], ['y', box(2400, 0)]]);
  layout.set('x', box(2100, 40)); // dropped into the middle of g2's frame
  const result = reconcileMembership(groups, layout, new Set(['x']));
  assert.deepEqual(result.map((g) => [g.id, g.members]), [['g1', ['a']], ['g2', ['b', 'y', 'x']]]);
});

test('a collapsed group does not accept drops and a lone member is never auto-removed', () => {
  const collapsed = [group('g', ['a', 'b'], { collapsed: true })];
  assert.deepEqual(reconcileMembership(collapsed, boxes({ c: box(300, 120) }), new Set(['c']))[0].members, ['a', 'b']);
  const solo = [group('g', ['a'])];
  assert.deepEqual(reconcileMembership(solo, new Map([['a', box(5000, 5000)]]), new Set(['a']))[0].members, ['a']);
});

test('overlapping frames: the smaller (more specific) one wins', () => {
  const groups = [group('big', ['p', 'q']), group('small', ['r'])];
  const layout = new Map([['p', box(0, 0)], ['q', box(1500, 1200)], ['r', box(600, 500)], ['c', box(640, 520)]]);
  const result = reconcileMembership(groups, layout, new Set(['c']));
  assert.deepEqual(result.find((g) => g.id === 'small')?.members, ['r', 'c']);
});
