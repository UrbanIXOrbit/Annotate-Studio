'use client';

import type React from 'react';
import type { InboxLane } from '@/lib/inbox-board';

/**
 * Pointer-based drag & drop for the Inbox board.
 *
 * The desktop webview gives every drag to Tauri's native file-drop handler
 * (`dragDropEnabled` stays on for Finder→app imports), so HTML5
 * dragstart/dragover/drop never reach the DOM. The board therefore runs on
 * pointer events: pressing a card arms it, moving past a small threshold lifts
 * it with a ghost pill, `document.elementFromPoint` resolves the card or lane
 * under the cursor, and release performs the drop.
 */

export interface InboxDropTarget {
  lane: InboxLane;
  /** Start line of the hovered card, for the visual hint only. */
  start: number | null;
  /** Stable identity of the hovered card, used to apply the drop. */
  key: string | null;
  where: 'before' | 'after';
}

export interface InboxDragSnapshot {
  dragging: string | null;
  target: InboxDropTarget | null;
}

interface BeginOptions {
  key: string;
  label: string;
  onDrop: (sourceKey: string, target: InboxDropTarget) => void;
  onDoubleClick: (sourceKey: string) => void;
  onState: (snapshot: InboxDragSnapshot) => void;
}

interface DragActor extends BeginOptions {
  source: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  ghost: HTMLElement | null;
  target: InboxDropTarget | null;
}

const DRAG_THRESHOLD = 6;
const DOUBLE_TAP_MS = 350;
/** Elements a drag must not start on (their controls keep the pointerdown). */
const DRAG_START_BLOCKED = 'input, button, textarea, select, a, label, [contenteditable="true"]';

let actor: DragActor | null = null;
let listenersBound = false;
let lastTap: { key: string; at: number } | null = null;
let rafId: number | null = null;
let lastFrame = 0;

export function isInboxDragBlocked(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(DRAG_START_BLOCKED);
}

function createGhost(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'inbox-drag-ghost';
  el.textContent = label.length > 90 ? `${label.slice(0, 90)}…` : label;
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top = '0';
  el.style.zIndex = '1000';
  el.style.pointerEvents = 'none';
  el.style.willChange = 'transform';
  document.body.appendChild(el);
  return el;
}

function sameTarget(a: InboxDropTarget | null, b: InboxDropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.lane === b.lane && a.key === b.key && a.where === b.where;
}

function publish(): void {
  if (actor) actor.onState({ dragging: actor.key, target: actor.target });
}

function clearVisuals(current: DragActor): void {
  current.ghost?.remove();
  current.source.classList.remove('inbox-card-dragging');
}

function finish(): void {
  if (!actor) return;
  const current = actor;
  clearVisuals(current);
  actor = null;
  unbindWindowListeners();
  current.onState({ dragging: null, target: null });
}

/** Abort an in-flight drag, e.g. when the board unmounts. */
export function cancelInboxDrag(): void {
  finish();
}

function moveGhost(current: DragActor, event: PointerEvent): void {
  if (current.ghost) {
    current.ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
  }
}

/** Nearest ancestor that can actually scroll vertically (lane body first). */
function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return element.closest<HTMLElement>('.view-scroll');
}

/** The lane under the pointer (not the source lane) owns edge scrolling. */
function scrollContainerFor(current: DragActor): HTMLElement | null {
  const lane = current.target?.lane;
  if (lane) {
    const body = document.querySelector<HTMLElement>(`section[data-inbox-lane="${lane}"] .inbox-lane-body`);
    if (body && body.scrollHeight > body.clientHeight + 1) return body;
  }
  return scrollableAncestor(current.source);
}

function stopAutoScroll(): void {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  lastFrame = 0;
}

/** Time-based scrolling; keeps going while the pointer rests near an edge. */
function autoScrollFrame(now: number): void {
  if (!actor || !actor.ghost) {
    rafId = null;
    lastFrame = 0;
    return;
  }
  const dt = lastFrame ? Math.min(now - lastFrame, 50) : 16;
  lastFrame = now;
  const container = scrollContainerFor(actor);
  if (container) {
    const rect = container.getBoundingClientRect();
    const edge = 48;
    let delta = 0;
    if (actor.lastY < rect.top + edge) {
      delta = -Math.ceil(((rect.top + edge - actor.lastY) / edge) * 0.7 * dt);
    } else if (actor.lastY > rect.bottom - edge) {
      delta = Math.ceil(((actor.lastY - (rect.bottom - edge)) / edge) * 0.7 * dt);
    }
    if (delta !== 0) {
      const before = container.scrollTop;
      container.scrollTop = before + delta;
      // The lane scrolled under a still pointer: refresh the drop target.
      if (container.scrollTop !== before) resolveTarget(actor, actor.lastX, actor.lastY);
    }
  }
  rafId = requestAnimationFrame(autoScrollFrame);
}

