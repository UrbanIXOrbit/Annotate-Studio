import type { Box } from './connectors.ts';

/**
 * The canvas layout rhythm: the one source of truth for spacing that dragging,
 * auto-placement of new windows, card columns and the arrange panel all share.
 * When these agree, windows that snap while being moved keep that alignment
 * after an auto-place or a tidy-up.
 */
export const LAYOUT = {
  /** Snap grid in world px (held Shift while dragging snaps to this). */
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

/** A guide line shown while an item is being dragged. */
export interface Guide {
  axis: 'x' | 'y';
  /** World position of the line on that axis. */
  at: number;
}

export interface DragPlan {
  /** Offset to add to every dragged window's current position. */
  offsetX: number;
  offsetY: number;
  /** Guide lines to display for this drag step. */
  guides: Guide[];
}

const xOffsets = (box: Box) => [box.x, box.x + box.width / 2, box.x + box.width];
const yOffsets = (box: Box) => [box.y, box.y + box.height / 2, box.y + box.height];

const closestDelta = (movingValues: number[], targets: number[], distance: number): { delta: number; at: number } | null => {
  let best: { delta: number; at: number } | null = null;
  for (const movingValue of movingValues) {
    for (const target of targets) {
      const delta = target - movingValue;
      if (Math.abs(delta) <= distance && (best === null || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, at: target };
      }
    }
  }
  return best;
};

const centerX = (box: Box) => box.x + box.width / 2;
const centerY = (box: Box) => box.y + box.height / 2;

/** Magnets for one moving item: align its edges and centre with other items,
 * and pull it into equal spacing between two neighbours. Pure, no store access. */
export function snapMove(moving: Box, others: Box[], distance: number): DragPlan {
  const guides: Guide[] = [];
  let x = moving.x;
  let y = moving.y;

  const alignedX = closestDelta([x, centerX(moving), x + moving.width], others.flatMap(xOffsets), distance);
  if (alignedX) {
    x += alignedX.delta;
    guides.push({ axis: 'x', at: alignedX.at });
  }
  const alignedY = closestDelta([y, centerY(moving), y + moving.height], others.flatMap(yOffsets), distance);
  if (alignedY) {
    y += alignedY.delta;
    guides.push({ axis: 'y', at: alignedY.at });
  }

  // Equal spacing: when the moving centre sits (nearly) equidistant between the
  // two nearest neighbours on an axis, snap to the midpoint to even the row out.
  const centered = (movingCenter: number, axis: 'x' | 'y'): number | null => {
    const neighborCenters = others
      .map((other) => (axis === 'x' ? centerX(other) : centerY(other)))
      .filter((center) => (center < movingCenter ? true : center > movingCenter));
    const lower = Math.max(...neighborCenters.filter((center) => center < movingCenter));
    const upper = Math.min(...neighborCenters.filter((center) => center > movingCenter));
    if (!isFinite(lower) || !isFinite(upper) || lower >= upper) return null;
    if (Math.abs(movingCenter - lower - (upper - movingCenter)) < distance) return (lower + upper) / 2;
    return null;
  };
  const spacingX = centered(x + moving.width / 2, 'x');
  if (spacingX !== null) {
    x = spacingX - moving.width / 2;
    guides.push({ axis: 'x', at: spacingX });
  }
  const spacingY = centered(y + moving.height / 2, 'y');
  if (spacingY !== null) {
    y = spacingY - moving.height / 2;
    guides.push({ axis: 'y', at: spacingY });
  }

  return { offsetX: x - moving.x, offsetY: y - moving.y, guides };
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
  shiftKey: boolean,
  zoom: number,
): DragPlan {
  const anchor = targets[0];
  const baseOffsetX = shiftKey && anchor ? snapToUnit(anchor.x + rawX, true) - anchor.x : Math.round(rawX);
  const baseOffsetY = shiftKey && anchor ? snapToUnit(anchor.y + rawY, true) - anchor.y : Math.round(rawY);
  if (!anchor || shiftKey || others.length === 0) {
    return { offsetX: baseOffsetX, offsetY: baseOffsetY, guides: [] };
  }
  const left = Math.min(...targets.map((target) => target.x));
  const top = Math.min(...targets.map((target) => target.y));
  const right = Math.max(...targets.map((target) => target.x + target.width));
  const bottom = Math.max(...targets.map((target) => target.y + target.height));
  const moving: Box = { x: left + rawX, y: top + rawY, width: right - left, height: bottom - top };
  const snapped = snapMove(moving, others, Math.max(1, LAYOUT.guideDistance / zoom));
  if (snapped.guides.length === 0) {
    // No magnet fired; keep the old free movement (rounded to whole pixels).
    return { offsetX: baseOffsetX, offsetY: baseOffsetY, guides: [] };
  }
  return { offsetX: rawX + snapped.offsetX, offsetY: rawY + snapped.offsetY, guides: snapped.guides };
}
