'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Ghost, Layers, Globe, Loader2, NotebookPen, ZoomIn, ZoomOut } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { graphLayout, type Point } from '@/lib/link-graph';
import { computeGraph, openGraphNode, useGraph, type GraphKind, type GraphModel } from '@/store/graph';
import { openWikiLink } from '@/lib/workspace-actions';
import { cn } from '@/lib/utils';

const KIND_META: Record<GraphKind, { label: string; icon: React.ReactNode }> = {
  note: { label: 'Notes', icon: <NotebookPen size={13} /> },
  pdf: { label: 'PDFs', icon: <FileText size={13} /> },
  book: { label: 'Books', icon: <BookOpen size={13} /> },
  card: { label: 'Cards', icon: <Layers size={13} /> },
  article: { label: 'Articles', icon: <Globe size={13} /> },
  other: { label: 'Files', icon: <Layers size={13} /> },
};

const KINDS: GraphKind[] = ['note', 'pdf', 'book', 'card', 'article', 'other'];

const WIDTH = 840;
const HEIGHT = 560;

/** SVG client coordinates → viewBox coordinates. */
function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number, view: ViewBox): Point {
  const rect = svg.getBoundingClientRect();
  const scaleX = view.width / rect.width;
  const scaleY = view.height / rect.height;
  return { x: view.x + (clientX - rect.left) * scaleX, y: view.y + (clientY - rect.top) * scaleY };
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const INITIAL_VIEW: ViewBox = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

export default function GraphView() {
  const open = useGraph((state) => state.open);
  const revision = useGraph((state) => state.revision);
  const indexing = useGraph((state) => state.indexing);
  const focus = useGraph((state) => state.focus);
  const hide = useGraph((state) => state.hide);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox>(INITIAL_VIEW);
  const [hiddenKinds, setHiddenKinds] = useState<Set<GraphKind>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Map<string, Point>>(new Map());
  const dragRef = useRef<{ id: string | null; panning: boolean; moved?: boolean; lastX: number; lastY: number } | null>(null);
  const suppressClick = useRef(false);

  const model: GraphModel | null = useMemo(() => (open ? computeGraph() : null), [open, revision]);

  const layout = useMemo(() => {
    if (!model) return null;
    const phantom = model.unresolved.map((target) => ({ id: `phantom:${target}` }));
    return graphLayout(
      [...model.nodes.map((node) => ({ id: node.id, weight: node.degree })), ...phantom],
      model.edges,
      { width: WIDTH, height: HEIGHT },
    );
    // Pinned positions are applied outside the memo so dragging never reruns layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, revision]);

  // Wiki links that resolve to no file, drawn to dashed phantom nodes.
  const phantomEdges = useMemo(() => {
    if (!model) return [];
    const seen = new Map<string, string>();
    for (const target of model.unresolved) seen.set(target.toLowerCase(), target);
    const edges: { from: string; to: string }[] = [];
    for (const links of model.outgoing.values()) {
      for (const link of links) {
        if (!link.resolved) {
          const display = seen.get(link.target.toLowerCase());
          if (display) edges.push({ from: link.from, to: `phantom:${display}` });
        }
      }
    }
    return edges;
  }, [model]);

  const allEdges = useMemo(
    () => (model ? [...model.edges, ...phantomEdges.map((edge) => ({ ...edge, kind: 'link' as const, label: undefined }))] : []),
    [model, phantomEdges],
  );

  // Neighbourhood of the hovered node, for the dim-the-rest effect.
  const neighborhood = useMemo(() => {
    if (!hovered) return null;
    const ids = new Set<string>([hovered]);
    for (const edge of allEdges) {
      if (edge.from === hovered) ids.add(edge.to);
      if (edge.to === hovered) ids.add(edge.from);
    }
    return ids;
  }, [hovered, allEdges]);

  // Zoom around the pointer. React's onWheel is passive, so register a native
  // non-passive listener to keep the page from scrolling behind the dialog.
  useEffect(() => {
    const svg = svgRef.current;
    if (!open || !svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = clientToSvg(svg, event.clientX, event.clientY, view);
      const factor = event.deltaY < 0 ? 0.88 : 1.14;
      const width = Math.min(WIDTH, Math.max(WIDTH / 6, view.width * factor));
      const height = width * (HEIGHT / WIDTH);
      setView({
        width,
        height,
        x: point.x - (point.x - view.x) * (width / view.width),
        y: point.y - (point.y - view.y) * (height / view.height),
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [open, view]);

  if (!open || !model || !layout) return null;

  const positionOf = (id: string): Point | undefined => {
    if (pinned.has(id)) return pinned.get(id);
    return layout.get(id);
  };

  const visibleNodes = model.nodes.filter((node) => !hiddenKinds.has(node.kind));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));

  const indexingNow = indexing.total > 0 && indexing.done < indexing.total;

  const onMouseMove = (event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const point = clientToSvg(svg, event.clientX, event.clientY, view);
    if (drag.panning) {
      setView((current) => ({ ...current, x: current.x - (point.x - drag.lastX), y: current.y - (point.y - drag.lastY) }));
      drag.lastX = point.x;
      drag.lastY = point.y;
      return;
    }
    if (drag.id) {
      drag.moved = true;
      const id = drag.id;
      setPinned((current) => new Map(current).set(id, point));
    }
  };

  const endDrag = () => {
    // A pin-drag ends with a click event on the node — don't open it then.
    suppressClick.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
  };

  const zoomBy = (factor: number) => {
    setView((current) => {
      const width = Math.min(WIDTH, Math.max(WIDTH / 6, current.width * factor));
      const cx = current.x + current.width / 2;
      const cy = current.y + current.height / 2;
      const height = width * (HEIGHT / WIDTH);
      return { x: cx - width / 2, y: cy - height / 2, width, height };
    });
  };

  const toggleKind = (kind: GraphKind) => {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const activateNode = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (id.startsWith('phantom:')) {
      void openWikiLink(id.slice(8));
      return;
    }
    if (openGraphNode(id)) hide();
  };

  return (
    <Dialog open onClose={hide} title="Knowledge graph" width={920}>
      <div className="graph-view">
        <div className="graph-toolbar">
          <div className="segmented" role="group" aria-label="Node types">
            {KINDS.map((kind) => (
              <button key={kind} type="button" className={cn(!hiddenKinds.has(kind) && 'active')} aria-pressed={!hiddenKinds.has(kind)} onClick={() => toggleKind(kind)}>
                {KIND_META[kind].icon} {KIND_META[kind].label}
              </button>
            ))}
            <button type="button" className="active" title="Unresolved links (dashed)">
              <Ghost size={13} /> Phantoms
            </button>
          </div>
          <span className="graph-toolbar-info">
            {indexingNow ? (
              <>
                <Loader2 size={12} className="spin" /> Reading files… {indexing.done}/{indexing.total}
              </>
            ) : (
              `${visibleNodes.length} node${visibleNodes.length === 1 ? '' : 's'} · ${edges.length} connection${edges.length === 1 ? '' : 's'}`
            )}
          </span>
          <div className="graph-zoom">
            <button type="button" className="icon-btn" onClick={() => zoomBy(0.85)} title="Zoom out">
              <ZoomOut size={14} />
            </button>
            <button type="button" className="icon-btn" onClick={() => zoomBy(1.15)} title="Zoom in">
              <ZoomIn size={14} />
            </button>
          </div>
        </div>
        <svg
          ref={svgRef}
          className="graph-canvas"
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          role="group"
          aria-label="Knowledge graph of notes, files and canvas connections"
        >
          <rect
            x={view.x}
            y={view.y}
            width={view.width}
            height={view.height}
            fill="transparent"
            onMouseDown={(event) => {
              dragRef.current = { id: null, panning: true, lastX: 0, lastY: 0 };
              const svg = svgRef.current;
              if (svg) {
                const point = clientToSvg(svg, event.clientX, event.clientY, view);
                dragRef.current.lastX = point.x;
                dragRef.current.lastY = point.y;
              }
            }}
          />
          {edges.map((edge, index) => {
            const from = positionOf(edge.from);
            const to = positionOf(edge.to);
            if (!from || !to) return null;
            const active = neighborhood?.has(edge.from) && neighborhood?.has(edge.to);
            return (
              <line
                key={`edge-${index}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={cn('graph-edge', edge.kind === 'connector' && 'graph-edge-connector', active && 'graph-edge-active', neighborhood && !active && 'graph-edge-dim')}
              />
            );
          })}
          {visibleNodes.map((node) => {
            const point = positionOf(node.id);
            if (!point) return null;
            const active = neighborhood?.has(node.id) ?? true;
            const radius = 5 + Math.min(9, node.degree * 1.6);
            const label = node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title;
            return (
              <g
                key={node.id}
                className={cn('graph-node', `graph-node-${node.kind}`, !active && 'graph-node-dim', focus === node.id && 'graph-node-focus', hovered === node.id && 'graph-node-hover')}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  dragRef.current = { id: node.id, panning: false, lastX: 0, lastY: 0 };
                  event.preventDefault();
                }}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered((current) => (current === node.id ? null : current))}
                onClick={() => activateNode(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activateNode(node.id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Open ${node.title}`}
              >
                <circle cx={point.x} cy={point.y} r={radius} />
                <text x={point.x} y={point.y + radius + 11} textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}
          {model.unresolved.map((target) => {
            const id = `phantom:${target}`;
            const point = positionOf(id);
            if (!point) return null;
            const active = neighborhood?.has(id) ?? true;
            return (
              <g
                key={id}
                className={cn('graph-node graph-node-phantom', !active && 'graph-node-dim', hovered === id && 'graph-node-hover')}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  dragRef.current = { id, panning: false, lastX: 0, lastY: 0 };
                  event.preventDefault();
                }}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered((current) => (current === id ? null : current))}
                onClick={() => activateNode(id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activateNode(id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Open unresolved link ${target}`}
              >
                <circle cx={point.x} cy={point.y} r={6} />
                <text x={point.x} y={point.y + 17} textAnchor="middle">
                  {target.length > 26 ? `${target.slice(0, 25)}…` : target}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="graph-hint">Hover to trace connections · drag a dot to rearrange · click to open on canvas · scroll to zoom · drag the background to pan.</p>
      </div>
    </Dialog>
  );
}
