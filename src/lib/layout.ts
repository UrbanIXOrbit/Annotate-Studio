import type { Box } from './connectors.ts';

/**
 * The canvas layout rhythm: the one source of truth for spacing that dragging,
 * auto-placement of new windows, card columns and the arrange panel all share.
 * When these agree, windows that snap while being moved keep that alignment
 * after an auto-place or a tidy-up.
 */
export const LAYOUT = {
  /** Snap grid in world px (held Shift while dragging snaps to this; held Alt turns all snapping off). */
  unit: 20,
  /** Gap between stacking windows, and the padding used when dodging overlaps. */
  gap: 24,
  /** Gap when a new window opens a fresh cascade column beside its anchor. */
  columnGap: 48,
  /** A cascade column wraps to the next column once this many windows stack. */
  maxColumn: 3,
  /** Screen-space distance at which edges and centres magnet together while moving. */
  guideDistance: 8,
} as const;

/** Round to the shared snap grid. */
export function snapToUnit(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / LAYOUT.unit) * LAYOUT.unit : Math.round(value);
}

/** A guide line shown while an item is being dragged or resized: something on the item lines up here. */
export interface Guide {
  axis: 'x' | 'y';
  /** World position of the line on that axis. */
  at: number;
}

/**
 * An equal-spacing marker: the gap between two items along `axis` (`'x'` = a horizontal gap
 * between items side by side). Drawn from `from` to `to`, at position `across` on the other axis,
 * with the gap's size as its label.
 */
export interface SpacingGuide {
  axis: 'x' | 'y';
  from: number;
  to: number;
  across: number;
}

export interface DragPlan {
  /** Offset to add to every dragged window's current position. */
  offsetX: number;
  offsetY: number;
  /** Alignment lines that really hold at the final position. */
  guides: Guide[];
  /** Equal-gap markers that really hold at the final position. */
  spacing: SpacingGuide[];
}

const xOffsets = (box: Box) => [box.x, box.x + box.width / 2, box.x + box.width];
const yOffsets = (box: Box) => [box.y, box.y + box.height / 2, box.y + box.height];

/** How close (in world px) counts as "on" a line. Positions are whole pixels, so half a pixel covers odd widths. */
const ON_LINE = 0.5;

const closestDelta = (movingValues: number[], targets: number[], distance: number): number | null => {
  let best: number | null = null;
  for (const movingValue of movingValues) {
    for (const target of targets) {
      const delta = target - movingValue;
      if (Math.abs(delta) <= distance && (best === null || Math.abs(delta) < Math.abs(best))) best = delta;
    }
  }
  return best;
};

const centerX = (box: Box) => box.x + box.width / 2;
const centerY = (box: Box) => box.y + box.height / 2;

type Axis = 'x' | 'y';
const start = (box: Box, axis: Axis) => (axis === 'x' ? box.x : box.y);
const size = (box: Box, axis: Axis) => (axis === 'x' ? box.width : box.height);
const centre = (box: Box, axis: Axis) => (axis === 'x' ? centerX(box) : centerY(box));
const end = (box: Box, axis: Axis) => start(box, axis) + size(box, axis);
const crossAxis = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');

/** The items sharing a row (for `axis` 'x') or a column ('y') with `box`, split into those before and after it. */
function neighbours(box: Box, others: Box[], axis: Axis) {
  const cross = crossAxis(axis);
  const inLine = others.filter((o) => start(o, cross) < end(box, cross) && end(o, cross) > start(box, cross));
  const before = inLine.filter((o) => centre(o, axis) < centre(box, axis));
  const after = inLine.filter((o) => centre(o, axis) > centre(box, axis));
  const nearestBefore = before.length ? before.reduce((a, b) => (end(b, axis) > end(a, axis) ? b : a)) : null;
  const nearestAfter = after.length ? after.reduce((a, b) => (start(b, axis) < start(a, axis) ? b : a)) : null;
  return { before: nearestBefore, after: nearestAfter };
}

