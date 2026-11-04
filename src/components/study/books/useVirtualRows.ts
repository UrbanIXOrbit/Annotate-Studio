'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Windowed rendering for the Books file list.
 *
 * Only the rows intersecting the scroll viewport (plus an overscan margin)
 * are mounted; spacer divs keep every mounted row at its exact scroll offset,
 * so scrollbar size, position and momentum behave exactly like the full list.
 * Row heights are measured with a ResizeObserver and cached by file id, so
 * rows with wrapped tags keep their true height even after scrolling away.
 *
 * The DOM-presence tricks elsewhere in the list keep working: drop zones only
 * need to exist for rows that can be hovered (off-screen rows cannot be),
 * and keyboard jumps mount their target row first via `scrollToId`.
 */

/** Flex gap between rows in `.book-file-body` — part of every row's footprint */
const ROW_GAP = 6;

export interface BooksVirtualRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

const EMPTY_RANGE: BooksVirtualRange = { start: 0, end: 0, padTop: 0, padBottom: 0 };

export function useBooksVirtualRows(ids: string[], estimate = 62, overscan = 6) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  /** Measured pixel heights keyed by row id — survives unmount/scroll cycles */
  const heightsRef = useRef(new Map<string, number>());
  const rowElsRef = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Row waiting to be focused once a scroll has mounted it (keyboard jumps) */
  const pendingFocusRef = useRef<string | null>(null);
  const rangeRef = useRef<BooksVirtualRange>(EMPTY_RANGE);
  const [range, setRange] = useState<BooksVirtualRange>(EMPTY_RANGE);

  const heightOf = useCallback(
    (id: string) => (heightsRef.current.get(id) ?? estimate) + ROW_GAP,
    [estimate],
  );

  const offsetOf = useCallback(
    (index: number) => {
      const list = idsRef.current;
      let offset = 0;
      for (let i = 0; i < index && i < list.length; i++) offset += heightOf(list[i]);
      return offset;
    },
    [heightOf],
  );

  const recompute = useCallback(() => {
    const scrollEl = scrollRef.current;
    const list = idsRef.current;
    if (!scrollEl || list.length === 0) {
      if (rangeRef.current !== EMPTY_RANGE) {
        rangeRef.current = EMPTY_RANGE;
        setRange(EMPTY_RANGE);
      }
      return;
    }

    const viewport = scrollEl.clientHeight;
    const scrollTop = scrollEl.scrollTop;

    // First row whose bottom edge passes the viewport top
    let offset = 0;
    let first = list.length;
    for (let i = 0; i < list.length; i++) {
      const h = heightOf(list[i]);
      if (offset + h > scrollTop) {
        first = i;
        break;
      }
      offset += h;
    }

    // One past the last row whose top edge is inside the viewport
    let last = first;
    let bottom = offset;
    while (last < list.length && bottom < scrollTop + viewport) {
      bottom += heightOf(list[last]);
      last++;
    }

    const start = Math.max(0, first - overscan);
    const end = Math.min(list.length, last + overscan);
    let padTop = 0;
    for (let i = 0; i < start; i++) padTop += heightOf(list[i]);
    let padBottom = 0;
    for (let i = end; i < list.length; i++) padBottom += heightOf(list[i]);

    const next = { start, end, padTop, padBottom };
    const prev = rangeRef.current;
    if (
      prev.start !== next.start ||
      prev.end !== next.end ||
      prev.padTop !== next.padTop ||
      prev.padBottom !== next.padBottom
    ) {
      rangeRef.current = next;
      setRange(next);
    }
  }, [heightOf, overscan]);

  const scheduleRecompute = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      recompute();
    });
  }, [recompute]);

  /** Callback ref for each row: registers it for measurement */
  const measure = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (!el) {
        const prev = rowElsRef.current.get(id);
        if (prev) observerRef.current?.unobserve(prev);
        rowElsRef.current.delete(id);
        return;
      }
      rowElsRef.current.set(id, el);
      if (!observerRef.current) {
        observerRef.current = new ResizeObserver(() => scheduleRecompute());
      }
      observerRef.current.observe(el);
      const h = el.offsetHeight;
      if (heightsRef.current.get(id) !== h) {
        heightsRef.current.set(id, h);
        scheduleRecompute();
      }
    },
    [scheduleRecompute],
  );

  // Track scrolling and viewport resizes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => scheduleRecompute();
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(() => scheduleRecompute());
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }, [scheduleRecompute]);

  // Recompute before paint whenever the row set changes (folder switch, search)
  const idsKey = ids.join('|');
  useLayoutEffect(() => {
    recompute();
  }, [idsKey, recompute]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus a row that was scrolled into view by scrollToId
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const el = rowElsRef.current.get(pending);
    if (el) {
      pendingFocusRef.current = null;
      el.focus({ preventScroll: false });
    }
  }, [range]);

  const scrollToId = useCallback(
    (id: string) => {
      const list = idsRef.current;
      const index = list.indexOf(id);
      if (index === -1) return;
      const el = rowElsRef.current.get(id);
      if (el && index >= rangeRef.current.start && index < rangeRef.current.end) {
        el.focus({ preventScroll: false });
        return;
      }
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      // Bring the row in a third of the way from the top, then focus it once
      // the recompute mounts it
      scrollEl.scrollTop = Math.max(0, offsetOf(index) - ROW_GAP - scrollEl.clientHeight / 3);
      pendingFocusRef.current = id;
      recompute();
    },
    [offsetOf, recompute],
  );

  // Tear down the observer when the list goes away
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { scrollRef, measure, range, padTop: range.padTop, padBottom: range.padBottom, scrollToId };
}
