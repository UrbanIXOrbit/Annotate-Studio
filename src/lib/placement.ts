import type { Box, Point } from './connectors.ts';
import { LAYOUT } from './layout.ts';

/**
 * Where things go on the canvas: the one place that knows how to find room for a
 * window, stack a column beside an anchor, push a card out of the way and keep a
 * re-arranged block off the windows around it. Pure and deterministic so the store,
 * the card planner and the tidy planner all share the same collision rules.
 */

export interface Size {
  width: number;
  height: number;
}

/** A box on the canvas that can be told apart from the others. */
export interface PlacedBox extends Box {
  id: string;
  minimized?: boolean;
  maximized?: boolean;
}

export type Spots = Record<string, { x: number; y: number }>;

/** Whether two boxes overlap once `b` is grown by `pad` on every side. */
export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.width + pad && a.x + a.width + pad > b.x && a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;
}

function boundsOf(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Slide a box straight down until nothing is in its way. */
export function pushDown(items: Box[], rect: Box, gap: number): Point {
  let y = rect.y;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocker = items.find((item) => overlaps(item, { ...rect, y }, gap / 2));
    if (!blocker) break;
    y = blocker.y + blocker.height + gap;
  }
  return { x: rect.x, y: Math.round(y) };
}

export interface FreeSpotOptions {
  /** Where the new box would ideally be centred. */
  center: Point;
  /** Prefer spots fully inside this rectangle (the visible part of the canvas). */
  view?: Box;
  /** Air to leave around other boxes. Defaults to the layout gap. */
  gap?: number;
}

/**
 * The nearest spot to `center` where a box of `size` overlaps nothing. Spots that line
 * up with a neighbour's edge (beside it, below it, above it) are tried first so new
 * windows sit on the same lines as the ones already there. If none is free on screen, an
 * outward search over the snap grid finds room on screen before any off-screen spot is used,
 * and a final search guarantees a free spot exists before the planner gives up.
 */
export function findFreeSpot(boxes: Box[], size: Size, options: FreeSpotOptions): Point {
  const gap = options.gap ?? LAYOUT.gap;
  const { center, view } = options;
  const free = (x: number, y: number) => !boxes.some((box) => overlaps(box, { x, y, width: size.width, height: size.height }, gap / 2));
  const inView = (x: number, y: number) =>
    !view || (x >= view.x && y >= view.y && x + size.width <= view.x + view.width && y + size.height <= view.y + view.height);

  const ideal = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
  const candidates: Point[] = [ideal];
  for (const box of boxes) {
    candidates.push(
      { x: box.x + box.width + gap, y: box.y },
      { x: box.x - size.width - gap, y: box.y },
      { x: box.x, y: box.y + box.height + gap },
      { x: box.x, y: box.y - size.height - gap },
    );
  }
  const distance = (c: Point) => Math.hypot(c.x - ideal.x, c.y - ideal.y);
  const ordered = candidates.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y) })).sort((a, b) => distance(a) - distance(b));
  // Best: lined up with a neighbour and on screen. Next: anywhere on screen (on the snap grid), so the
  // canvas does not have to pan away from what the user is looking at. Then lined up but off screen
  // (the view pans to it), and last of all anywhere at all.
  const alignedInView = ordered.find((c) => free(c.x, c.y) && inView(c.x, c.y));
  if (alignedInView) return alignedInView;

  const step = LAYOUT.unit;
  const baseX = Math.round(ideal.x / step) * step;
  const baseY = Math.round(ideal.y / step) * step;
  const search = (maxRing: number, onScreen: boolean): Point | null => {
    for (let ring = 1; ring <= maxRing; ring += 1) {
      const ringSpots: Point[] = [];
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) ringSpots.push({ x: baseX + dx * step, y: baseY + dy * step });
        }
      }
      ringSpots.sort((a, b) => distance(a) - distance(b));
      const spot = ringSpots.find((c) => free(c.x, c.y) && (!onScreen || inView(c.x, c.y)));
      if (spot) return spot;
    }
    return null;
  };
  if (view) {
    const onScreen = search(40, true);
    if (onScreen) return onScreen;
  }
  const alignedAnywhere = ordered.find((c) => free(c.x, c.y));
  if (alignedAnywhere) return alignedAnywhere;
  const anywhere = search(80, false);
  if (anywhere) return anywhere;
  return { x: Math.round(ideal.x), y: Math.round(ideal.y) };
}

