/**
 * Link graph — the pure layer: wiki-link extraction (via the same inline
 * parser that renders them, so there is no second syntax to keep in sync),
 * the backlink index, and a deterministic force layout for the graph view.
 * No store imports.
 */
import { parseBlocks, parseInline, type Block, type Inline } from './markdown.ts';

/** One indexed document's links: raw targets kept, resolved at query time. */
export interface LinkDoc {
  path: string;
  title: string;
  markdown: string;
}

/** An edge as stored: the linking document plus the raw link text. */
export interface RawLink {
  from: string;
  target: string;
}

export interface LinkIndex {
  docs: Map<string, LinkDoc>;
  /** All wiki links, including duplicates (one row per mention). */
  raw: RawLink[];
}

/** A link after resolution against the current library. */
export interface ResolvedLink {
  /** Document containing the link. */
  from: string;
  /** Resolved target path, or the raw target when unresolvable. */
  to: string;
  target: string;
  resolved: boolean;
}

export interface ResolvedLinks {
  outgoing: Map<string, ResolvedLink[]>;
  backlinks: Map<string, ResolvedLink[]>;
  /** Raw targets that resolve to nothing, deduped, display-cased. */
  unresolved: string[];
}

/** Collect raw link targets from markdown text. */
export function extractLinks(markdown: string): string[] {
  const targets: string[] = [];
  const visitInline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'wikilink') targets.push(node.target);
      else if (node.type === 'link' || node.type === 'strong' || node.type === 'em' || node.type === 'del') {
        visitInline(node.children);
      }
    }
  };
  const visitBlock = (block: Block) => {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        visitInline(block.children);
        break;
      case 'quote':
        block.children.forEach(visitBlock);
        break;
      case 'list':
        block.items.forEach((item) => item.children.forEach(visitBlock));
        break;
      case 'table':
        [...block.header, ...block.rows.flat()].forEach(visitInline);
        break;
      // code, math and hr never render wiki links — skip them, matching the renderer.
    }
  };
  for (const block of parseBlocks(markdown.split('\n'))) visitBlock(block);
  return targets;
}

/** Build the raw index: every mention of every target. */
export function buildLinkIndex(docs: LinkDoc[]): LinkIndex {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const raw: RawLink[] = [];
  for (const doc of docs) {
    for (const target of extractLinks(doc.markdown)) {
      raw.push({ from: doc.path, target });
    }
  }
  return { docs: byPath, raw };
}

/** The line of the markdown containing the first mention of the target. */
export function lineForLink(markdown: string, target: string): string {
  const needle = `[[${target.split('#')[0]}`;
  for (const line of markdown.split('\n')) {
    if (line.includes(needle)) return line.trim();
  }
  return '';
}

/**
 * Resolve every raw link against the library at query time — the index keeps
 * the raw text so file renames stay correct without rewriting content.
 */
export function resolveLinks(index: LinkIndex, resolve: (target: string) => string | null): ResolvedLinks {
  const outgoing = new Map<string, ResolvedLink[]>();
  const backlinks = new Map<string, ResolvedLink[]>();
  const unresolvedSet = new Map<string, string>();
  for (const { from, target } of index.raw) {
    const to = resolve(target);
    const resolved = to !== null;
    const link: ResolvedLink = { from, to: resolved ? to : target, target, resolved };
    const out = outgoing.get(from) ?? [];
    out.push(link);
    outgoing.set(from, out);
    if (resolved && to !== from) {
      const back = backlinks.get(to) ?? [];
      back.push(link);
      backlinks.set(to, back);
    }
    if (!resolved && !unresolvedSet.has(target.toLowerCase())) unresolvedSet.set(target.toLowerCase(), target);
  }
  return { outgoing, backlinks, unresolved: [...unresolvedSet.values()] };
}

/** Degree of a node, for sizing in the graph view. */
export function countDegrees(links: ResolvedLink[]): Map<string, number> {
  const degrees = new Map<string, number>();
  const bump = (path: string) => degrees.set(path, (degrees.get(path) ?? 0) + 1);
  for (const link of links) {
    if (link.resolved) {
      bump(link.from);
      bump(link.to);
    }
  }
  return degrees;
}

/* ---------- Layout ---------- */

export interface LayoutNode {
  id: string;
  /** Rough visual weight (link count) — keeps hubs apart more than leaves. */
  weight?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Point {
  x: number;
  y: number;
}

/** Deterministic PRNG so the same graph always draws the same way. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed;

/**
 * Spring-embedder layout: fixed iteration count (no timers), seeded jitter,
 * repulsion between all nodes, attraction along edges, gentle pull to centre.
 * Pure and synchronous — the graph view renders the result directly.
 */
export function graphLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  { width = 800, height = 560, iterations = 180 }: { width?: number; height?: number; iterations?: number } = {},
): Map<string, Point> {
  const random = mulberry32(SEED);
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.38;
  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2;
    positions.set(node.id, {
      x: cx + Math.cos(angle) * radius + (random() - 0.5) * 24,
      y: cy + Math.sin(angle) * radius + (random() - 0.5) * 24,
    });
  });

  const weightOf = (id: string) => Math.max(1, nodes.find((node) => node.id === id)?.weight ?? 1);
  const pairs: Array<[string, string]> = [];
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!positions.has(edge.from) || !positions.has(edge.to) || edge.from === edge.to) continue;
    pairs.push([edge.from, edge.to]);
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
    const back = adjacency.get(edge.to) ?? [];
    back.push(edge.from);
    adjacency.set(edge.to, back);
  }

  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)); // ideal distance
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    const displacement = new Map<string, Point>();
    const bump = (id: string, x: number, y: number) => {
      const current = displacement.get(id) ?? { x: 0, y: 0 };
      displacement.set(id, { x: current.x + x, y: current.y + y });
    };

    // Repulsion between every pair.
    const ids = [...positions.keys()];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const force = ((weightOf(ids[i]) + weightOf(ids[j])) * k * k) / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        bump(ids[i], fx, fy);
        bump(ids[j], -fx, -fy);
      }
    }

    // Attraction along edges.
    for (const [from, to] of pairs) {
      const a = positions.get(from)!;
      const b = positions.get(to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = (distance * distance) / (k * 4);
      const fx = (dx / distance) * force * 0.06;
      const fy = (dy / distance) * force * 0.06;
      bump(from, fx, fy);
      bump(to, -fx, -fy);
    }

    // Apply, clamped by a cooling temperature, then pull gently to centre.
    for (const [id, point] of positions) {
      const delta = displacement.get(id) ?? { x: 0, y: 0 };
      const size = Math.hypot(delta.x, delta.y) || 1;
      const limit = cooling * 14;
      point.x += (delta.x / size) * Math.min(limit, size);
      point.y += (delta.y / size) * Math.min(limit, size);
      point.x += (cx - point.x) * 0.012;
      point.y += (cy - point.y) * 0.012;
    }
  }

  // Fit inside the frame with a small margin.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const margin = 48;
  for (const point of positions.values()) {
    point.x = margin + ((point.x - minX) / spanX) * (width - margin * 2);
    point.y = margin + ((point.y - minY) / spanY) * (height - margin * 2);
  }
  return positions;
}
