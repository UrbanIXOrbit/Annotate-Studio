import { boundsOf, planLayout, readingOrder, type Placement, type Sortable } from './arrange.ts';
import type { Box } from './connectors.ts';
import { LAYOUT } from './layout.ts';
import { GROUP_HEADER, GROUP_PAD, type Group } from './groups.ts';
import { clearOfOthers, type FootprintMargin } from './placement.ts';

/**
 * How far a block's drawn frame reaches beyond its windows: a group is drawn with padding all
 * round and a title header on top. Tidy spaces blocks by these footprints, not by the bare
 * windows, so neighbouring groups never overlap each other's frames.
 */
export function frameMargin(ids: string[], groups: Group[]): FootprintMargin {
  const present = new Set(ids);
  const framed = groups.some((g) => !g.collapsed && g.members.filter((id) => present.has(id)).length >= 2);
  return framed ? { top: GROUP_PAD + GROUP_HEADER, right: GROUP_PAD, bottom: GROUP_PAD, left: GROUP_PAD } : {};
}

/**
 * Group-aware tidy (recommendation 5): windows that belong to a group or are
 * linked together move as one block — group members arranged in a grid, linked
 * items arranged along their chain — and the blocks, along with ungrouped
 * windows, are laid out in a block grid that follows the shared layout rhythm.
 * Pure and deterministic, so the result can go straight into `placeResources`
 * as a single undo step.
 */
export function planTidy(items: Sortable[], groups: Group[] = [], links: [string, string][] = []): Placement {
  if (items.length < 2) return {};
  const inTidy = new Set(items.map((item) => item.id));
  const boxOf = new Map(items.map((item) => [item.id, item]));

  // One block per group with at least two of its members taking part; then one
  // per connected run of links; every other window is a block of one. Collapsed
  // groups are skipped outright: for a whole-canvas tidy their members are
  // hidden and not part of the tidy at all.
  const used = new Set<string>();
  const blocks: { boxes: Sortable[]; bounds: Box; inner: Placement; margin: FootprintMargin }[] = [];
  const claim = (ids: string[]) => ids.forEach((id) => used.add(id));
  for (const group of groups) {
    if (group.collapsed) continue;
    const members = group.members.filter((id) => inTidy.has(id) && !used.has(id));
    if (members.length < 2) continue;
    const boxes = members.map((id) => boxOf.get(id)!);
    blocks.push({
      boxes,
      bounds: boundsOf(boxes)!,
      inner: planLayout(boxes, { layout: 'grid', order: 'position', spacing: 'normal' }),
      margin: frameMargin(members, [group]),
    });
    claim(members);
  }
  // Linked windows stay attached: each connected component becomes a block and
  // its inner layout follows the chain, so arrows still read sensibly.
  for (const component of linkComponents([...inTidy].filter((id) => !used.has(id)), links)) {
    const boxes = component.map((id) => boxOf.get(id)!);
    const bounds = boundsOf(boxes)!;
    const chain = chainOrder(component, links, boxOf);
    blocks.push({ boxes, bounds, inner: planLayout(boxes, { layout: 'flow', order: 'selection', spacing: 'normal', selectionOrder: chain }), margin: {} });
    claim(component);
  }
  for (const item of items) {
    if (used.has(item.id)) continue;
    blocks.push({ boxes: [item], bounds: { x: item.x, y: item.y, width: item.width, height: item.height }, inner: {}, margin: {} });
  }

  // The blocks keep their reading order (left-to-right, top-to-bottom of where
  // they are now), land back at the top-left of the current bounds snapped to
  // the rhythm, and pack into a roughly square block grid.
  const overall = boundsOf(items)!;
  const originX = Math.round(overall.x / LAYOUT.unit) * LAYOUT.unit;
  const originY = Math.round(overall.y / LAYOUT.unit) * LAYOUT.unit;
  // `readingOrder` already returns the blocks in order; each keeps the index it had in `blocks`.
  const ordered = readingOrder(blocks.map((block, index) => ({ id: `block-${index}`, ...block.bounds }))).map(
    (entry) => blocks[Number(entry.id.slice('block-'.length))]!,
  );

  const columns = Math.max(1, Math.min(ordered.length, Math.ceil(Math.sqrt(ordered.length))));
  const rows = Math.ceil(ordered.length / columns);
  const inColumn = (column: number) => ordered.filter((_, index) => index % columns === column);
  const inRow = (row: number) => ordered.slice(row * columns, row * columns + columns);
  const most = (list: typeof ordered, pick: (b: (typeof ordered)[number]) => number) => Math.max(0, ...list.map(pick));
  const colLeft = Array.from({ length: columns }, (_, c) => most(inColumn(c), (b) => b.margin.left ?? 0));
  const colRight = Array.from({ length: columns }, (_, c) => most(inColumn(c), (b) => b.margin.right ?? 0));
  const colWidth = Array.from({ length: columns }, (_, c) => most(inColumn(c), blockWidth));
  const rowTop = Array.from({ length: rows }, (_, r) => most(inRow(r), (b) => b.margin.top ?? 0));
  const rowBottom = Array.from({ length: rows }, (_, r) => most(inRow(r), (b) => b.margin.bottom ?? 0));
  const rowHeight = Array.from({ length: rows }, (_, r) => most(inRow(r), blockHeight));
  // Footprints (window bounds plus frame) are `columnGap` apart; the first block's windows keep
  // the top-left of the original bounds.
  const columnX = (column: number) =>
    originX - colLeft[0]! + colLeft[column]! +
    colLeft.slice(0, column).reduce((sum, _, k) => sum + colLeft[k]! + colWidth[k]! + colRight[k]! + LAYOUT.columnGap, 0);
  const rowY = (row: number) =>
    originY - rowTop[0]! + rowTop[row]! +
    rowTop.slice(0, row).reduce((sum, _, k) => sum + rowTop[k]! + rowHeight[k]! + rowBottom[k]! + LAYOUT.columnGap, 0);

  const placement: Placement = {};
  ordered.forEach((block, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = columnX(column);
    const y = rowY(row);
    for (const item of block.boxes) {
      const spot = block.inner[item.id] ?? { x: item.x, y: item.y };
      placement[item.id] = { x: Math.round(x + spot.x - block.bounds.x), y: Math.round(y + spot.y - block.bounds.y) };
    }
  });
  return placement;

  function blockWidth(block: { boxes: Sortable[]; inner: Placement }): number {
    return boundsOf(block.boxes.map((item) => ({ ...item, ...block.inner[item.id] })))?.width ?? 0;
  }
  function blockHeight(block: { boxes: Sortable[]; inner: Placement }): number {
    return boundsOf(block.boxes.map((item) => ({ ...item, ...block.inner[item.id] })))?.height ?? 0;
  }
}

