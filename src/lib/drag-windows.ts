import { activeWorkspace, hiddenResourceIds, useCanvas } from '@/store/canvas';
import { edgePanVelocity } from '@/lib/edge-pan';
import { setLiveRect } from '@/lib/live-rects';
import { planDragDelta, snapToUnit } from '@/lib/layout';
import { useAlignmentGuides } from '@/store/guides';
import type { Connector } from '@/lib/connectors';

export function snapValue(value: number, enabled: boolean): number {
  return snapToUnit(value, enabled);
}

/** Expand `ids` across the link graph: every window reachable from them over
 * connectors (edges used in both directions), so a shift-drag can carry the
 * windows they are chained to as one rigid group. */
export function linkedComponent(ids: string[], connectors: Connector[]): string[] {
  if (connectors.length === 0) return [...new Set(ids)];
  const neighbours = new Map<string, string[]>();
  for (const link of connectors) {
    if (link.from === link.to) continue;
    neighbours.set(link.from, [...(neighbours.get(link.from) ?? []), link.to]);
    neighbours.set(link.to, [...(neighbours.get(link.to) ?? []), link.from]);
  }
  const carry = new Set(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const next of neighbours.get(id) ?? []) {
      if (!carry.has(next)) {
        carry.add(next);
        queue.push(next);
      }
    }
  }
  return [...carry];
}

export interface DragWindowsOptions {
  /** Windows to move. The first is the one under the pointer (snapping is judged from it). */
  ids: string[];
  /** Pointer position (client pixels) when the drag began. */
  start: { x: number; y: number };
  zoom: number;
  /** Element that receives the pointer events. */
  handle: HTMLElement;
  pointerId: number;
  /** Let dropped cards join or leave groups. Off when a whole group moves together. */
  reconcile: boolean;
  onMoveStart?: () => void;
  onFinish?: (moved: boolean) => void;
}

/**
 * Drag several windows as one (or a single window — it is the same drag). The frames are moved directly in the
 * page while the pointer moves (cheap, and connectors and group frames follow through the live-rect channel);
 * the store only learns the final positions on release, as one undo step.
 *
 * While dragging: Shift snaps to the 20px grid, Alt moves freely (no magnets, no grid, no guides), Escape
 * cancels the move (windows and view go back where they were), and holding the pointer near the edge of the
 * canvas pans the view so the windows can be carried further.
 */
export function dragWindows(options: DragWindowsOptions): void {
  const { ids, start, zoom, handle, pointerId } = options;
  const workspace = activeWorkspace(useCanvas.getState());
  const targets = ids
    .map((id) => workspace.resources.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined && !r.maximized);
  if (targets.length === 0) return;
  const hidden = hiddenResourceIds(workspace);
  const movedIds = new Set(targets.map((r) => r.id));
  const others = workspace.resources.filter(
    (r) => !movedIds.has(r.id) && !r.minimized && !r.maximized && !hidden.has(r.id),
  );
  const frames = new Map(targets.map((r) => [r.id, document.querySelector<HTMLElement>(`[data-window-id="${r.id}"]`)]));
  const surface = handle.closest<HTMLElement>('[data-canvas-surface]');
  const view0 = workspace.view;
  handle.setPointerCapture(pointerId);

  let moved = false;
  let finished = false;
  let delta = { x: 0, y: 0 };
  let raf = 0;
  const pointer = { x: start.x, y: start.y, shift: false, alt: false };

  /** Recompute where the windows go from the latest pointer, modifiers and view (the view may have panned). */
  const apply = () => {
    const view = activeWorkspace(useCanvas.getState()).view;
    const dx = (pointer.x - start.x - (view.x - view0.x)) / zoom;
    const dy = (pointer.y - start.y - (view.y - view0.y)) / zoom;
    const plan = planDragDelta(targets, others, dx, dy, { grid: pointer.shift, free: pointer.alt }, zoom);
    delta = { x: plan.offsetX, y: plan.offsetY };
    useAlignmentGuides.getState().set(plan.guides, plan.spacing);
    for (const r of targets) {
      const x = r.x + delta.x;
      const y = r.y + delta.y;
      const frame = frames.get(r.id);
      if (frame) frame.style.transform = `translate(${x}px, ${y}px)`;
      setLiveRect(r.id, { x, y, width: r.width, height: r.height });
    }
  };

  const tick = () => {
    raf = 0;
    if (finished || !moved || !surface) return;
    const velocity = edgePanVelocity({ x: pointer.x, y: pointer.y }, surface.getBoundingClientRect());
    if (velocity.x === 0 && velocity.y === 0) return;
    useCanvas.getState().panBy(velocity.x, velocity.y);
    apply();
    raf = requestAnimationFrame(tick);
  };
  const scheduleEdgePan = () => {
    if (!raf && surface) raf = requestAnimationFrame(tick);
  };

  const onMove = (event: PointerEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.shift = event.shiftKey;
    pointer.alt = event.altKey;
    if (!moved && Math.hypot(pointer.x - start.x, pointer.y - start.y) < 3) return;
    if (!moved) {
      moved = true;
      options.onMoveStart?.();
    }
    apply();
    scheduleEdgePan();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
      return;
    }
    if (event.key === 'Alt' || event.key === 'Shift') {
      pointer.alt = event.altKey;
      pointer.shift = event.shiftKey;
      if (moved) apply();
    }
  };

  const finish = (cancelled = false) => {
    if (finished) return;
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    useAlignmentGuides.getState().clear();
    if (cancelled) {
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
    }
    if (moved) {
      const positions = cancelled
        ? {}
        : Object.fromEntries(targets.map((r) => [r.id, { x: r.x + delta.x, y: r.y + delta.y }]));
      if (!cancelled) useCanvas.getState().placeResources(positions, { reconcile: options.reconcile });
      for (const r of targets) {
        setLiveRect(r.id, null);
        // The store position is now authoritative; make sure the frame shows it even if nothing re-rendered.
        const frame = frames.get(r.id);
        const latest = activeWorkspace(useCanvas.getState()).resources.find((candidate) => candidate.id === r.id);
        if (frame && latest) frame.style.transform = `translate(${latest.x}px, ${latest.y}px)`;
      }
      // A cancelled move also gives the view back, so the canvas is exactly as it was before the drag.
      if (cancelled) useCanvas.getState().setView(view0);
    }
    options.onFinish?.(moved && !cancelled);
  };
  const onUp = () => finish(false);

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  // Capture phase, so Escape cancels the drag before anything else (the canvas clears the selection on Escape).
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
}
