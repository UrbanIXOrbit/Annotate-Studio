'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapIcon, X } from 'lucide-react';
import { ZOOM_MAX, ZOOM_MIN, hiddenResourceIds, useActiveWorkspace, useCanvas, visibleWorldRect, type Resource } from '@/store/canvas';
import { anchorPoint } from '@/lib/connectors';
import { collapsedRect, frameRect } from '@/lib/groups';
import { clamp, cn } from '@/lib/utils';

const WIDTH = 196;
const HEIGHT = 128;
/** A window below this projected size is drawn at this size so it stays visible. */
const MIN_SIZE = 4;
/** How close to the map edge a held drag starts auto-panning, and how fast. */
const EDGE_MARGIN = 16;
const EDGE_SPEED = 520;
/** Map magnification: 1 = the whole content fits, up to 3x for busy canvases. */
const MAP_MAX_ZOOM = 3;

interface MinimapLayout {
  bounds: { x: number; y: number; width: number; height: number };
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface MapTransform {
  /** Magnification of the map itself, 1 = fit. */
  z: number;
  /** Translation of the magnified map inside the surface, in surface px. */
  tx: number;
  ty: number;
}

const MAP_FIT: MapTransform = { z: 1, tx: 0, ty: 0 };

/** Keep the magnified map covering the surface (at fit, exactly the identity). */
function clampTransform(t: MapTransform): MapTransform {
  const z = clamp(t.z, 1, MAP_MAX_ZOOM);
  return {
    z,
    tx: clamp(t.tx, WIDTH * (1 - z), 0),
    ty: clamp(t.ty, HEIGHT * (1 - z), 0),
  };
}

export default function Minimap() {
  const workspace = useActiveWorkspace();
  const viewport = useCanvas((state) => state.viewport);
  const selectedId = useCanvas((state) => state.selectedId);
  const selectedConnectorId = useCanvas((state) => state.selectedConnectorId);
  // Collapsed state lives in the canvas store so the M shortcut can toggle it
  const collapsed = useCanvas((state) => state.minimapCollapsed);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const [mapTransform, setMapTransform] = useState<MapTransform>(MAP_FIT);
  // Event handlers (and the edge-pan tick) read this instead of the render
  // closure, so they always act on the current magnification.
  const transformRef = useRef(mapTransform);
  transformRef.current = mapTransform;
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const edgeRef = useRef<{ x: number; y: number; dirX: number; dirY: number; last: number; raf: number } | null>(null);

  const visible = useMemo(() => {
    const tuckedAway = hiddenResourceIds(workspace);
    return workspace.resources.filter((r) => !r.minimized && !tuckedAway.has(r.id));
  }, [workspace]);
  const view = workspace.view;
  const viewRect = visibleWorldRect(view, viewport);

  /** Whether a window currently appears on screen — used to dim the rest on the map. */
  const overlapsView = (r: { x: number; y: number; width: number; height: number }) =>
    r.x < viewRect.x + viewRect.width && r.x + r.width > viewRect.x &&
    r.y < viewRect.y + viewRect.height && r.y + r.height > viewRect.y;

  // Bounds come from the content alone, so panning and zooming never rescale the
  // map; the viewport rectangle is simply clamped to the surface when the view
  // reaches past the content.
  const layout = useMemo((): MinimapLayout => {
    const minX = Math.min(...visible.map((r) => r.x));
    const minY = Math.min(...visible.map((r) => r.y));
    const maxX = Math.max(...visible.map((r) => r.x + r.width));
    const maxY = Math.max(...visible.map((r) => r.y + r.height));
    const pad = 60;
    const bounds = { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    const scale = Math.min(WIDTH / bounds.width, HEIGHT / bounds.height);
    const offsetX = (WIDTH - bounds.width * scale) / 2;
    const offsetY = (HEIGHT - bounds.height * scale) / 2;
    return { bounds, scale, offsetX, offsetY };
  }, [visible]);

  const byId = useMemo(() => new Map(visible.map((r) => [r.id, r])), [visible]);

  /** Group frames, computed exactly like GroupLayer does (minimized members excluded). */
  const groupFrames = useMemo(() => {
    const rects = new Map(workspace.resources.filter((r) => !r.minimized).map((r) => [r.id, r]));
    return workspace.groups.flatMap((group) => {
      const boxes = group.members
        .map((id) => rects.get(id))
        .filter((r): r is Resource => !!r)
        .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
      const frame = frameRect(boxes);
      if (!frame) return [];
      return [{ id: group.id, color: group.color, rect: group.collapsed ? collapsedRect(frame) : frame }];
    });
  }, [workspace.resources, workspace.groups]);

  /** Connector lines between windows that are on the map. */
  const connectorLines = useMemo(
    () =>
      workspace.connectors.flatMap((connector) => {
        const from = byId.get(connector.from);
        const to = byId.get(connector.to);
        if (!from || !to) return [];
        const fromBox = { x: from.x, y: from.y, width: from.width, height: from.height };
        const toBox = { x: to.x, y: to.y, width: to.width, height: to.height };
        return [{ id: connector.id, selected: connector.id === selectedConnectorId, from: anchorPoint(fromBox, connector.fromSide), to: anchorPoint(toBox, connector.toSide) }];
      }),
    [workspace.connectors, byId, selectedConnectorId],
  );

  // A different workspace starts from the fitted map again.
  useEffect(() => {
    transformRef.current = MAP_FIT;
    setMapTransform(MAP_FIT);
  }, [workspace.id]);

  const project = (r: { x: number; y: number; width: number; height: number }) => ({
    left: layout.offsetX + (r.x - layout.bounds.x) * layout.scale,
    top: layout.offsetY + (r.y - layout.bounds.y) * layout.scale,
    width: Math.max(MIN_SIZE, r.width * layout.scale),
    height: Math.max(MIN_SIZE, r.height * layout.scale),
  });

  const projectViewport = (r: { x: number; y: number; width: number; height: number }) => {
    const p = project(r);
    const width = Math.max(MIN_SIZE, Math.min(p.width, WIDTH));
    const height = Math.max(MIN_SIZE, Math.min(p.height, HEIGHT));
    return {
      left: Math.max(0, Math.min(p.left, WIDTH - width)),
      top: Math.max(0, Math.min(p.top, HEIGHT - height)),
      width,
      height,
    };
  };

  const projectPoint = (p: { x: number; y: number }) => ({
    x: layout.offsetX + (p.x - layout.bounds.x) * layout.scale,
    y: layout.offsetY + (p.y - layout.bounds.y) * layout.scale,
  });

  /** Centre the canvas view on the map point under the pointer. */
  const navigate = (clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const t = transformRef.current;
    const mapX = (clientX - rect.left - t.tx) / t.z;
    const mapY = (clientY - rect.top - t.ty) / t.z;
    const worldX = layout.bounds.x + (mapX - layout.offsetX) / layout.scale;
    const worldY = layout.bounds.y + (mapY - layout.offsetY) / layout.scale;
    const { zoom } = view;
    useCanvas.getState().setView({ x: viewport.width / 2 - worldX * zoom, y: viewport.height / 2 - worldY * zoom, zoom });
  };

  // Holding a drag at (or past) the map edge keeps panning in that direction, so
  // the minimap reaches empty canvas regions far outside the content too.
  const stopEdgePan = () => {
    const edge = edgeRef.current;
    if (edge) cancelAnimationFrame(edge.raf);
    edgeRef.current = null;
  };

  useEffect(() => () => stopEdgePan(), []);

  // Wheel over the minimap zooms the *map itself*, anchored at the pointer —
  // the canvas never reacts to scrolling here. A native listener (React's wheel
  // listeners are passive, and this must not reach the canvas handler).
  useEffect(() => {
    if (!surfaceEl) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const current = transformRef.current;
      const rect = surfaceEl.getBoundingClientRect();
      const mapX = event.clientX - rect.left;
      const mapY = event.clientY - rect.top;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 128 : 1;
      const factor = Math.exp(-event.deltaY * units * 0.0022);
      const z = clamp(current.z * factor, 1, MAP_MAX_ZOOM);
      if (z === current.z) return;
      const tx = mapX - (mapX - current.tx) * (z / current.z);
      const ty = mapY - (mapY - current.ty) * (z / current.z);
      const next = clampTransform({ z, tx, ty });
      transformRef.current = next;
      setMapTransform(next);
    };
    surfaceEl.addEventListener('wheel', onWheel, { passive: false });
    return () => surfaceEl.removeEventListener('wheel', onWheel);
  }, [surfaceEl]);

  const updateEdgePan = (clientX: number, clientY: number, rect: DOMRect) => {
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    const dirX = clientX < rect.left + EDGE_MARGIN ? -1 : clientX > rect.right - EDGE_MARGIN ? 1 : 0;
    const dirY = clientY < rect.top + EDGE_MARGIN ? -1 : clientY > rect.bottom - EDGE_MARGIN ? 1 : 0;
    if (!dirX && !dirY && inside) {
      stopEdgePan();
      return;
    }
    const edge = edgeRef.current;
    if (edge && edge.dirX === dirX && edge.dirY === dirY) return;
    stopEdgePan();
    const virtual = { x: clientX, y: clientY, dirX, dirY, last: performance.now(), raf: 0 };
    const tick = () => {
      const current = edgeRef.current;
      if (!current) return;
      const now = performance.now();
      current.x += (current.dirX * EDGE_SPEED * (now - current.last)) / 1000;
      current.y += (current.dirY * EDGE_SPEED * (now - current.last)) / 1000;
      current.last = now;
      navigate(current.x, current.y);
      current.raf = requestAnimationFrame(tick);
    };
    virtual.raf = requestAnimationFrame(tick);
    edgeRef.current = virtual;
  };

  /** Zoom so the resource fills the screen, centred like `focusResource` does. */
  const zoomToResource = (resource: Resource) => {
    const state = useCanvas.getState();
    const zoom = clamp(Math.min((viewport.width - 96) / resource.width, (viewport.height - 96) / resource.height), ZOOM_MIN, ZOOM_MAX);
    state.setView({
      x: viewport.width / 2 - (resource.x + resource.width / 2) * zoom,
      y: viewport.height / 2 - (resource.y + resource.height / 2) * zoom,
      zoom,
    });
  };

  /** Keyboard panning for the focused map: arrows move the view, Shift makes bigger steps. */
  const panByKey = (key: string, fast: boolean) => {
    const step = (fast ? 320 : 100) / view.zoom; // world units
    const dx = key === 'arrowright' ? -step : key === 'arrowleft' ? step : 0;
    const dy = key === 'arrowdown' ? -step : key === 'arrowup' ? step : 0;
    if (dx || dy) useCanvas.getState().setView({ x: view.x + dx, y: view.y + dy, zoom: view.zoom });
  };

  if (visible.length === 0) return null;

  if (collapsed) {
    return (
      <button type="button" data-canvas-ui className="minimap-toggle" onClick={() => useCanvas.getState().setMinimapCollapsed(false)} title="Show minimap (M)" aria-label="Show minimap">
        <MapIcon size={14} />
      </button>
    );
  }

  const t = clampTransform(mapTransform);

  return (
    <div className="minimap" data-canvas-ui onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <div
        ref={(el) => {
          surfaceRef.current = el;
          setSurfaceEl(el);
        }}
        className="minimap-surface"
        style={{ width: WIDTH, height: HEIGHT }}
        tabIndex={0}
        role="application"
        aria-label="Minimap. Scroll to zoom the map, drag to move the view, click a window to focus it, double-click the background to reset."
        onKeyDown={(event) => {
          const key = event.key.toLowerCase();
          if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (!useCanvas.getState().locked) panByKey(key, event.shiftKey);
        }}
        onDoubleClick={(event) => {
          if ((event.target as Element).closest('.minimap-window')) return;
          transformRef.current = MAP_FIT;
          setMapTransform(MAP_FIT);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || useCanvas.getState().locked) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          stopEdgePan();
          dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
          // At fit zoom a press immediately centres the view on that point.
          if (t.z === 1) navigate(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const drag = dragRef.current;
          if (!drag) return;
          if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) drag.moved = true;
          const current = transformRef.current;
          if (current.z > 1) {
            // Magnified: dragging pans the map itself, not the canvas.
            const next = clampTransform({ z: current.z, tx: current.tx + (event.clientX - drag.x), ty: current.ty + (event.clientY - drag.y) });
            transformRef.current = next;
            setMapTransform(next);
          } else {
            navigate(event.clientX, event.clientY);
            updateEdgePan(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
          }
          drag.x = event.clientX;
          drag.y = event.clientY;
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          stopEdgePan();
          // Magnified: a plain click (no drag) still centres the canvas view.
          if (drag && !drag.moved && t.z > 1) navigate(event.clientX, event.clientY);
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
          stopEdgePan();
        }}
      >
        <div className="minimap-content" style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.z})` }}>
          <svg className="minimap-groups" width={WIDTH} height={HEIGHT} aria-hidden="true">
            {groupFrames.map((frame) => {
              const box = projectViewport(frame.rect);
              return (
                <rect
                  key={frame.id}
                  className="minimap-group"
                  x={box.left}
                  y={box.top}
                  width={Math.max(MIN_SIZE, box.width)}
                  height={Math.max(MIN_SIZE, box.height)}
                  rx={2}
                  stroke={frame.color}
                  fill={frame.color}
                />
              );
            })}
          </svg>
          {visible.map((resource) => {
            const floored = resource.width * layout.scale < MIN_SIZE || resource.height * layout.scale < MIN_SIZE;
            return (
              <div
                key={resource.id}
                className={cn(
                  'minimap-window',
                  `minimap-${resource.type}`,
                  !overlapsView(resource) && 'minimap-out',
                  floored && 'minimap-tiny',
                  resource.id === selectedId && 'minimap-selected',
                )}
                style={project(resource)}
                title={resource.title}
                onPointerDown={(event) => {
                  if (event.button !== 0 || useCanvas.getState().locked) return;
                  event.stopPropagation();
                  useCanvas.getState().focusResource(resource.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  zoomToResource(resource);
                }}
              />
            );
          })}
          <svg className="minimap-links" width={WIDTH} height={HEIGHT} aria-hidden="true">
            {connectorLines.map((line) => {
              const a = projectPoint(line.from);
              const b = projectPoint(line.to);
              return (
                <line
                  key={line.id}
                  className={cn('minimap-link', line.selected && 'minimap-link-selected')}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              );
            })}
          </svg>
          <div className="minimap-viewport" style={projectViewport(viewRect)} />
        </div>
      </div>
      <button type="button" className="minimap-close" onClick={() => useCanvas.getState().setMinimapCollapsed(true)} title="Hide minimap (M)" aria-label="Hide minimap">
        <X size={11} />
      </button>
    </div>
  );
}
