/**
 * The last place the pointer was over the canvas surface, in client pixels, together with
 * the surface's own rect so the point can later be converted to viewport coordinates.
 * "Insert at pointer" placement reads this instead of every creation path tracking the
 * pointer itself. Module state, not a store: it changes on every mouse move and must
 * never trigger a re-render.
 */
export interface CanvasPointer {
  /** Client-space pointer position. */
  x: number;
  y: number;
  /** The canvas surface's bounding rect, captured at the same moment. */
  rect: { left: number; top: number; width: number; height: number };
}

let pointer: CanvasPointer | null = null;

export function trackCanvasPointer(x: number, y: number, rect: DOMRect): void {
  pointer = { x, y, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
}

/** Null until the pointer has been over the canvas surface at least once. */
export function canvasPointer(): CanvasPointer | null {
  return pointer;
}

/** Whether a client point sits inside the canvas surface rect the pointer was last seen with. */
export function pointerOverCanvas(candidate: CanvasPointer): boolean {
  const { x, y, rect } = candidate;
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}
