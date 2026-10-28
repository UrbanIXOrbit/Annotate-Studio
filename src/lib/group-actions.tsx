import React from 'react';
import { ChevronsDownUp, ChevronsUpDown, Columns3, LayoutGrid, Link2, MousePointer2, NotebookPen, Pencil, Rows3, Ungroup, Unlink2, Workflow } from 'lucide-react';
import { activeWorkspace, hiddenResourceIds, useCanvas } from '@/store/canvas';
import { useCardsClip } from '@/store/cards-clip';
import { toast } from '@/store/toast';
import { alignItems, distributeItems, orderItems, planLayout, type AlignMode, type Layout, type Order, type Sortable, type Spacing } from '@/lib/arrange';
import { planTidy, planOverlapTidy } from '@/lib/tidy';
import type { Group } from '@/lib/groups';
import type { CardClip } from '@/lib/note-clip';
import type { MenuEntry } from '@/components/ui/ContextMenu';

export const ORDER_LABELS: Record<Order, string> = {
  position: 'Reading position',
  page: 'PDF page order',
  color: 'Colour',
  title: 'Title A–Z',
  selection: 'Order I selected',
};

/** The windows with these ids that can be arranged: on screen, not minimized, not tucked into a collapsed group. */
export function itemsFor(ids: string[]): Sortable[] {
  const workspace = activeWorkspace(useCanvas.getState());
  const hidden = hiddenResourceIds(workspace);
  const wanted = new Set(ids);
  return workspace.resources
    .filter((r) => wanted.has(r.id) && !r.minimized && !hidden.has(r.id))
    .map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height, title: r.title, color: r.color, source: r.source?.title, page: r.source?.page }));
}

export function arrangeIds(ids: string[], options: { layout: Layout; order: Order; spacing: Spacing; chain?: boolean }): void {
  const items = itemsFor(ids);
  if (items.length < 2) {
    toast.info('Select at least two items to arrange');
    return;
  }
  const canvas = useCanvas.getState();
  canvas.placeResources(planLayout(items, { ...options, selectionOrder: ids }));
  if (options.chain) canvas.chainResources(orderItems(items, options.order, ids).map((item) => item.id));
}

export function alignIds(ids: string[], mode: AlignMode): void {
  useCanvas.getState().placeResources(alignItems(itemsFor(ids), mode));
}

export function distributeIds(ids: string[], axis: 'x' | 'y'): void {
  const items = itemsFor(ids);
  if (items.length < 3) {
    toast.info('Select at least three items to spread out evenly');
    return;
  }
  useCanvas.getState().placeResources(distributeItems(items, axis));
}

/** Link the cards one after another in the chosen order. */
export function chainIds(ids: string[], order: Order, loop = false): void {
  const items = itemsFor(ids);
  if (items.length < 2) {
    toast.info('Select at least two items to chain');
    return;
  }
  const ordered = orderItems(items, order, ids).map((item) => item.id);
  const added = useCanvas.getState().chainResources(ordered, loop);
  if (added > 0) toast.success(`Chained ${items.length} items`, `${ORDER_LABELS[order]}${loop ? ', closed into a loop' : ''}`);
  else toast.info('Those items are already chained in this order');
}

export function unchainIds(ids: string[]): void {
  const removed = useCanvas.getState().unchainResources(ids);
  if (removed > 0) toast.success(`Removed ${removed} link${removed === 1 ? '' : 's'}`);
  else toast.info('There are no links between these items');
}

/** The cards among `ids` as note content: by book and page where they have one, otherwise by position. */
export function cardClipsFor(ids: string[]): CardClip[] {
  const workspace = activeWorkspace(useCanvas.getState());
  const byId = new Map(workspace.resources.map((r) => [r.id, r]));
  const cards = itemsFor(ids).filter((item) => byId.get(item.id)?.type === 'card');
  return orderItems(cards, 'page').map((item) => {
    const card = byId.get(item.id)!;
    return {
      text: card.content ?? '',
      comment: card.note ?? '',
      source: card.source ? { title: card.source.title, page: card.source.page } : undefined,
    };
  });
}

/** Ask the canvas to show the "send to a note" picker for these cards. */
export function requestSendToNote(ids: string[], at: { x: number; y: number }, heading?: string): void {
  if (cardClipsFor(ids).length === 0) {
    toast.info('Select at least one card to send to a note');
    return;
  }
  useCardsClip.getState().open({ ids, heading, x: at.x, y: at.y });
}

const ICON = 14;

/** The right-click / "⋯" menu of a group. */
export function groupMenu(group: Group, extras: { rename: () => void; colors: MenuEntry[]; at?: { x: number; y: number } }): MenuEntry[] {
  const canvas = useCanvas.getState();
  const ids = group.members;
  const arrange = (layout: Layout) => arrangeIds(ids, { layout, order: 'position', spacing: 'normal' });
  const colors = extras.colors.map((entry) => (entry === 'separator' ? entry : { ...entry, label: `Colour: ${entry.label}` }));
  return [
    { label: 'Rename…', icon: <Pencil size={ICON} />, onSelect: extras.rename },
    {
      label: group.collapsed ? 'Expand' : 'Collapse',
      icon: group.collapsed ? <ChevronsUpDown size={ICON} /> : <ChevronsDownUp size={ICON} />,
      onSelect: () => canvas.toggleGroupCollapsed(group.id),
    },
    { label: 'Select all cards', icon: <MousePointer2 size={ICON} />, onSelect: () => canvas.selectMany(ids) },
    'separator',
    { label: 'Arrange as a grid', icon: <LayoutGrid size={ICON} />, onSelect: () => arrange('grid') },
    { label: 'Arrange in a row', icon: <Rows3 size={ICON} />, onSelect: () => arrange('row') },
    { label: 'Arrange in a column', icon: <Columns3 size={ICON} />, onSelect: () => arrange('column') },
    { label: 'Arrange as a flow', icon: <Workflow size={ICON} />, onSelect: () => arrange('flow') },
    'separator',
    { label: 'Chain in reading order', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'position') },
    { label: 'Chain in page order', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'page') },
    { label: 'Remove chain', icon: <Unlink2 size={ICON} />, onSelect: () => unchainIds(ids) },
    'separator',
    {
      label: 'Send cards to a note…',
      icon: <NotebookPen size={ICON} />,
      onSelect: () => requestSendToNote(ids, extras.at ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 }, group.title),
    },
    'separator',
    ...colors,
    'separator',
    { label: 'Ungroup', icon: <Ungroup size={ICON} />, danger: true, onSelect: () => canvas.ungroup(group.id) },
  ];
}

