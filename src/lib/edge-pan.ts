/**
 * Auto-pan while dragging: when the pointer nears the edge of the canvas, the view should
 * scroll so the window can be carried further. Pure — the caller applies the velocity.
 */

export interface EdgeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Width of the hot zone along each edge, in screen px. */
export const EDGE_MARGIN = 56;
/** Fastest pan, in screen px per animation frame. */
export const EDGE_MAX_SPEED = 22;

function axis(position: number, low: number, high: number, margin: number, maxSpeed: number): number {
  // Closer to (or past) the edge → faster, easing in from 0 at the edge of the hot zone.
  if (position < low + margin) return Math.min(1, (low + margin - position) / margin) * maxSpeed;
  if (position > high - margin) return -Math.min(1, (position - (high - margin)) / margin) * maxSpeed;
  return 0;
}

/**
 * How far to move the view this frame (screen px; positive x = content slides right, i.e. the
 * view reveals what is to the left). Zero while the pointer is clear of the edges, or when the
 * rectangle is too small to have a hot zone on both sides of an axis.
 */
export function edgePanVelocity(
  pointer: { x: number; y: number },
  rect: EdgeRect,
  margin = EDGE_MARGIN,
  maxSpeed = EDGE_MAX_SPEED,
): { x: number; y: number } {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const mx = Math.min(margin, width / 3);
  const my = Math.min(margin, height / 3);
  return {
    x: width > 0 ? axis(pointer.x, rect.left, rect.right, mx, maxSpeed) : 0,
    y: height > 0 ? axis(pointer.y, rect.top, rect.bottom, my, maxSpeed) : 0,
  };
}
