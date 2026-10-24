import { activeWorkspace, useCanvas } from '@/store/canvas';
import { setLiveRect } from '@/lib/live-rects';

export function snapValue(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / 20) * 20 : Math.round(value);
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
    delta = {
      x: snapValue(anchor.x + dx / zoom, event.shiftKey) - anchor.x,
      y: snapValue(anchor.y + dy / zoom, event.shiftKey) - anchor.y,
    };
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
