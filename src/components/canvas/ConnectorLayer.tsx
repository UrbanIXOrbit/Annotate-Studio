'use client';

import React from 'react';
import { ArrowLeftRight, ArrowRight, Trash2, Type, X } from 'lucide-react';
import { activeWorkspace, hiddenResourceIds, useActiveWorkspace, useCanvas, type Resource } from '@/store/canvas';
import { useConnectUi } from '@/store/connect';
import { getLiveRect, useLiveRectVersion } from '@/lib/live-rects';
import {
  anchorPoint,
  connectorGeometry,
  hitTestBox,
  nearestSide,
  oppositeSide,
  pickTargetSide,
  type Box,
  type Connector,
  type Point,
  type Side,
} from '@/lib/connectors';
import { openContextMenu, type MenuEntry } from '@/components/ui/ContextMenu';
import { promptDialog } from '@/store/dialogs';

const SIDES: Side[] = ['n', 'e', 's', 'w'];
const MIN_DRAG_TO_CREATE = 36;

function boxOf(resource: Resource): Box {
  return getLiveRect(resource.id) ?? resource;
}

async function editLabel(connector: Connector) {
  const value = await promptDialog({
    title: 'Connector label',
    initialValue: connector.label ?? '',
    placeholder: 'e.g. causes, contradicts, example of…',
    confirmLabel: 'Save',
  });
  if (value === null) return;
  useCanvas.getState().updateConnector(connector.id, { label: value.trim().slice(0, 120) || undefined });
}

function connectorMenu(connector: Connector): MenuEntry[] {
  const canvas = useCanvas.getState();
  const items: MenuEntry[] = [
    { label: connector.label ? 'Edit label…' : 'Add label…', icon: <Type size={13} />, onSelect: () => void editLabel(connector) },
  ];
  if (connector.label) {
    items.push({ label: 'Remove label', icon: <X size={13} />, onSelect: () => canvas.updateConnector(connector.id, { label: undefined }) });
  }
  items.push(
    {
      label: connector.arrow ? 'Hide arrowhead' : 'Show arrowhead',
      icon: <ArrowRight size={13} />,
      onSelect: () => canvas.updateConnector(connector.id, { arrow: !connector.arrow }),
    },
    {
      label: 'Reverse direction',
      icon: <ArrowLeftRight size={13} />,
      onSelect: () =>
        canvas.updateConnector(connector.id, {
          from: connector.to,
          to: connector.from,
          fromSide: connector.toSide,
          toSide: connector.fromSide,
        }),
    },
    'separator',
    { label: 'Delete connector', icon: <Trash2 size={13} />, danger: true, onSelect: () => canvas.removeConnector(connector.id) },
  );
  return items;
}

interface Props {
  clientToWorld: (clientX: number, clientY: number) => Point;
}

