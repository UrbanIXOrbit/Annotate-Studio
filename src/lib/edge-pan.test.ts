import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgePanVelocity, EDGE_MARGIN, EDGE_MAX_SPEED } from './edge-pan.ts';

const rect = { left: 100, top: 50, right: 1100, bottom: 850 };

test('no panning while the pointer is clear of the edges', () => {
  assert.deepEqual(edgePanVelocity({ x: 600, y: 400 }, rect), { x: 0, y: 0 });
  assert.deepEqual(edgePanVelocity({ x: 100 + EDGE_MARGIN, y: 50 + EDGE_MARGIN }, rect), { x: 0, y: 0 }, 'the hot zone starts just inside');
});

test('near the right or bottom edge the view slides the other way, faster the closer the pointer is', () => {
  const near = edgePanVelocity({ x: 1100 - EDGE_MARGIN / 2, y: 400 }, rect);
  const at = edgePanVelocity({ x: 1100, y: 400 }, rect);
  assert.ok(near.x < 0 && near.x > -EDGE_MAX_SPEED);
  assert.equal(at.x, -EDGE_MAX_SPEED);
  assert.ok(Math.abs(at.x) > Math.abs(near.x));
  assert.equal(near.y, 0);
  assert.ok(edgePanVelocity({ x: 600, y: 850 }, rect).y < 0);
});

test('near the left or top edge the view slides towards the pointer', () => {
  assert.ok(edgePanVelocity({ x: 110, y: 400 }, rect).x > 0);
  assert.ok(edgePanVelocity({ x: 600, y: 55 }, rect).y > 0);
});

test('past the edge the speed is capped, and corners pan on both axes', () => {
  assert.equal(edgePanVelocity({ x: 5000, y: 400 }, rect).x, -EDGE_MAX_SPEED);
  assert.equal(edgePanVelocity({ x: -500, y: 400 }, rect).x, EDGE_MAX_SPEED);
  const corner = edgePanVelocity({ x: 1095, y: 845 }, rect);
  assert.ok(corner.x < 0 && corner.y < 0);
});

test('a tiny rectangle shrinks its hot zones instead of panning everywhere', () => {
  const tiny = { left: 0, top: 0, right: 90, bottom: 90 };
  assert.deepEqual(edgePanVelocity({ x: 45, y: 45 }, tiny), { x: 0, y: 0 });
  assert.deepEqual(edgePanVelocity({ x: 5, y: 5 }, { left: 0, top: 0, right: 0, bottom: 0 }), { x: 0, y: 0 });
});