/**
 * The move that would make the gaps on either side of `box` equal — measured between the facing
 * edges of the two nearest items in its row (or column), not between their centres, so items of
 * different widths still end up with visibly equal gaps. Null when it does not apply or is too far.
 */
function equalGapDelta(box: Box, others: Box[], axis: Axis, distance: number): number | null {
  const { before, after } = neighbours(box, others, axis);
  if (!before || !after) return null;
  const room = start(after, axis) - end(before, axis);
  if (room < size(box, axis)) return null;
  const delta = end(before, axis) + (room - size(box, axis)) / 2 - start(box, axis);
  return Math.abs(delta) <= distance ? delta : null;
}

/** Alignment lines that hold for `box` as it stands: any edge or centre within half a pixel of another item's. */
function alignmentGuides(box: Box, others: Box[]): Guide[] {
  const guides: Guide[] = [];
  const seen = new Set<string>();
  const check = (axis: Axis, mine: number[], theirs: number[]) => {
    for (const value of mine) {
      for (const target of theirs) {
        if (Math.abs(target - value) <= ON_LINE && !seen.has(`${axis}:${target}`)) {
          seen.add(`${axis}:${target}`);
          guides.push({ axis, at: target });
        }
      }
    }
  };
  check('x', xOffsets(box), others.flatMap(xOffsets));
  check('y', yOffsets(box), others.flatMap(yOffsets));
  return guides;
}

/** Equal-gap markers that hold for `box` as it stands (both gaps at least a pixel and within a pixel of each other). */
function spacingGuides(box: Box, others: Box[]): SpacingGuide[] {
  const markers: SpacingGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const { before, after } = neighbours(box, others, axis);
    if (!before || !after) continue;
    const gapBefore = start(box, axis) - end(before, axis);
    const gapAfter = start(after, axis) - end(box, axis);
    if (gapBefore < 1 || gapAfter < 1 || Math.abs(gapBefore - gapAfter) > 1) continue;
    const cross = crossAxis(axis);
    const low = Math.max(start(box, cross), start(before, cross), start(after, cross));
    const high = Math.min(end(box, cross), end(before, cross), end(after, cross));
    const across = high > low ? (low + high) / 2 : centre(box, cross);
    markers.push({ axis, from: end(before, axis), to: start(box, axis), across }, { axis, from: end(box, axis), to: start(after, axis), across });
  }
  return markers;
}

/**
 * Magnets for one moving item: line its edges and centre up with other items, or even out the gaps
 * between its two neighbours — whichever is closer on each axis. The position is then rounded to
 * whole pixels, and the guides returned are worked out from that final position, so every line or
 * marker shown is one the item really sits on. Pure, no store access.
 */
export function snapMove(moving: Box, others: Box[], distance: number): DragPlan {
  const alignX = closestDelta(xOffsets(moving), others.flatMap(xOffsets), distance);
  const alignY = closestDelta(yOffsets(moving), others.flatMap(yOffsets), distance);
  // Rows depend on where the item sits vertically, and columns on where it sits horizontally.
  const rowBox: Box = { ...moving, y: moving.y + (alignY ?? 0) };
  const columnBox: Box = { ...moving, x: moving.x + (alignX ?? 0) };
  const gapX = equalGapDelta(rowBox, others, 'x', distance);
  const gapY = equalGapDelta(columnBox, others, 'y', distance);
  const pick = (align: number | null, gap: number | null): number => {
    if (align === null) return gap ?? 0;
    if (gap === null) return align;
    return Math.abs(gap) < Math.abs(align) ? gap : align;
  };
  const x = Math.round(moving.x + pick(alignX, gapX));
  const y = Math.round(moving.y + pick(alignY, gapY));
  const final: Box = { ...moving, x, y };
  return { offsetX: x - moving.x, offsetY: y - moving.y, guides: alignmentGuides(final, others), spacing: spacingGuides(final, others) };
}

