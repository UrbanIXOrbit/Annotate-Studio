import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Box } from './connectors.ts';
import { LAYOUT, planDragDelta, snapMove, snapResize, snapToUnit } from './layout.ts';

const box = (x: number, y: number, width = 100, height = 100): Box => ({ x, y, width, height });

/** Whether `box` really has an edge or centre on the guide line. */
function sitsOn(item: Box, axis: 'x' | 'y', at: number): boolean {
  const values = axis === 'x' ? [item.x, item.x + item.width / 2, item.x + item.width] : [item.y, item.y + item.height / 2, item.y + item.height];
  return values.some((v) => Math.abs(v - at) <= 0.5);
}

test('snapToUnit rounds to the shared grid, or just to whole pixels', () => {
  assert.equal(snapToUnit(29, true), 20);
  assert.equal(snapToUnit(31, true), 40);
  assert.equal(snapToUnit(29.6, false), 30);
});

test('snapMove lines an edge up with a neighbour and reports that line', () => {
  const plan = snapMove(box(196, 500), [box(300, 0)], 8);
  // the moving item's right edge (296) is pulled to the neighbour's left edge (300)
  assert.equal(plan.offsetX, 4);
  assert.deepEqual(plan.guides.filter((g) => g.axis === 'x').map((g) => g.at), [300]);
});

test('snapMove does nothing beyond the magnet distance, apart from rounding', () => {
  const plan = snapMove(box(150.4, 500.6), [box(300, 0)], 8);
  assert.ok(Math.abs(plan.offsetX - -0.4) < 1e-9);
  assert.ok(Math.abs(plan.offsetY - 0.4) < 1e-9);
  assert.deepEqual(plan.guides, []);
  assert.deepEqual(plan.spacing, []);
});

test('equal spacing is measured between facing edges, so items of different widths get equal gaps', () => {
  // L spans 0..100 and R spans 600..900; a 200-wide item fits between them. The old rule equalised
  // centre distances and left gaps of 200 and 100; equal gaps are 150 and 150, at x = 250.
  const others = [box(0, 0, 100, 100), box(600, 0, 300, 100)];
  for (const x of [244, 250, 256]) {
    const plan = snapMove(box(x, 0, 200, 100), others, 8);
    const finalX = x + plan.offsetX;
    assert.equal(finalX, 250, `x=${x} snaps to 250`);
    assert.equal(finalX - 100, 600 - (finalX + 200), 'the two gaps are equal');
    const gaps = plan.spacing.filter((m) => m.axis === 'x');
    assert.equal(gaps.length, 2, 'one marker per gap');
    assert.deepEqual(gaps.map((m) => m.to - m.from), [150, 150]);
  }
  // x = 300 is where the old centre-based rule would have snapped: the gaps there are 200 and 100.
  const old = snapMove(box(300, 0, 200, 100), others, 8);
  assert.equal(300 + old.offsetX, 300, 'unequal gaps are no longer treated as an equal-spacing spot');
  assert.deepEqual(old.spacing, [], 'and no equal-spacing marker is shown for them');
});

test('equal spacing also works vertically', () => {
  const others = [box(0, 0, 100, 100), box(0, 500, 100, 200)];
  const plan = snapMove(box(0, 244, 100, 100), others, 8);
  const y = 244 + plan.offsetY;
  assert.equal(y, 250);
  assert.equal(y - 100, 500 - (y + 100));
  assert.equal(plan.spacing.filter((m) => m.axis === 'y').length, 2);
});

test('a neighbour that is not in the same row does not count for equal spacing', () => {
  // L is far above the moving item's row, so there is no row to even out.
  const others = [box(0, 1000, 100, 100), box(600, 0, 100, 100)];
  const plan = snapMove(box(250, 0, 100, 100), others, 8);
  assert.deepEqual(plan.spacing, []);
});

test('no guide is ever drawn for an alignment the final position does not have', () => {
  // The old code drew an alignment line at 197 and then pulled the item to 200 for equal spacing.
  const others = [box(0, 0), box(400, 0), box(197, 300)];
  const plan = snapMove(box(190, 0), others, 8);
  const final = box(190 + plan.offsetX, 0 + plan.offsetY);
  assert.ok(plan.guides.length > 0);
  for (const g of plan.guides) assert.ok(sitsOn(final, g.axis, g.at), `guide ${g.axis}=${g.at} must hold at x=${final.x}`);
});

test('every guide and marker is true at the final position (randomised layouts)', () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff);
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
  for (let trial = 0; trial < 400; trial += 1) {
    const others = Array.from({ length: between(1, 7) }, () => box(between(0, 900), between(0, 600), between(60, 360), between(60, 300)));
    const moving = box(between(0, 900) + rand(), between(0, 600) + rand(), between(60, 360), between(60, 300));
    const plan = snapMove(moving, others, 8);
    const final = { ...moving, x: moving.x + plan.offsetX, y: moving.y + plan.offsetY };
    assert.equal(final.x, Math.round(final.x), 'x is a whole pixel');
    assert.equal(final.y, Math.round(final.y), 'y is a whole pixel');
    for (const g of plan.guides) assert.ok(sitsOn(final, g.axis, g.at), `trial ${trial}: guide ${g.axis}=${g.at} does not hold`);
    for (let i = 0; i < plan.spacing.length; i += 2) {
      const a = plan.spacing[i]!;
      const b = plan.spacing[i + 1]!;
      assert.ok(Math.abs(a.to - a.from - (b.to - b.from)) <= 1, `trial ${trial}: unequal gap markers`);
      assert.ok(a.to - a.from >= 1);
    }
  }
});

