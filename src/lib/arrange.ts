import { CARD_COLORS } from './cards.ts';
import { nearestSide, type Box, type Point, type Side } from './connectors.ts';

export interface Item extends Box {
  id: string;
}

/** An item plus the facts the ordering options sort by. */
export interface Sortable extends Item {
  title?: string;
  color?: string;
  /** Title of the PDF a card was taken from. */
  source?: string;
  /** Page within that PDF (1-based). */
  page?: number;
}

export type Layout = 'grid' | 'row' | 'column' | 'flow';
export type Order = 'position' | 'page' | 'color' | 'title' | 'selection';
export type Spacing = 'tight' | 'normal' | 'roomy';
export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export const GAPS: Record<Spacing, number> = { tight: 16, normal: 36, roomy: 72 };
const FLOW_WIDTH = 1500;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const centerOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

export function boundsOf(items: Box[]): Box | null {
  if (items.length === 0) return null;
  const left = Math.min(...items.map((i) => i.x));
  const top = Math.min(...items.map((i) => i.y));
  const right = Math.max(...items.map((i) => i.x + i.width));
  const bottom = Math.max(...items.map((i) => i.y + i.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Left-to-right, top-to-bottom, treating items on roughly the same line as one row. */
export function readingOrder<T extends Item>(items: T[]): T[] {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  let rowTop = 0;
  let rowHeight = 0;
  for (const item of byTop) {
    const row = rows[rows.length - 1];
    if (row && item.y < rowTop + rowHeight * 0.6) {
      row.push(item);
      rowHeight = Math.max(rowHeight, item.height);
    } else {
      rows.push([item]);
      rowTop = item.y;
      rowHeight = item.height;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

const colorRank = (color: string | undefined) => {
  if (!color) return 100;
  const index = CARD_COLORS.findIndex((candidate) => candidate.toLowerCase() === color.toLowerCase());
  return index === -1 ? 99 : index;
};

export function orderItems<T extends Sortable>(items: T[], order: Order, selectionOrder: string[] = []): T[] {
  const reading = readingOrder(items);
  const rank = new Map(reading.map((item, index) => [item.id, index]));
  const tie = (a: T, b: T) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  if (order === 'position') return reading;
  const sorted = [...items];
  if (order === 'selection') {
    const at = new Map(selectionOrder.map((id, index) => [id, index]));
    sorted.sort((a, b) => (at.get(a.id) ?? 1e6) - (at.get(b.id) ?? 1e6) || tie(a, b));
  } else if (order === 'page') {
    sorted.sort((a, b) => {
      const sa = a.source !== undefined;
      const sb = b.source !== undefined;
      if (sa !== sb) return sa ? -1 : 1;
      if (sa && sb && a.source !== b.source) return collator.compare(a.source!, b.source!);
      return (a.page ?? 1e6) - (b.page ?? 1e6) || tie(a, b);
    });
  } else if (order === 'color') {
    sorted.sort((a, b) => colorRank(a.color) - colorRank(b.color) || tie(a, b));
  } else {
    sorted.sort((a, b) => collator.compare(a.title ?? '', b.title ?? '') || tie(a, b));
  }
  return sorted;
}

export interface LayoutOptions {
  layout: Layout;
  order: Order;
  spacing: Spacing;
  selectionOrder?: string[];
  /** Grid column count. Defaults to a roughly square arrangement. */
  columns?: number;
  /** Where flow layouts wrap. */
  maxRowWidth?: number;
}

export type Placement = Record<string, { x: number; y: number }>;

/** New top-left positions that lay the items out from the top-left of where they are now. Sizes never change. */
export function planLayout<T extends Sortable>(items: T[], options: LayoutOptions): Placement {
  const bounds = boundsOf(items);
  if (!bounds) return {};
  const ordered = orderItems(items, options.order, options.selectionOrder);
  const gap = GAPS[options.spacing];
  const placement: Placement = {};
  const put = (item: T, x: number, y: number) => {
    placement[item.id] = { x: Math.round(x), y: Math.round(y) };
  };

  if (options.layout === 'row') {
    let x = bounds.x;
    for (const item of ordered) {
      put(item, x, bounds.y);
      x += item.width + gap;
    }
  } else if (options.layout === 'column') {
    let y = bounds.y;
    for (const item of ordered) {
      put(item, bounds.x, y);
      y += item.height + gap;
    }
  } else if (options.layout === 'grid') {
    const columns = Math.max(1, Math.min(ordered.length, options.columns ?? Math.ceil(Math.sqrt(ordered.length))));
    const rows = Math.ceil(ordered.length / columns);
    const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...ordered.filter((_, i) => i % columns === c).map((i) => i.width)));
    const heights = Array.from({ length: rows }, (_, r) => Math.max(0, ...ordered.slice(r * columns, r * columns + columns).map((i) => i.height)));
    ordered.forEach((item, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = bounds.x + widths.slice(0, column).reduce((sum, w) => sum + w + gap, 0);
      const y = bounds.y + heights.slice(0, row).reduce((sum, h) => sum + h + gap, 0);
      put(item, x, y);
    });
  } else {
    // flow: like a row, but wrapping so a long chain stays on screen
    const limit = options.maxRowWidth ?? FLOW_WIDTH;
    let x = bounds.x;
    let y = bounds.y;
    let lineHeight = 0;
    for (const item of ordered) {
      if (x > bounds.x && x + item.width - bounds.x > limit) {
        x = bounds.x;
        y += lineHeight + gap;
        lineHeight = 0;
      }
      put(item, x, y);
      x += item.width + gap;
      lineHeight = Math.max(lineHeight, item.height);
    }
  }
  return placement;
}

/** Line the items up along an edge or centre of the selection. Only items that actually move are returned. */
export function alignItems(items: Item[], mode: AlignMode): Placement {
  const bounds = boundsOf(items);
  if (!bounds || items.length < 2) return {};
  const placement: Placement = {};
  for (const item of items) {
    let { x, y } = item;
    if (mode === 'left') x = bounds.x;
    else if (mode === 'center') x = bounds.x + (bounds.width - item.width) / 2;
    else if (mode === 'right') x = bounds.x + bounds.width - item.width;
    else if (mode === 'top') y = bounds.y;
    else if (mode === 'middle') y = bounds.y + (bounds.height - item.height) / 2;
    else y = bounds.y + bounds.height - item.height;
    x = Math.round(x);
    y = Math.round(y);
    if (x !== item.x || y !== item.y) placement[item.id] = { x, y };
  }
  return placement;
}

/** Equal gaps between the items, keeping the first and last where they are. Needs at least three. */
export function distributeItems(items: Item[], axis: 'x' | 'y'): Placement {
  if (items.length < 3) return {};
  const horizontal = axis === 'x';
  const sorted = [...items].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const size = (item: Item) => (horizontal ? item.width : item.height);
  const start = horizontal ? sorted[0].x : sorted[0].y;
  const last = sorted[sorted.length - 1];
  const end = (horizontal ? last.x : last.y) + size(last);
  const free = end - start - sorted.reduce((sum, item) => sum + size(item), 0);
  const gap = free / (sorted.length - 1);
  const placement: Placement = {};
  let cursor = start;
  for (const item of sorted) {
    const value = Math.round(cursor);
    if (value !== (horizontal ? item.x : item.y)) placement[item.id] = horizontal ? { x: value, y: item.y } : { x: item.x, y: value };
    cursor += size(item) + gap;
  }
  return placement;
}

// ───────── chains ─────────

/** Consecutive pairs of an ordered list; with `loop`, the last links back to the first. */
export function chainPairs(ids: string[], loop = false): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < ids.length; i += 1) pairs.push([ids[i], ids[i + 1]]);
  if (loop && ids.length > 2) pairs.push([ids[ids.length - 1], ids[0]]);
  return pairs;
}

/** Attach each end of a connector to the side that faces the other card. */
export function autoSides(from: Box, to: Box): { fromSide: Side; toSide: Side } {
  return { fromSide: nearestSide(from, centerOf(to)), toSide: nearestSide(to, centerOf(from)) };
}