/** The overlapping pairs of `windows`: boxes that share any area (merely touching is not overlapping). */
export function overlappingPairs<T extends Box & { id: string }>(windows: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]!;
      const b = windows[j]!;
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/**
 * Conservative whole-canvas tidy: leave every window that already has a
 * reasonable spot untouched, and re-arrange only the piles — clusters of
 * windows that actually overlap each other. Within a pile, groups and link
 * chains still move as blocks. Pure; returns {} when nothing overlaps.
 */
export function planOverlapTidy(items: Sortable[], groups: Group[] = [], links: [string, string][] = []): Placement {
  if (items.length < 2) return {};
  const byId = new Map(items.map((item) => [item.id, item]));
  const pairs = overlappingPairs(items);
  if (pairs.length === 0) return {};

  // Union the overlapping windows into piles, transitively.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const root = parent.get(id) ?? id;
    if (root === id) return id;
    const top = find(root);
    parent.set(id, top);
    return top;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  for (const [a, b] of pairs) {
    parent.set(a.id, parent.get(a.id) ?? a.id);
    parent.set(b.id, parent.get(b.id) ?? b.id);
    union(a.id, b.id);
  }
  const piles = new Map<string, Sortable[]>();
  for (const item of items) {
    if (!parent.has(item.id)) continue;
    const root = find(item.id);
    piles.set(root, [...(piles.get(root) ?? []), item]);
  }

  // Tidy each pile in place, anchored at the pile's own bounds — but a tidied pile is usually bigger
  // than the heap it came from, so if it would now touch a window that was never part of any pile
  // (or a pile tidied before it) the whole pile moves, as one piece, to the nearest free spot.
  const placement: Placement = {};
  const fixed: Box[] = items.filter((item) => !parent.has(item.id));
  for (const pile of piles.values()) {
    const tidied = planTidy(pile, groups, links);
    const cleared = clearOfOthers(tidied, pile, fixed, frameMargin(pile.map((item) => item.id), groups));
    Object.assign(placement, cleared);
    fixed.push(...pile.map((item) => ({ ...item, ...(cleared[item.id] ?? {}) })));
  }
  return placement;
}

/** Connected runs of `links` among the given ids, each sorted by position. */
function linkComponents(ids: string[], links: [string, string][]): string[][] {
  const allowed = new Set(ids);
  const relevant = links.filter(([from, to]) => allowed.has(from) && allowed.has(to) && from !== to);
  if (relevant.length === 0) return [];
  const neighbours = new Map<string, string[]>();
  for (const [from, to] of relevant) {
    neighbours.set(from, [...(neighbours.get(from) ?? []), to]);
    neighbours.set(to, [...(neighbours.get(to) ?? []), from]);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of neighbours.keys()) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of neighbours.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** Order a chain's members along its links: start at a loose end (or the top-most), then walk. */
function chainOrder(component: string[], links: [string, string][], boxOf: Map<string, Sortable>): string[] {
  if (component.length < 3) return component;
  const relevant = links.filter(([from, to]) => component.includes(from) && component.includes(to));
  const degree = new Map<string, number>();
  for (const [from, to] of relevant) {
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  const sorted = [...component].sort((a, b) => (boxOf.get(a)!.y - boxOf.get(b)!.y) || (boxOf.get(a)!.x - boxOf.get(b)!.x));
  const start = sorted.find((id) => (degree.get(id) ?? 0) <= 1) ?? sorted[0]!;
  const order: string[] = [];
  const visited = new Set<string>();
  let frontier = [start];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      for (const neighbour of relevant.flatMap(([from, to]) => (from === id ? [to] : to === id ? [from] : []))) {
        if (!visited.has(neighbour)) nextFrontier.push(neighbour);
      }
    }
    frontier = [...new Set(nextFrontier)].sort((a, b) => (boxOf.get(a)!.y - boxOf.get(b)!.y) || (boxOf.get(a)!.x - boxOf.get(b)!.x));
  }
  for (const id of sorted) if (!visited.has(id)) order.push(id);
  return order;
}

/** Whether a tidy would change anything: true when some placement differs from the current position. */
export function tidyMovesSomething(items: Sortable[], groups: Group[] = [], links: [string, string][] = []): boolean {
  const placement = planTidy(items, groups, links);
  return items.some((item) => {
    const spot = placement[item.id];
    return Boolean(spot && (spot.x !== item.x || spot.y !== item.y));
  });
}
