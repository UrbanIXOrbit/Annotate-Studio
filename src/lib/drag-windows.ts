import { activeWorkspace, hiddenResourceIds, useCanvas } from '@/store/canvas';
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
 * Drag several windows as one. Like a single-window drag, the frames are moved directly in the page while the
 * pointer moves (cheap, and connectors and group frames follow through the live-rect channel); the store only
 * learns the final positions on release, as one undo step.
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
  const anchor = targets[0];
  const frames = new Map(targets.map((r) => [r.id, document.querySelector<HTMLElement>(`[data-window-id="${r.id}"]`)]));
  handle.setPointerCapture(pointerId);

  let moved = false;
  let delta = { x: 0, y: 0 };

  const onMove = (event: PointerEvent) => {
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      options.onMoveStart?.();
    }
    const plan = planDragDelta(targets, others, dx / zoom, dy / zoom, event.shiftKey, zoom);
    delta = { x: plan.offsetX, y: plan.offsetY };
    useAlignmentGuides.getState().set(plan.guides);
    for (const r of targets) {
      const x = r.x + delta.x;
      const y = r.y + delta.y;
      const frame = frames.get(r.id);
      if (frame) frame.style.transform = `translate(${x}px, ${y}px)`;
      setLiveRect(r.id, { x, y, width: r.width, height: r.height });
    }
  };

  const finish = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    useAlignmentGuides.getState().set([]);
    if (moved) {
      const positions = Object.fromEntries(targets.map((r) => [r.id, { x: r.x + delta.x, y: r.y + delta.y }]));
      useCanvas.getState().placeResources(positions, { reconcile: options.reconcile });
      for (const r of targets) {
        setLiveRect(r.id, null);
        // The store position is now authoritative; make sure the frame shows it even if nothing re-rendered.
        const frame = frames.get(r.id);
        const latest = activeWorkspace(useCanvas.getState()).resources.find((candidate) => candidate.id === r.id);
        if (frame && latest) frame.style.transform = `translate(${latest.x}px, ${latest.y}px)`;
      }
    }
    options.onFinish?.(moved);
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}