export interface DragModifiers {
  /** Snap to the 20px grid (Shift). */
  grid?: boolean;
  /** Move freely: no magnets, no grid, no guides (Alt). */
  free?: boolean;
}

/**
 * Where a drag should land. Used for single and multi window drags: the whole
 * dragged set is treated as one box so group edges align to their neighbours.
 * `rawX`/`rawY` are the unsnapped world-space drag offsets for `targets[0]`,
 * the window under the pointer.
 */
export function planDragDelta(
  targets: Box[],
  others: Box[],
  rawX: number,
  rawY: number,
  modifiers: DragModifiers,
  zoom: number,
): DragPlan {
  const anchor = targets[0];
  const free = { offsetX: Math.round(rawX), offsetY: Math.round(rawY), guides: [], spacing: [] };
  if (!anchor) return free;
  if (modifiers.free) return free;
  if (modifiers.grid) {
    return { offsetX: snapToUnit(anchor.x + rawX, true) - anchor.x, offsetY: snapToUnit(anchor.y + rawY, true) - anchor.y, guides: [], spacing: [] };
  }
  if (others.length === 0) return free;
  const left = Math.min(...targets.map((target) => target.x));
  const top = Math.min(...targets.map((target) => target.y));
  const right = Math.max(...targets.map((target) => target.x + target.width));
  const bottom = Math.max(...targets.map((target) => target.y + target.height));
  const moving: Box = { x: left + rawX, y: top + rawY, width: right - left, height: bottom - top };
  const snapped = snapMove(moving, others, Math.max(1, LAYOUT.guideDistance / zoom));
  return {
    // Rounded so float noise (96.4 + 3.6 = 100.00000000000003) never leaves a window off the pixel grid.
    offsetX: Math.round(rawX + snapped.offsetX),
    offsetY: Math.round(rawY + snapped.offsetY),
    guides: snapped.guides,
    spacing: snapped.spacing,
  };
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/**
 * Magnets for a resize: each edge being dragged lines up with another item's edge or centre when
 * it comes within `distance`, never shrinking the box below `min`. As with moving, the guides
 * returned are the lines the dragged edges really sit on afterwards.
 */
export function snapResize(
  next: Box,
  edges: ResizeEdges,
  others: Box[],
  distance: number,
  min: { width: number; height: number },
): { rect: Box; guides: Guide[] } {
  let { x, y, width, height } = next;
  const xTargets = others.flatMap(xOffsets);
  const yTargets = others.flatMap(yOffsets);
  const pull = (value: number, targets: number[]): number => {
    const delta = closestDelta([value], targets, distance);
    return delta === null ? value : value + delta;
  };
  if (edges.right) {
    const edge = pull(x + width, xTargets);
    if (edge - x >= min.width) width = edge - x;
  }
  if (edges.left) {
    const right = x + width;
    const edge = pull(x, xTargets);
    if (right - edge >= min.width) {
      x = edge;
      width = right - edge;
    }
  }
  if (edges.bottom) {
    const edge = pull(y + height, yTargets);
    if (edge - y >= min.height) height = edge - y;
  }
  if (edges.top) {
    const bottom = y + height;
    const edge = pull(y, yTargets);
    if (bottom - edge >= min.height) {
      y = edge;
      height = bottom - edge;
    }
  }
  const rect: Box = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  const guides: Guide[] = [];
  const seen = new Set<string>();
  const hit = (axis: Axis, value: number, targets: number[]) => {
    for (const target of targets) {
      if (Math.abs(target - value) <= ON_LINE && !seen.has(`${axis}:${target}`)) {
        seen.add(`${axis}:${target}`);
        guides.push({ axis, at: target });
      }
    }
  };
  if (edges.left) hit('x', rect.x, xTargets);
  if (edges.right) hit('x', rect.x + rect.width, xTargets);
  if (edges.top) hit('y', rect.y, yTargets);
  if (edges.bottom) hit('y', rect.y + rect.height, yTargets);
  return { rect, guides };
}
