import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorPoint,
  connectorGeometry,
  hitTestBox,
  migrateConnectors,
  nearestSide,
  oppositeSide,
  pickTargetSide,
  sameConnection,
} from './connectors.ts';

const box = { x: 100, y: 200, width: 300, height: 100 };

test('anchors sit at the midpoint of each side', () => {
  assert.deepEqual(anchorPoint(box, 'n'), { x: 250, y: 200 });
  assert.deepEqual(anchorPoint(box, 's'), { x: 250, y: 300 });
  assert.deepEqual(anchorPoint(box, 'e'), { x: 400, y: 250 });
  assert.deepEqual(anchorPoint(box, 'w'), { x: 100, y: 250 });
});

test('opposite sides pair up', () => {
  assert.equal(oppositeSide('n'), 's');
  assert.equal(oppositeSide('e'), 'w');
});

test('nearestSide respects the box aspect ratio', () => {
  assert.equal(nearestSide(box, { x: 900, y: 250 }), 'e');
  assert.equal(nearestSide(box, { x: -300, y: 250 }), 'w');
  assert.equal(nearestSide(box, { x: 250, y: -400 }), 'n');
  assert.equal(nearestSide(box, { x: 250, y: 900 }), 's');
  // 40px right of centre is "east" on a wide box only when it is past the vertical offset
  assert.equal(nearestSide(box, { x: 250, y: 295 }), 's');
});

test('geometry starts and ends at the anchors and points the arrow into the target', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 0 };
  const geometry = connectorGeometry(from, 'e', to, 'w', 10, true);
  assert.match(geometry.d, /^M 0 0 C /);
  assert.ok(geometry.d.endsWith('200 0'));
  assert.deepEqual(geometry.mid, { x: 100, y: 0 });
  assert.ok(geometry.arrow?.startsWith('200,0 '));
  // The arrow base trails behind the tip on the target's outward side (west of x=200).
  const base = geometry.arrow!.split(' ').slice(1).map((pair) => pair.split(',').map(Number));
  for (const [x] of base) assert.ok(x < 200);
});

test('arrowhead can be omitted', () => {
  assert.equal(connectorGeometry({ x: 0, y: 0 }, 'e', { x: 50, y: 50 }, 'n', 10, false).arrow, null);
});

test('hit testing returns the topmost box and honours ignoreId', () => {
  const items = [
    { id: 'a', x: 0, y: 0, width: 100, height: 100, z: 1 },
    { id: 'b', x: 50, y: 50, width: 100, height: 100, z: 2 },
  ];
  assert.equal(hitTestBox(items, { x: 75, y: 75 })?.id, 'b');
  assert.equal(hitTestBox(items, { x: 75, y: 75 }, 'b')?.id, 'a');
  assert.equal(hitTestBox(items, { x: 500, y: 500 }), null);
  assert.equal(hitTestBox(items, { x: 110, y: 10 }, undefined, 15)?.id, 'a');
});

test('migrateConnectors drops invalid, dangling, duplicate and self connectors', () => {
  const valid = new Set(['a', 'b', 'c']);
  let counter = 0;
  const makeId = () => `new-${++counter}`;
  const result = migrateConnectors(
    [
      { id: 'k1', from: 'a', to: 'b', fromSide: 'e', toSide: 'w', label: '  causes  ' },
      { id: 'k2', from: 'a', to: 'b', fromSide: 'e', toSide: 'w' }, // duplicate
      { id: 'k3', from: 'a', to: 'a', fromSide: 'e', toSide: 'w' }, // self
      { id: 'k4', from: 'a', to: 'zzz', fromSide: 'e', toSide: 'w' }, // dangling
      { from: 'b', to: 'c', fromSide: 'bogus', arrow: false }, // missing id + bad side
      'nonsense',
      null,
    ],
    valid,
    makeId,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { id: 'k1', from: 'a', to: 'b', fromSide: 'e', toSide: 'w', label: 'causes', arrow: true });
  assert.equal(result[1].id, 'new-1');
  assert.equal(result[1].fromSide, 'e');
  assert.equal(result[1].arrow, false);
  assert.deepEqual(migrateConnectors('not an array', valid, makeId), []);
});

test('sameConnection compares endpoints and sides, not ids', () => {
  const a = { from: 'a', to: 'b', fromSide: 'e', toSide: 'w' } as const;
  assert.equal(sameConnection(a, { ...a }), true);
  assert.equal(sameConnection(a, { ...a, toSide: 'n' }), false);
});

test('pickTargetSide honours edge aim but faces the source when dropped deep inside', () => {
  const target = { x: 0, y: 0, width: 300, height: 200 };
  const sourceAbove = { x: 150, y: -300 };
  // Dead centre: face the source (above), so the connector enters from the top.
  assert.equal(pickTargetSide(target, { x: 150, y: 100 }, sourceAbove), 'n');
  // Slightly off-centre but still in the inner area: still faces the source.
  assert.equal(pickTargetSide(target, { x: 170, y: 110 }, sourceAbove), 'n');
  // Aimed at the right edge: the user's choice wins regardless of where the source is.
  assert.equal(pickTargetSide(target, { x: 290, y: 100 }, sourceAbove), 'e');
  // Aimed at the bottom edge.
  assert.equal(pickTargetSide(target, { x: 150, y: 195 }, sourceAbove), 's');
});
