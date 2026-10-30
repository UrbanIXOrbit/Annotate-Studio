'use client';

import React, { useEffect, useRef } from 'react';

/**
 * Pointer-based drag & drop for the Books manager.
 *
 * The desktop webview hands every drag to Tauri's native file-drop handler
 * (dragDropEnabled stays on for Finder→app imports), and that handler always
 * claims the drop — so HTML5 dragenter/dragover/drop never reach the DOM and
 * `draggable` rows cannot compose. Books drags therefore run fully on pointer
 * events: pressing a row arms the drag, moving past a small threshold lifts it
 * with a pill ghost, `document.elementFromPoint` resolves the hovered drop
 * zone, and Alt/Option turns the drop into a copy. Drop zones register
 * themselves with `useBooksDropTarget` and keep the accept/drop logic own to
 * their component, exactly like the old HTML5 handlers did.
 */

export type BooksDragPayload =
  | { kind: 'files'; fileIds: string[] }
  | { kind: 'folder'; folderId: string };

export type BooksDropMode = 'copy' | 'move';

export interface BooksDropSpec {
  accepts?: (payload: BooksDragPayload, mode: BooksDropMode) => boolean;
  onDrop: (payload: BooksDragPayload, mode: BooksDropMode) => void;
}

interface DragActor {
  payload: BooksDragPayload;
  source: HTMLElement;
  badgeLabel: string | null;
  startX: number;
  startY: number;
  ghost: HTMLElement | null;
  hovered: { zone: HTMLElement; spec: BooksDropSpec; accepted: boolean } | null;
}

let actor: DragActor | null = null;
let listenersBound = false;

const DRAG_THRESHOLD = 5;

const dropZones = new WeakMap<HTMLElement, BooksDropSpec>();

export function registerBooksDropZone(element: HTMLElement, spec: BooksDropSpec): void {
  dropZones.set(element, spec);
}

export function unregisterBooksDropZone(element: HTMLElement): void {
  dropZones.delete(element);
}

/** True right after a finished drag — swallow the click it would produce. */
let suppressClickUntil = 0;
export function booksClickSuppressed(): boolean {
  return Date.now() < suppressClickUntil;
}

/** Elements a drag must not start on (their controls keep the pointerdown). */
const DRAG_START_BLOCKED = 'input, button, textarea, select, a, label, [contenteditable="true"]';

export function isBooksDragBlockedTarget(target: Element | null): boolean {
  return !!target?.closest?.(DRAG_START_BLOCKED);
}

/** True when candidateId is ancestorId itself or lives somewhere inside its subtree */
export function isFolderInSubtree(
  folders: Record<string, { parentId: string | null }>,
  candidateId: string,
  ancestorId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = candidateId;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = folders[current]?.parentId ?? null;
  }
  return false;
}

/* ── ghost pill ── */

function createGhost(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'books-drag-badge';
  el.textContent = label;
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top = '0';
  el.style.zIndex = '1000';
  el.style.willChange = 'transform';
  document.body.appendChild(el);
  return el;
}

/* ── actor plumbing ── */

function setZoneHover(nextHovered: DragActor['hovered'], copyMode: boolean): void {
  if (!actor) return;
  if (actor.hovered?.zone !== nextHovered?.zone) {
    if (actor.hovered) {
      actor.hovered.zone.classList.remove('drop-target', 'drop-copy');
    }
    if (nextHovered?.zone) {
      nextHovered.zone.classList.add('drop-target');
      nextHovered.zone.classList.toggle('drop-copy', copyMode && nextHovered.accepted);
    }
  } else if (nextHovered?.zone) {
    nextHovered.zone.classList.toggle('drop-copy', copyMode);
  }
  actor.hovered = nextHovered;
}

function moveGhost(actor_: DragActor, event: PointerEvent): void {
  if (actor_.ghost) {
    actor_.ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
  }
}

function scrollContainerNearEdge(zone: HTMLElement | null, event: PointerEvent): void {
  const container = zone?.closest<HTMLElement>('.book-file-body, .folder-tree-list, .books-panel');
  if (!container || container.scrollHeight <= container.clientHeight) return;
  const rect = container.getBoundingClientRect();
  const edge = 34;
  if (event.clientY < rect.top + edge) container.scrollTop -= 16;
  else if (event.clientY > rect.bottom - edge) container.scrollTop += 16;
}