// ───────── acting on the current selection ─────────

/** Selected windows that are present, on screen and not tucked into a collapsed group. */
export function selectedItemIds(): string[] {
  const state = useCanvas.getState();
  const workspace = activeWorkspace(state);
  const hidden = hiddenResourceIds(workspace);
  const byId = new Map(workspace.resources.map((r) => [r.id, r]));
  return state.selectedIds.filter((id) => {
    const resource = byId.get(id);
    return Boolean(resource) && !resource!.minimized && !hidden.has(id);
  });
}

export function groupSelection(): void {
  const ids = selectedItemIds();
  if (ids.length === 0) {
    toast.info('Select the cards you want to group first');
    return;
  }
  if (useCanvas.getState().createGroup(ids)) toast.success(`Grouped ${ids.length} item${ids.length === 1 ? '' : 's'}`, 'Double-click the group\u2019s name to rename it');
}

export function ungroupSelection(): void {
  const state = useCanvas.getState();
  const selected = new Set(selectedItemIds());
  const groups = activeWorkspace(state).groups.filter((group) => group.members.some((id) => selected.has(id)));
  if (groups.length === 0) {
    toast.info('The selection is not in a group');
    return;
  }
  groups.forEach((group) => state.ungroup(group.id));
  toast.success(groups.length === 1 ? 'Group removed' : `${groups.length} groups removed`, 'The cards stay where they are');
}

/** Close the selected cards. Only cards: closing a PDF by accident is not what Delete should do. */
export function closeSelectedCards(): void {
  const state = useCanvas.getState();
  const byId = new Map(activeWorkspace(state).resources.map((r) => [r.id, r]));
  const ids = selectedItemIds();
  if (ids.length === 0 || ids.some((id) => byId.get(id)?.type !== 'card')) return;
  state.closeResources(ids);
  toast.info(`Removed ${ids.length} card${ids.length === 1 ? '' : 's'}`, 'Press Ctrl+Z to bring them back');
}

export function nudgeSelection(dx: number, dy: number): void {
  const ids = selectedItemIds();
  if (ids.length === 0) return;
  const positions: Record<string, { x: number; y: number }> = {};
  for (const item of itemsFor(ids)) positions[item.id] = { x: item.x + dx, y: item.y + dy };
  useCanvas.getState().placeResources(positions);
}

// ───────── tidying ─────────

/** Links between windows in `ids` (ordered pairs of both ends' ids). */
function linksAmong(ids: string[]): [string, string][] {
  const wanted = new Set(ids);
  return activeWorkspace(useCanvas.getState()).connectors
    .filter((c) => wanted.has(c.from) && wanted.has(c.to))
    .map((c) => [c.from, c.to] as [string, string]);
}

/** Tidy the selection with the group- and link-aware planner: explicit intent,
 * so the whole selection is arranged (not just overlapping items). */
export function tidySelection(): void {
  const ids = selectedItemIds();
  const items = itemsFor(ids);
  if (items.length < 2) {
    toast.info('Select at least two items to tidy');
    return;
  }
  const workspace = activeWorkspace(useCanvas.getState());
  useCanvas.getState().placeResources(planTidy(items, workspace.groups, linksAmong(ids)));
  toast.success(`Tidied ${items.length} item${items.length === 1 ? '' : 's'}`, 'Groups and links stayed together');
}

/** Conservative workspace tidy (recommendation 6): only overlapping windows
 * are re-arranged — everything with a reasonable spot stays untouched — while
 * expanded groups and linked chains move as blocks. */
export function tidyWorkspace(): void {
  const state = useCanvas.getState();
  const workspace = activeWorkspace(state);
  const hidden = hiddenResourceIds(workspace);
  const items: Sortable[] = workspace.resources
    .filter((r) => !r.minimized && !r.maximized && !hidden.has(r.id))
    .map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height, title: r.title, color: r.color, source: r.source?.title, page: r.source?.page }));
  if (items.length < 2) {
    toast.info('Nothing to tidy yet');
    return;
  }
  const ids = items.map((item) => item.id);
  const tidy = planOverlapTidy(items, workspace.groups, linksAmong(ids));
  const moved = Object.entries(tidy).filter(([id, spot]) => {
    const item = items.find((candidate) => candidate.id === id)!;
    return spot.x !== item.x || spot.y !== item.y;
  }).length;
  if (moved === 0) {
    toast.info('Nothing to tidy', 'No overlapping windows — your spacing already works');
    return;
  }
  state.placeResources(tidy);
  toast.success(`Untangled ${moved} window${moved === 1 ? '' : 's'}`, 'Only overlaps were moved; groups and links stayed together');
}
