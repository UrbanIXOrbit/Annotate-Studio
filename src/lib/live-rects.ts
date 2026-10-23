import { useSyncExternalStore } from 'react';
import type { Box } from './connectors.ts';

/**
 * Windows are moved by writing transforms straight to the DOM while dragging, so the
 * store only learns the final position on release. Connectors read these in-flight
 * rectangles so they follow a window live instead of snapping on drop.
 */
const live = new Map<string, Box>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function setLiveRect(id: string, rect: Box | null): void {
  if (rect === null) {
    if (live.delete(id)) emit();
    return;
  }
  live.set(id, rect);
  emit();
}

export function getLiveRect(id: string): Box | undefined {
  return live.get(id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the caller whenever any in-flight window rectangle changes. */
export function useLiveRectVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
