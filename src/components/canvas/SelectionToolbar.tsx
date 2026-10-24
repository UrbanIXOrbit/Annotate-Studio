'use client';

import React, { useRef, useState, type RefObject } from 'react';
import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Group as GroupIcon,
  LayoutGrid,
  Link2,
  NotebookPen,
  Trash2,
  Ungroup,
  Unlink2,
  X,
} from 'lucide-react';
import { activeWorkspace, hiddenResourceIds, useActiveWorkspace, useCanvas } from '@/store/canvas';
import { getLiveRect, useLiveRectVersion } from '@/lib/live-rects';
import { boundsOf, type AlignMode } from '@/lib/arrange';
import { CARD_COLORS } from '@/lib/cards';
import { colorName } from '@/lib/groups';
import { alignIds, chainIds, closeSelectedCards, distributeIds, groupSelection, requestSendToNote, ungroupSelection, unchainIds } from '@/lib/group-actions';
import { openContextMenu, type MenuEntry } from '@/components/ui/ContextMenu';
import ArrangePanel from './ArrangePanel';
import { cn } from '@/lib/utils';

const ICON = 15;
const ALIGN: { mode: AlignMode; label: string; icon: React.ReactNode }[] = [
  { mode: 'left', label: 'Align left edges', icon: <AlignHorizontalJustifyStart size={ICON} /> },
  { mode: 'center', label: 'Align centres', icon: <AlignHorizontalJustifyCenter size={ICON} /> },
  { mode: 'right', label: 'Align right edges', icon: <AlignHorizontalJustifyEnd size={ICON} /> },
  { mode: 'top', label: 'Align top edges', icon: <AlignVerticalJustifyStart size={ICON} /> },
  { mode: 'middle', label: 'Align middles', icon: <AlignVerticalJustifyCenter size={ICON} /> },
  { mode: 'bottom', label: 'Align bottom edges', icon: <AlignVerticalJustifyEnd size={ICON} /> },
];

export default function SelectionToolbar({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const workspace = useActiveWorkspace();
  const selectedIds = useCanvas((state) => state.selectedIds);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const arrangeButton = useRef<HTMLButtonElement>(null);
  useLiveRectVersion();

  const hidden = hiddenResourceIds(workspace);
  const items = selectedIds
    .map((id) => workspace.resources.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r) && !r!.minimized && !hidden.has(r!.id));
  if (items.length < 2 || workspace.resources.some((r) => r.maximized)) return null;

  const ids = items.map((r) => r.id);
  const cards = items.filter((r) => r.type === 'card');
  const bounds = boundsOf(items.map((r) => getLiveRect(r.id) ?? r))!;
  const { zoom, x: viewX, y: viewY } = workspace.view;
  const width = containerRef.current?.clientWidth ?? 1200;
  const centerX = Math.min(Math.max((bounds.x + bounds.width / 2) * zoom + viewX, 250), Math.max(250, width - 250));
  const above = bounds.y * zoom + viewY - 58;
  const top = above < 8 ? (bounds.y + bounds.height) * zoom + viewY + 16 : above;

  const sharedGroup = workspace.groups.find((group) => ids.every((id) => group.members.includes(id)));
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  const chainMenu: MenuEntry[] = [
    { label: 'Chain in reading order', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'position') },
    { label: 'Chain in PDF page order', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'page') },
    { label: 'Chain in the order I selected', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'selection') },
    { label: 'Chain as a loop', icon: <Link2 size={ICON} />, onSelect: () => chainIds(ids, 'position', true) },
    'separator',
    { label: 'Remove links between these', icon: <Unlink2 size={ICON} />, danger: true, onSelect: () => unchainIds(ids) },
  ];
  const alignMenu: MenuEntry[] = [
    ...ALIGN.map((entry) => ({ label: entry.label, icon: entry.icon, onSelect: () => alignIds(ids, entry.mode) })),
    'separator' as const,
    { label: 'Spread out evenly (across)', icon: <AlignHorizontalDistributeCenter size={ICON} />, onSelect: () => distributeIds(ids, 'x') },
    { label: 'Spread out evenly (down)', icon: <AlignVerticalDistributeCenter size={ICON} />, onSelect: () => distributeIds(ids, 'y') },
  ];
  const colorMenu: MenuEntry[] = CARD_COLORS.map((color) => ({
    label: colorName(color),
    icon: <span className="menu-swatch" style={{ background: color }} />,
    onSelect: () => useCanvas.getState().setCardsColor(cards.map((r) => r.id), color),
  }));

  return (
    <div className="selection-toolbar" data-canvas-ui style={{ left: centerX, top }} onPointerDown={stop} onDoubleClick={stop} onContextMenu={(event) => event.preventDefault()} role="toolbar" aria-label="Selection">
      <span className="selection-count">{items.length} selected</span>
      <button type="button" className="sel-btn" title="Clear selection (Esc)" aria-label="Clear selection" onClick={() => useCanvas.getState().select(null)}>
        <X size={ICON} />
      </button>
      <span className="sel-divider" />
      {sharedGroup ? (
        <button type="button" className="sel-btn" title="Ungroup (Ctrl+Shift+G)" onClick={ungroupSelection}>
          <Ungroup size={ICON} /> <span>Ungroup</span>
        </button>
      ) : (
        <button type="button" className="sel-btn" title="Group these (Ctrl+G)" onClick={groupSelection}>
          <GroupIcon size={ICON} /> <span>Group</span>
        </button>
      )}
      <button type="button" className="sel-btn" title="Chain these cards with arrows" onClick={(event) => openContextMenu(event, chainMenu)}>
        <Link2 size={ICON} /> <span>Chain</span>
      </button>
      <button ref={arrangeButton} type="button" className={cn('sel-btn', arrangeOpen && 'active')} title="Arrange as a grid, row, column or flow" onClick={() => setArrangeOpen((open) => !open)}>
        <LayoutGrid size={ICON} /> <span>Arrange</span>
      </button>
      <button type="button" className="sel-btn" title="Align and spread out" onClick={(event) => openContextMenu(event, alignMenu)}>
        <AlignHorizontalJustifyStart size={ICON} /> <span>Align</span>
      </button>
      {cards.length > 0 && (
        <>
          <span className="sel-divider" />
          <button type="button" className="sel-btn" title="Colour the selected cards" onClick={(event) => openContextMenu(event, colorMenu)}>
            <span className="sel-swatch" style={{ background: cards[0].color ?? CARD_COLORS[0] }} />
          </button>
          <button
            type="button"
            className="sel-btn"
            title="Send the selected cards to a note"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              requestSendToNote(ids, { x: rect.left, y: rect.bottom + 6 });
            }}
          >
            <NotebookPen size={ICON} /> <span>To note</span>
          </button>
        </>
      )}
      {cards.length === items.length && (
        <button type="button" className="sel-btn sel-danger" title="Remove the selected cards (Ctrl+Z brings them back)" aria-label="Remove selected cards" onClick={closeSelectedCards}>
          <Trash2 size={ICON} />
        </button>
      )}
      <ArrangePanel anchorRef={arrangeButton} open={arrangeOpen} onClose={() => setArrangeOpen(false)} ids={ids} />
    </div>
  );
}
