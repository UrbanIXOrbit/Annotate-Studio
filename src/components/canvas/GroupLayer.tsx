'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useActiveWorkspace, useCanvas } from '@/store/canvas';
import { getLiveRect, useLiveRectVersion } from '@/lib/live-rects';
import { dragWindows } from '@/lib/drag-windows';
import { collapsedRect, frameRect, type Group } from '@/lib/groups';
import { CARD_COLORS } from '@/lib/cards';
import { colorName } from '@/lib/groups';
import { groupMenu } from '@/lib/group-actions';
import { openContextMenu, type MenuEntry } from '@/components/ui/ContextMenu';
import { cn } from '@/lib/utils';

function TitleEditor({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="group-title-input"
      value={value}
      maxLength={80}
      dir="auto"
      onChange={(event) => setValue(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => onDone(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onDone(value);
        else if (event.key === 'Escape') onDone(null);
      }}
    />
  );
}

export default function GroupLayer() {
  const workspace = useActiveWorkspace();
  const selectedIds = useCanvas((state) => state.selectedIds);
  const [editing, setEditing] = useState<string | null>(null);
  useLiveRectVersion();
  if (workspace.groups.length === 0 || workspace.resources.some((r) => r.maximized)) return null;

  const boxOf = (id: string) => {
    const resource = workspace.resources.find((r) => r.id === id);
    if (!resource || resource.minimized) return null;
    return getLiveRect(id) ?? resource;
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>, group: Group) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('button, input')) return;
    event.preventDefault();
    event.stopPropagation();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const state = useCanvas.getState();
    const members = group.members.filter((id) => state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.resources.some((r) => r.id === id));
    dragWindows({
      ids: members,
      start: { x: event.clientX, y: event.clientY },
      zoom: workspace.view.zoom,
      handle: event.currentTarget,
      pointerId: event.pointerId,
      reconcile: false,
      onFinish: (moved) => {
        // Clicking a group's header (without dragging) selects every card in it.
        if (!moved) useCanvas.getState().selectMany(members, additive);
      },
    });
  };

  const colorEntries = (group: Group): MenuEntry[] =>
    CARD_COLORS.map((color) => ({
      label: colorName(color),
      icon: <span className="menu-swatch" style={{ background: color }} />,
      onSelect: () => useCanvas.getState().setGroupColor(group.id, color),
    }));

  const openMenu = (event: React.MouseEvent, group: Group) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event, groupMenu(group, { rename: () => setEditing(group.id), colors: colorEntries(group) }));
  };

  const commitTitle = (group: Group, value: string | null) => {
    setEditing(null);
    if (value !== null && value.trim() && value.trim() !== group.title) useCanvas.getState().renameGroup(group.id, value);
  };

  return (
    <div className="group-layer">
      {workspace.groups.map((group) => {
        const boxes = group.members.map(boxOf).filter((box): box is NonNullable<typeof box> => box !== null);
        const frame = frameRect(boxes);
        if (!frame) return null;
        const rect = group.collapsed ? collapsedRect(frame) : frame;
        const allSelected = group.members.length > 0 && group.members.every((id) => selectedIds.includes(id));
        return (
          <div
            key={group.id}
            className={cn('group-frame', group.collapsed && 'group-collapsed', allSelected && 'group-selected')}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, '--group-color': group.color } as React.CSSProperties}
          >
            <div
              className="group-header"
              data-canvas-ui
              onPointerDown={(event) => startDrag(event, group)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditing(group.id);
              }}
              onContextMenu={(event) => openMenu(event, group)}
            >
              <button
                type="button"
                className="group-collapse"
                title={group.collapsed ? 'Expand group' : 'Collapse group'}
                onClick={(event) => {
                  event.stopPropagation();
                  useCanvas.getState().toggleGroupCollapsed(group.id);
                }}
              >
                {group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                type="button"
                className="group-dot"
                title="Change colour"
                aria-label="Change group colour"
                onClick={(event) => {
                  event.stopPropagation();
                  openContextMenu(event, colorEntries(group));
                }}
              />
              {editing === group.id ? (
                <TitleEditor initial={group.title} onDone={(value) => commitTitle(group, value)} />
              ) : (
                <span className="group-title" title="Double-click to rename" dir="auto">
                  {group.title}
                </span>
              )}
              <span className="group-count" title={`${group.members.length} item${group.members.length === 1 ? '' : 's'}`}>
                {group.members.length}
              </span>
              <button type="button" className="group-more" title="Group options" aria-label="Group options" onClick={(event) => openMenu(event, group)}>
                <MoreHorizontal size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
