import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT } from './layout.ts';
import { clearOfOthers, findFreeSpot, overlaps, placeBeside, pushDown, revealRect, type PlacedBox } from './placement.ts';

const box = (id: string, x: number, y: number, width = 300, height = 200): PlacedBox => ({ id, x, y, width, height });

function anyOverlap(boxes: PlacedBox[]): boolean {
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (overlaps(boxes[i], boxes[j])) return true;
  return false;
}

test('overlaps counts shared area, and a pad widens the test on every side', () => {
  assert.equal(overlaps(box('a', 0, 0), box('b', 299, 0)), true);
  assert.equal(overlaps(box('a', 0, 0), box('b', 300, 0)), false, 'touching is not overlapping');
  assert.equal(overlaps(box('a', 0, 0), box('b', 310, 0), 12), true);
  assert.equal(overlaps(box('a', 0, 0), box('b', -310, 0), 12), true);
  assert.equal(overlaps(box('a', 0, 0), box('b', 0, 330), 12), false);
});

test('pushDown slides a box below every blocker, leaving the gap', () => {
  const items = [box('a', 0, 0), box('b', 0, 240)];
  const spot = pushDown(items, box('new', 0, 10), 40);
  assert.deepEqual(spot, { x: 0, y: 480 });
  assert.deepEqual(pushDown([], box('new', 5, 7), 40), { x: 5, y: 7 });
});

test('findFreeSpot returns the ideal spot when it is free', () => {
  const spot = findFreeSpot([box('a', 1000, 1000)], { width: 400, height: 300 }, { center: { x: 500, y: 400 } });
  assert.deepEqual(spot, { x: 300, y: 250 });
});

test('findFreeSpot lines a new window up with a neighbour when the centre is taken', () => {
  const neighbour = box('a', 100, 100, 600, 500);
  const spot = findFreeSpot([neighbour], { width: 300, height: 200 }, { center: { x: 400, y: 350 } });
  assert.equal(overlaps(neighbour, { ...spot, width: 300, height: 200 }, LAYOUT.gap / 2), false);
  const alignedLeft = spot.x === neighbour.x || spot.x === neighbour.x + neighbour.width + LAYOUT.gap || spot.x + 300 === neighbour.x - LAYOUT.gap;
  const alignedTop = spot.y === neighbour.y || spot.y === neighbour.y + neighbour.height + LAYOUT.gap || spot.y + 200 === neighbour.y - LAYOUT.gap;
  assert.ok(alignedLeft || alignedTop, `expected an aligned spot, got ${JSON.stringify(spot)}`);
});

test('findFreeSpot prefers a spot inside the view over a nearer one outside it', () => {
  const view = { x: 0, y: 0, width: 1000, height: 700 };
  const blocker = box('a', 600, 100, 350, 500);
  // The ideal spot is blocked. The nearest aligned spot (above the blocker) is off screen; the left one is on screen.
  const spot = findFreeSpot([blocker], { width: 300, height: 200 }, { center: { x: 800, y: 250 }, view });
  assert.deepEqual(spot, { x: 276, y: 100 });
  const withoutView = findFreeSpot([blocker], { width: 300, height: 200 }, { center: { x: 800, y: 250 } });
  assert.deepEqual(withoutView, { x: 600, y: -124 }, 'without a view, the nearest aligned spot wins even when it is off screen');
});

test('findFreeSpot searches the screen for room before settling for an off-screen spot', () => {
  const view = { x: 0, y: 0, width: 700, height: 500 };
  // Blockers whose edges only offer off-screen aligned spots, leaving an unaligned hole on screen.
  const blockers = [box('a', 0, 0, 700, 100), box('b', 400, 124, 300, 376)];
  const spot = findFreeSpot(blockers, { width: 280, height: 200 }, { center: { x: 200, y: 300 }, view });
  assert.ok(spot.x >= 0 && spot.y >= 0 && spot.x + 280 <= 700 && spot.y + 200 <= 500, JSON.stringify(spot));
  for (const b of blockers) assert.equal(overlaps(b, { ...spot, width: 280, height: 200 }, LAYOUT.gap / 2), false);
});

test('findFreeSpot still finds room when every neighbour-aligned spot is taken', () => {
  // A dense wall of windows with no gaps big enough anywhere near the centre.
  const wall: PlacedBox[] = [];
  for (let col = 0; col < 8; col += 1) for (let row = 0; row < 8; row += 1) wall.push(box(`w${col}-${row}`, col * 310, row * 210, 300, 200));
  const spot = findFreeSpot(wall, { width: 300, height: 200 }, { center: { x: 1200, y: 800 } });
  for (const w of wall) assert.equal(overlaps(w, { ...spot, width: 300, height: 200 }, LAYOUT.gap / 2), false, `overlaps ${w.id}`);
});