test('planDragDelta: Alt moves freely, Shift snaps to the grid, plain drags use the magnets', () => {
  const others = [box(300, 0)];
  const target = [box(100, 500)];
  // near an alignment: plain drag magnets, Alt does not
  const plain = planDragDelta(target, others, 96.4, 0, {}, 1);
  assert.equal(plain.offsetX, 100, 'right edge 296..300 → pulled in by the magnet');
  assert.ok(plain.guides.length > 0);
  const free = planDragDelta(target, others, 96.4, 0.6, { free: true }, 1);
  assert.deepEqual(free, { offsetX: 96, offsetY: 1, guides: [], spacing: [] });
  const grid = planDragDelta(target, others, 96.4, 3, { grid: true }, 1);
  assert.equal((100 + grid.offsetX) % LAYOUT.unit, 0);
  assert.equal((500 + grid.offsetY) % LAYOUT.unit, 0);
  assert.deepEqual(grid.guides, []);
  // Alt wins over Shift: free movement means free movement
  assert.deepEqual(planDragDelta(target, others, 96.4, 3, { free: true, grid: true }, 1).guides, []);
  assert.equal(planDragDelta(target, others, 96.4, 3, { free: true, grid: true }, 1).offsetX, 96);
});

test('planDragDelta keeps the unsnapped axis on whole pixels when only one axis snaps', () => {
  const plan = planDragDelta([box(100, 500)], [box(300, 0)], 96.4, 20.7, {}, 1);
  assert.equal(Number.isInteger(plan.offsetX), true);
  assert.equal(Number.isInteger(plan.offsetY), true, 'the free axis used to stay fractional once the other axis snapped');
});

test('planDragDelta scales the magnet distance with zoom (8 screen pixels)', () => {
  const others = [box(300, 0)];
  // 18 world px away: too far at zoom 1 (8px), within reach at zoom 0.4 (20 world px)
  assert.equal(planDragDelta([box(100, 500)], others, 82, 0, {}, 1).guides.length, 0);
  assert.ok(planDragDelta([box(100, 500)], others, 82, 0, {}, 0.4).guides.length > 0);
});

test('planDragDelta with nothing to snap to just rounds', () => {
  assert.deepEqual(planDragDelta([box(0, 0)], [], 10.6, -3.4, {}, 1), { offsetX: 11, offsetY: -3, guides: [], spacing: [] });
  assert.deepEqual(planDragDelta([], [box(0, 0)], 10.6, -3.4, {}, 1), { offsetX: 11, offsetY: -3, guides: [], spacing: [] });
});

test('a multi-window drag snaps by the bounding box of the whole set', () => {
  const targets = [box(0, 0, 100, 100), box(200, 0, 100, 100)]; // together 0..300 wide
  const plan = planDragDelta(targets, [box(600, 0, 100, 100)], 296, 400, {}, 1);
  // the group's right edge (300+296 = 596) is pulled to 600
  assert.equal(plan.offsetX, 300);
  assert.ok(plan.guides.some((g) => g.axis === 'x' && g.at === 600));
});

test('snapResize pulls the dragged edge to a neighbour and reports only that line', () => {
  const others = [box(500, 0, 200, 200)];
  const { rect, guides } = snapResize(box(0, 0, 496, 300), { right: true }, others, 8, { width: 200, height: 100 });
  assert.deepEqual(rect, { x: 0, y: 0, width: 500, height: 300 });
  assert.deepEqual(guides, [{ axis: 'x', at: 500 }]);
});

test('snapResize from the left or top edge keeps the opposite edge fixed', () => {
  const others = [box(0, 0, 200, 200)];
  const { rect } = snapResize(box(205, 203, 400, 400), { left: true, top: true }, others, 8, { width: 100, height: 100 });
  assert.deepEqual(rect, { x: 200, y: 200, width: 405, height: 403 });
  assert.equal(rect.x + rect.width, 605, 'right edge unchanged');
  assert.equal(rect.y + rect.height, 603, 'bottom edge unchanged');
});

test('snapResize never snaps below the minimum size and ignores edges that are not being dragged', () => {
  const others = [box(150, 0, 100, 100)]; // its left edge (150) is a tempting but too-small target
  const small = snapResize(box(0, 0, 146, 300), { right: true }, others, 8, { width: 200, height: 100 });
  assert.equal(small.rect.width, 146, 'would be 150 wide: not below the 200 minimum… so the free width is kept');
  const untouched = snapResize(box(0, 0, 400, 300), { bottom: true }, [box(10, 10, 200, 200), box(396, 0, 10, 10)], 8, { width: 100, height: 100 });
  assert.equal(untouched.rect.width, 400, 'the right edge was not being dragged, so it does not snap');
  assert.ok(!untouched.guides.some((g) => g.axis === 'x'));
});