function clearDragVisuals(actor_: DragActor): void {
  if (actor_.hovered) {
    actor_.hovered.zone.classList.remove('drop-target', 'drop-copy');
  }
  if (actor_.ghost) actor_.ghost.remove();
  actor_.source.classList.remove('dragging');
}

/** Bind once; each move re-resolves the payload/zone through `actor`. */
function bindWindowListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerCancel);
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('blur', onWindowPointerCancel);
}

function unbindWindowListeners(): void {
  if (!listenersBound) return;
  listenersBound = false;
  window.removeEventListener('pointermove', onWindowPointerMove);
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('pointercancel', onWindowPointerCancel);
  window.removeEventListener('keydown', onWindowKeyDown);
  window.removeEventListener('blur', onWindowPointerCancel);
}

function onWindowPointerMove(event: PointerEvent): void {
  if (!actor) return unbindWindowListeners();
  const dx = event.clientX - actor.startX;
  const dy = event.clientY - actor.startY;

  // Not yet a drag: wait for the threshold, then lift off.
  if (!actor.ghost) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    actor.ghost = actor.badgeLabel ? createGhost(actor.badgeLabel) : null;
    actor.source.classList.add('dragging');
  }
  event.preventDefault();
  moveGhost(actor, event);

  // Resolve the deepest registered zone under the cursor and hover-mark it.
  const zone = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest?.('[data-books-drop]');
  if (zone instanceof HTMLElement) {
    const spec = dropZones.get(zone);
    const mode: BooksDropMode = event.altKey ? 'copy' : 'move';
    const accepted = !!spec && (!spec.accepts || spec.accepts(actor.payload, mode));
    // Only zones that accept the payload may light up — neighbours look inert.
    if (spec && accepted) {
      setZoneHover({ zone, spec, accepted }, mode === 'copy');
    } else {
      setZoneHover(null, false);
    }
    scrollContainerNearEdge(zone, event);
  } else {
    setZoneHover(null, false);
  }
}

function onWindowPointerUp(event: PointerEvent): void {
  if (!actor) return unbindWindowListeners();
  const finished = actor.ghost !== null;
  const payload = actor.payload;
  const hovered = actor.hovered;
  const mode: BooksDropMode = event.altKey ? 'copy' : 'move';
  actor.ghost?.remove();
  clearDragVisuals(actor);
  const spec = finished && hovered?.accepted ? hovered.spec : null;
  if (finished) suppressClickUntil = Date.now() + 200;
  actor = null;
  unbindWindowListeners();
  if (spec) spec.onDrop(payload, mode);
}

function onWindowPointerCancel(): void {
  finishDrag();
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') finishDrag();
}

function finishDrag(): void {
  if (actor) {
    clearDragVisuals(actor);
    actor.ghost?.remove();
  }
  actor = null;
  unbindWindowListeners();
}

/**
 * Arm a drag from a row's pointerdown. The drag only visualises once the
 * pointer moves past the threshold, so plain clicks behave as before; the
 * subsequent click that follows a real drag is suppressed centrally.
 */
export function beginBooksDrag(
  event: React.PointerEvent<HTMLElement>,
  payload: BooksDragPayload,
  badgeLabel: string | null,
): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
  const source = event.currentTarget;
  // Free the row's contents from text-selection while the engine watches.
  event.preventDefault();
  try {
    source.setPointerCapture(event.pointerId);
  } catch {
    // Capture is a convenience; window listeners track the pointer regardless.
  }
  actor = { payload, source, badgeLabel, startX: event.clientX, startY: event.clientY, ghost: null, hovered: null };
  bindWindowListeners();
}

/** Drop-zone hook: registers the element with the engine and returns its ref. */
export function useBooksDropTarget<E extends HTMLElement = HTMLElement>(
  spec: BooksDropSpec,
): React.RefObject<E | null> {
  const ref = useRef<E | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const entry: BooksDropSpec = {
      accepts: (payload, mode) => specRef.current.accepts?.(payload, mode) ?? true,
      onDrop: (payload, mode) => specRef.current.onDrop(payload, mode),
    };
    registerBooksDropZone(element, entry);
    return () => unregisterBooksDropZone(element);
  }, []);

  return ref;
}