test('placing many windows one after another never overlaps (deterministic pseudo-random sizes)', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const placed: PlacedBox[] = [];
  const view = { x: 0, y: 0, width: 1400, height: 800 };
  for (let i = 0; i < 40; i += 1) {
    const size = { width: 260 + Math.round(rand() * 400), height: 180 + Math.round(rand() * 400) };
    const spot = findFreeSpot(placed, size, { center: { x: 700, y: 400 }, view });
    placed.push({ id: `p${i}`, ...spot, ...size });
  }
  assert.equal(anyOverlap(placed), false);
});

test('placeBeside puts a window to the right of its anchor, never on top of it (anchor near the right edge)', () => {
  // This is the case that used to overlap by 100px: the planned spot was clamped back into the view.
  const anchor = box('anchor', 740, 60, 500, 600);
  const spot = placeBeside([anchor], anchor, { width: 680, height: 560 });
  assert.equal(spot.x, 740 + 500 + LAYOUT.columnGap);
  assert.equal(spot.y, 60);
  assert.equal(overlaps(anchor, { ...spot, width: 680, height: 560 }), false);
});

test('a run of windows opened from one anchor stacks in columns and wraps without overlapping', () => {
  const anchor = box('w0', 60, 60, 500, 400);
  const placed: PlacedBox[] = [anchor];
  for (let i = 1; i <= 12; i += 1) {
    const size = { width: 400, height: 260 };
    const spot = placeBeside(placed, anchor, size);
    placed.push({ id: `w${i}`, ...spot, ...size });
  }
  assert.equal(anyOverlap(placed), false);
  const columns = new Set(placed.slice(1).map((p) => p.x));
  assert.equal(columns.size, Math.ceil(12 / LAYOUT.maxColumn), 'wraps to a new column after maxColumn windows');
  for (const x of columns) assert.equal(placed.filter((p) => p.id !== 'w0' && p.x === x).length <= LAYOUT.maxColumn, true);
});

test('revealRect pans the least amount needed and leaves the zoom alone', () => {
  const viewport = { width: 1280, height: 800 };
  const view = { x: 0, y: 0, zoom: 1 };
  assert.equal(revealRect(view, viewport, box('in', 100, 100, 400, 300)), view, 'already visible: same view back');
  const right = revealRect(view, viewport, box('r', 1288, 60, 680, 560));
  assert.equal(right.zoom, 1);
  assert.equal(right.y, 0);
  assert.equal(right.x, -(1288 + 680 - (1280 - 32)), 'the right edge ends 32px inside the viewport');
  const left = revealRect({ x: -500, y: 0, zoom: 1 }, viewport, box('l', 100, 100, 300, 300));
  assert.equal(left.x, -500 + (32 - (100 - 500)), 'panned just far enough to bring the left edge to the margin');
  const zoomed = revealRect({ x: 0, y: 0, zoom: 2 }, viewport, box('z', 700, 100, 200, 100));
  assert.equal(zoomed.x, -(1400 + 400 - (1280 - 32)), 'zoom is respected when converting to screen pixels');
  const wide = revealRect(view, viewport, box('wide', 2000, 100, 3000, 300));
  assert.equal(wide.x, 32 - 2000, 'a window too big to fit lines up with the left margin');
  assert.equal(revealRect(view, { width: 0, height: 0 }, box('x', 5000, 0)), view, 'no viewport size known: leave the view alone');
});

test('clearOfOthers leaves a block alone when it already clears its neighbours', () => {
  const items = [box('a', 0, 0), box('b', 400, 0)];
  const placement = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  assert.equal(clearOfOthers(placement, items, [box('far', 2000, 2000)]), placement);
  assert.equal(clearOfOthers(placement, items, []), placement);
});

test('clearOfOthers moves a whole block, keeping its inner layout, when it would land on a bystander', () => {
  const items = [box('a', 0, 0), box('b', 400, 0)];
  const placement = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const bystander = box('x', 100, 150, 300, 200); // under the block
  const moved = clearOfOthers(placement, items, [bystander]);
  assert.notDeepEqual(moved, placement);
  assert.equal(moved.b.x - moved.a.x, 400, 'inner offsets are untouched');
  assert.equal(moved.b.y - moved.a.y, 0);
  for (const id of ['a', 'b']) {
    const item = items.find((i) => i.id === id)!;
    assert.equal(overlaps(bystander, { ...item, ...moved[id] }, LAYOUT.gap / 2), false, `${id} clears the bystander`);
  }
});

test('clearOfOthers honours a margin such as a group frame’s padding and header', () => {
  const items = [box('a', 0, 0)];
  const placement = { a: { x: 0, y: 0 } };
  const neighbour = box('n', 0, 235); // 35px below: fine for bare windows
  assert.equal(clearOfOthers(placement, items, [neighbour]), placement);
  const withFrame = clearOfOthers(placement, items, [neighbour], { top: 68, right: 28, bottom: 28, left: 28 });
  assert.notEqual(withFrame, placement, 'the frame’s padding would touch the neighbour, so the block moves');
});