function resolveTarget(current: DragActor, x: number, y: number): void {
  const element = document.elementFromPoint(x, y);
  const cardEl = element?.closest<HTMLElement>('[data-inbox-card]') ?? null;
  let next: InboxDropTarget | null = null;

  if (cardEl && cardEl !== current.source) {
    const start = Number(cardEl.dataset.inboxCard);
    const key = cardEl.dataset.inboxKey ?? null;
    const lane = cardEl.dataset.inboxLane as InboxLane | undefined;
    if (Number.isFinite(start) && lane) {
      const rect = cardEl.getBoundingClientRect();
      next = { lane, start, key, where: y < rect.top + rect.height / 2 ? 'before' : 'after' };
    }
  } else if (!cardEl) {
    const laneEl = element?.closest<HTMLElement>('[data-inbox-lane]') ?? null;
    const lane = laneEl?.dataset.inboxLane as InboxLane | undefined;
    if (lane) next = { lane, start: null, key: null, where: 'after' };
  }

  if (!sameTarget(current.target, next)) {
    current.target = next;
    publish();
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!actor || event.pointerId !== actor.pointerId) return;
  const current = actor;
  current.lastX = event.clientX;
  current.lastY = event.clientY;
  const dx = event.clientX - current.startX;
  const dy = event.clientY - current.startY;

  // Not a drag yet: a small wiggle stays a click/double-click.
  if (!current.ghost) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    current.ghost = createGhost(current.label);
    current.source.classList.add('inbox-card-dragging');
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();
    publish();
    if (rafId === null) {
      lastFrame = 0;
      rafId = requestAnimationFrame(autoScrollFrame);
    }
  }

  moveGhost(current, event);
  resolveTarget(current, event.clientX, event.clientY);
}

function onPointerUp(event: PointerEvent): void {
  if (!actor || event.pointerId !== actor.pointerId) return;
  const current = actor;
  const finished = current.ghost !== null;
  const target = current.target;
  const sourceCard =
    document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-inbox-card]') ?? null;

  clearVisuals(current);
  actor = null;
  unbindWindowListeners();
  current.onState({ dragging: null, target: null });

  if (finished) {
    // Swallow the click the browser derives from this gesture.
    lastTap = null;
    if (target) current.onDrop(current.key, target);
    return;
  }

  // No movement: this is a tap. Two quick taps open the inline editor.
  if (sourceCard && sourceCard.dataset.inboxKey === current.key) {
    const now = Date.now();
    if (lastTap && lastTap.key === current.key && now - lastTap.at < DOUBLE_TAP_MS) {
      lastTap = null;
      current.onDoubleClick(current.key);
    } else {
      lastTap = { key: current.key, at: now };
    }
  }
}

function onPointerCancel(event: PointerEvent): void {
  if (actor && event.pointerId !== actor.pointerId) return;
  finish();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') finish();
}

function bindWindowListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', finish);
}

function unbindWindowListeners(): void {
  stopAutoScroll();
  if (!listenersBound) return;
  listenersBound = false;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('blur', finish);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

/**
 * Arm a card from its pointerdown. The drag only lifts once the pointer moves
 * past the threshold, so normal taps and double-taps keep working.
 */
export function beginInboxDrag(event: React.PointerEvent<HTMLElement>, options: BeginOptions): void {
  if (actor || event.button !== 0 || event.ctrlKey || event.metaKey) return;
  if (isInboxDragBlocked(event.target)) return;
  const source = event.currentTarget;
  try {
    source.setPointerCapture(event.pointerId);
  } catch {
    // Capture is a convenience; the window listeners track the pointer anyway.
  }
  actor = {
    ...options,
    source,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    ghost: null,
    target: null,
  };
  bindWindowListeners();
}