/**
 * Lands a new window in the cascade column beside `anchor`: it stacks below what is
 * already there, wraps to a fresh column once that slot is full, and nudges itself out
 * of any overlap. Reused for every window type so opening a run of items keeps them in
 * tidy columns instead of scattering.
 */
export function placeBeside(boxes: PlacedBox[], anchor: PlacedBox, size: Size): Point {
  const gap = LAYOUT.gap;
  const live = boxes.filter((r) => !r.minimized);
  const inSlot = (x: number) => live.filter((r) => r.id !== anchor.id && !r.maximized && Math.abs(r.x - x) < gap);
  let x = anchor.x + anchor.width + LAYOUT.columnGap;
  let members = inSlot(x);
  let attempts = 0;
  while (members.length >= LAYOUT.maxColumn && attempts < 20) {
    x = Math.max(...members.map((r) => r.x + r.width)) + LAYOUT.columnGap;
    members = inSlot(x);
    attempts += 1;
  }
  const y = members.length === 0 ? anchor.y : Math.max(...members.map((member) => member.y + member.height)) + gap;
  // Nudge downwards out of overlapping windows, like card placement does.
  let top = y;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const blocker = live.find((r) => !r.maximized && overlaps(r, { x, y: top, width: size.width, height: size.height }, gap / 2));
    if (!blocker || blocker.id === anchor.id) break;
    top = blocker.y + blocker.height + gap;
  }
  return { x: Math.round(x), y: Math.round(top) };
}

export interface ViewPort {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The smallest pan that brings `rect` fully into the viewport (with `margin` screen pixels of air),
 * leaving the zoom alone. A rect too big to fit lines up with the top-left instead. Returns the
 * same view when nothing needs to move.
 */
export function revealRect(view: ViewPort, viewport: Size, rect: Box, margin = 32): ViewPort {
  if (viewport.width <= 0 || viewport.height <= 0) return view;
  const left = rect.x * view.zoom + view.x;
  const top = rect.y * view.zoom + view.y;
  const right = left + rect.width * view.zoom;
  const bottom = top + rect.height * view.zoom;
  const axis = (start: number, end: number, room: number): number => {
    if (end - start > room - margin * 2) return margin - start;
    if (start < margin) return margin - start;
    if (end > room - margin) return room - margin - end;
    return 0;
  };
  const dx = Math.round(axis(left, right, viewport.width));
  const dy = Math.round(axis(top, bottom, viewport.height));
  return dx === 0 && dy === 0 ? view : { ...view, x: view.x + dx, y: view.y + dy };
}

export interface FootprintMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Keep a re-arranged block off the windows around it. If the block's footprint (its bounds plus
 * `margin`, e.g. a group frame's padding and header) would touch any of `others`, the whole block
 * moves, as one piece, to the nearest free spot; its inner layout is untouched. Returns the
 * placement unchanged when it already clears everything.
 */
export function clearOfOthers<T extends Box & { id: string }>(
  placement: Spots,
  items: T[],
  others: Box[],
  margin: FootprintMargin = {},
): Spots {
  if (others.length === 0 || items.length === 0) return placement;
  const placed = items.map((item) => ({ ...item, ...(placement[item.id] ?? {}) }));
  const bounds = boundsOf(placed);
  if (!bounds) return placement;
  const footprint: Box = {
    x: bounds.x - (margin.left ?? 0),
    y: bounds.y - (margin.top ?? 0),
    width: bounds.width + (margin.left ?? 0) + (margin.right ?? 0),
    height: bounds.height + (margin.top ?? 0) + (margin.bottom ?? 0),
  };
  if (!others.some((other) => overlaps(other, footprint, LAYOUT.gap / 2))) return placement;
  const spot = findFreeSpot(others, footprint, {
    center: { x: footprint.x + footprint.width / 2, y: footprint.y + footprint.height / 2 },
  });
  const dx = Math.round(spot.x - footprint.x);
  const dy = Math.round(spot.y - footprint.y);
  const shifted: Spots = {};
  for (const item of placed) shifted[item.id] = { x: Math.round(item.x + dx), y: Math.round(item.y + dy) };
  return shifted;
}
