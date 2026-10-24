'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Shared plumbing for drag & drop inside the Books manager. Drags always
 * start and end inside this window, so alongside the DataTransfer MIME type
 * we mirror the live payload in a module variable — dragover handlers cannot
 * call getData() and need to know what is being dragged to decide whether a
 * target accepts it.
 */

export const BOOKS_DND_MIME = 'application/x-annotate-books';

export type BooksDragPayload =
  | { kind: 'files'; fileIds: string[] }
  | { kind: 'folder'; folderId: string };

let currentDrag: BooksDragPayload | null = null;

export function beginBooksDrag(
  dataTransfer: DataTransfer,
  payload: BooksDragPayload,
  dragImage?: HTMLElement,
): void {
  currentDrag = payload;
  try {
    dataTransfer.setData(BOOKS_DND_MIME, JSON.stringify(payload));
    dataTransfer.setData(
      'text/plain',
      payload.kind === 'files' ? `${payload.fileIds.length} file(s)` : 'folder',
    );
  } catch {
    // Some webviews restrict custom MIME types; the module payload still works
  }
  dataTransfer.effectAllowed = 'copyMove';
  if (dragImage) dataTransfer.setDragImage(dragImage, 18, 18);
}

export function endBooksDrag(): void {
  currentDrag = null;
  removeDragBadge();
}

export function getCurrentBooksDrag(): BooksDragPayload | null {
  return currentDrag;
}

export function isBooksDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(BOOKS_DND_MIME);
}

export function getBooksDragPayload(dataTransfer: DataTransfer): BooksDragPayload | null {
  try {
    const raw = dataTransfer.getData(BOOKS_DND_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BooksDragPayload;
    if (parsed.kind === 'files' && Array.isArray(parsed.fileIds)) return parsed;
    if (parsed.kind === 'folder' && typeof parsed.folderId === 'string') return parsed;
  } catch {
    return null;
  }
  return null;
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

let badgeEl: HTMLElement | null = null;

/** Off-screen pill ("3 files") used as the drag image for multi-file drags */
export function createDragBadge(label: string): HTMLElement {
  removeDragBadge();
  const el = document.createElement('div');
  el.className = 'books-drag-badge';
  el.textContent = label;
  el.style.position = 'fixed';
  el.style.left = '-1000px';
  el.style.top = '-1000px';
  document.body.appendChild(el);
  badgeEl = el;
  return el;
}

export function removeDragBadge(): void {
  if (badgeEl) {
    badgeEl.remove();
    badgeEl = null;
  }
}

export interface BooksDropHandlers {
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

/**
 * Highlight + dispatch logic shared by every drop target (folder rows, the
 * "All files" row, project items, the files panel). Holding Alt/Option while
 * dropping switches the effect from move to copy.
 */
export function useBooksDropTarget(options: {
  accepts: (payload: BooksDragPayload) => boolean;
  onDrop: (payload: BooksDragPayload, mode: 'copy' | 'move') => void;
}): { isActive: boolean; mode: 'copy' | 'move'; handlers: BooksDropHandlers } {
  const [isActive, setIsActive] = useState(false);
  const [mode, setMode] = useState<'copy' | 'move'>('move');

  // Keep the latest callbacks without re-binding handlers mid-drag
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const reset = () => setIsActive(false);
    window.addEventListener('dragend', reset);
    return () => window.removeEventListener('dragend', reset);
  }, []);

  const handlers = useMemo<BooksDropHandlers>(() => {
    const canAccept = (event: React.DragEvent) => {
      if (!isBooksDrag(event.dataTransfer)) return false;
      const payload = getCurrentBooksDrag();
      return !!payload && optionsRef.current.accepts(payload);
    };

    return {
      onDragEnter: (event) => {
        if (!canAccept(event)) return;
        event.preventDefault();
        setIsActive(true);
      },
      onDragOver: (event) => {
        if (!canAccept(event)) return;
        event.preventDefault();
        const dropMode = event.altKey ? 'copy' : 'move';
        event.dataTransfer.dropEffect = dropMode;
        setMode(dropMode);
        setIsActive(true);
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsActive(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsActive(false);
        const payload = getBooksDragPayload(event.dataTransfer);
        if (payload && optionsRef.current.accepts(payload)) {
          optionsRef.current.onDrop(payload, event.altKey ? 'copy' : 'move');
        }
      },
    };
  }, []);

  return { isActive, mode, handlers };
}