export default function ConnectorLayer({ clientToWorld }: Props) {
  const workspace = useActiveWorkspace();
  const selectedId = useCanvas((state) => state.selectedId);
  const selectedConnectorId = useCanvas((state) => state.selectedConnectorId);
  const hoverId = useConnectUi((state) => state.hoverId);
  const drag = useConnectUi((state) => state.drag);
  useLiveRectVersion();

  const zoom = workspace.view.zoom;
  const tuckedAway = hiddenResourceIds(workspace);
  const visible = workspace.resources.filter((r) => !r.minimized && !tuckedAway.has(r.id));
  if (visible.some((r) => r.maximized)) return null;

  const boxes = new Map<string, Box>(visible.map((r) => [r.id, boxOf(r)]));
  const arrowSize = Math.min(34, Math.max(9, 11 / zoom));
  const handleSize = Math.min(40, Math.max(12, 14 / zoom));
  const uiScale = Math.min(3, 1 / zoom);

  const startConnect = (event: React.PointerEvent, fromId: string, fromSide: Side) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const ui = useConnectUi.getState();
    const origin = clientToWorld(event.clientX, event.clientY);
    ui.setDrag({ fromId, fromSide, pointer: origin, targetId: null, targetSide: null });

    const targetAt = (world: Point) => {
      const candidates = useCanvas
        .getState()
        .workspaces.find((w) => w.id === useCanvas.getState().activeWorkspaceId)
        ?.resources.filter((r) => !r.minimized && !hiddenResourceIds(useCanvas.getState().workspaces.find((w) => w.id === useCanvas.getState().activeWorkspaceId)!).has(r.id))
        .map((r) => ({ ...r, ...boxOf(r) }));
      return candidates ? hitTestBox(candidates, world, fromId) : null;
    };

    const onMove = (e: PointerEvent) => {
      const world = clientToWorld(e.clientX, e.clientY);
      const target = targetAt(world);
      const targetBox = target ? boxOf(target) : null;
      const sourceResource = useCanvas
        .getState()
        .workspaces.find((w) => w.id === useCanvas.getState().activeWorkspaceId)
        ?.resources.find((r) => r.id === fromId);
      const facing = sourceResource ? anchorPoint(boxOf(sourceResource), fromSide) : origin;
      ui.setDrag({
        fromId,
        fromSide,
        pointer: world,
        targetId: target?.id ?? null,
        targetSide: targetBox ? pickTargetSide(targetBox, world, facing) : null,
      });
    };

    const finish = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      const world = clientToWorld(e.clientX, e.clientY);
      const current = useConnectUi.getState().drag;
      ui.setDrag(null);
      if (!current) return;
      const canvas = useCanvas.getState();
      if (current.targetId && current.targetSide) {
        canvas.addConnector({ from: fromId, to: current.targetId, fromSide, toSide: current.targetSide });
        return;
      }
      const source = canvas.workspaces.find((w) => w.id === canvas.activeWorkspaceId)?.resources.find((r) => r.id === fromId);
      if (!source || Math.hypot(world.x - origin.x, world.y - origin.y) < MIN_DRAG_TO_CREATE) return;
      const cardId = canvas.addCard({ title: 'Card', content: '', center: world });
      const card = useCanvas.getState().workspaces.find((w) => w.id === useCanvas.getState().activeWorkspaceId)?.resources.find((r) => r.id === cardId);
      if (!card) return;
      const sourceAnchor = anchorPoint(boxOf(source), fromSide);
      useCanvas.getState().addConnector({ from: fromId, to: cardId, fromSide, toSide: nearestSide(card, sourceAnchor) });
      useCanvas.getState().select(cardId);
    };

    const cancel = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      ui.setDrag(null);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
  };

  const handleOwnerId = drag?.fromId ?? hoverId ?? selectedId;
  const handleOwner = handleOwnerId ? visible.find((r) => r.id === handleOwnerId) : undefined;

  const rendered = workspace.connectors.flatMap((connector) => {
    const a = boxes.get(connector.from);
    const b = boxes.get(connector.to);
    if (!a || !b) return [];
    const geometry = connectorGeometry(anchorPoint(a, connector.fromSide), connector.fromSide, anchorPoint(b, connector.toSide), connector.toSide, arrowSize, connector.arrow);
    return [{ connector, geometry }];
  });

  const selected = rendered.find((entry) => entry.connector.id === selectedConnectorId);

  let preview: { d: string; arrow: string | null } | null = null;
  let targetBox: Box | null = null;
  if (drag) {
    const fromBox = boxes.get(drag.fromId);
    if (fromBox) {
      const start = anchorPoint(fromBox, drag.fromSide);
      targetBox = drag.targetId ? (boxes.get(drag.targetId) ?? null) : null;
      if (targetBox && drag.targetSide) {
        preview = connectorGeometry(start, drag.fromSide, anchorPoint(targetBox, drag.targetSide), drag.targetSide, arrowSize, true);
      } else {
        preview = connectorGeometry(start, drag.fromSide, drag.pointer, oppositeSide(drag.fromSide), arrowSize, true);
      }
    }
  }

  return (
    <>
      <div className="connector-layer" aria-hidden={rendered.length === 0 ? true : undefined}>
        <svg className="connector-svg" width="1" height="1">
          {rendered.map(({ connector, geometry }) => {
            const active = connector.id === selectedConnectorId;
            return (
              <g key={connector.id} className={active ? 'connector connector-active' : 'connector'}>
                <path
                  className="connector-hit"
                  d={geometry.d}
                  data-canvas-ui
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    useCanvas.getState().selectConnector(connector.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    void editLabel(connector);
                  }}
                  onContextMenu={(event) => {
                    useCanvas.getState().selectConnector(connector.id);
                    openContextMenu(event, connectorMenu(connector));
                  }}
                />
                <path className="connector-line" d={geometry.d} />
                {geometry.arrow && <polygon className="connector-arrow" points={geometry.arrow} />}
              </g>
            );
          })}
          {preview && (
            <g className="connector connector-preview">
              <path className="connector-line" d={preview.d} />
              {preview.arrow && <polygon className="connector-arrow" points={preview.arrow} />}
            </g>
          )}
        </svg>
        {rendered.map(({ connector, geometry }) =>
          connector.label ? (
            <button
              key={connector.id}
              type="button"
              data-canvas-ui
              className={connector.id === selectedConnectorId ? 'connector-label connector-label-active' : 'connector-label'}
              style={{ left: geometry.mid.x, top: geometry.mid.y, transform: `translate(-50%, -50%) scale(${uiScale})` }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => useCanvas.getState().selectConnector(connector.id)}
              onDoubleClick={() => void editLabel(connector)}
              onContextMenu={(event) => {
                useCanvas.getState().selectConnector(connector.id);
                openContextMenu(event, connectorMenu(connector));
              }}
              dir="auto"
            >
              {connector.label}
            </button>
          ) : null,
        )}
        {targetBox && (
          <div
            className="connector-target"
            style={{ left: targetBox.x - 4, top: targetBox.y - 4, width: targetBox.width + 8, height: targetBox.height + 8 }}
          />
        )}
      </div>

      <div className="connector-overlay">
        {handleOwner &&
          SIDES.map((side) => {
            const point = anchorPoint(boxOf(handleOwner), side);
            const isTarget = drag?.targetId === handleOwner.id && drag.targetSide === side;
            return (
              <button
                key={side}
                type="button"
                data-canvas-ui
                data-handle-for={handleOwner.id}
                className={isTarget ? 'connector-handle connector-handle-target' : 'connector-handle'}
                style={{ left: point.x, top: point.y, width: handleSize, height: handleSize }}
                onPointerDown={(event) => startConnect(event, handleOwner.id, side)}
                title="Drag to connect"
                tabIndex={-1}
              />
            );
          })}
        {selected && !drag && (
          <div
            className="connector-toolbar"
            data-canvas-ui
            style={{ left: selected.geometry.mid.x, top: selected.geometry.mid.y, transform: `translate(-50%, calc(-100% - 10px)) scale(${uiScale})` }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <button type="button" title="Label" onClick={() => void editLabel(selected.connector)}>
              <Type size={13} />
            </button>
            <button
              type="button"
              title={selected.connector.arrow ? 'Hide arrowhead' : 'Show arrowhead'}
              className={selected.connector.arrow ? 'is-on' : undefined}
              onClick={() => useCanvas.getState().updateConnector(selected.connector.id, { arrow: !selected.connector.arrow })}
            >
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              title="Reverse direction"
              onClick={() =>
                useCanvas.getState().updateConnector(selected.connector.id, {
                  from: selected.connector.to,
                  to: selected.connector.from,
                  fromSide: selected.connector.toSide,
                  toSide: selected.connector.fromSide,
                })
              }
            >
              <ArrowLeftRight size={13} />
            </button>
            <button type="button" title="Delete (Del)" className="danger" onClick={() => useCanvas.getState().removeConnector(selected.connector.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
