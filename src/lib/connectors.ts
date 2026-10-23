export type Side = 'n' | 'e' | 's' | 'w';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Connector {
  id: string;
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
  label?: string;
  arrow: boolean;
}

const SIDES: Side[] = ['n', 'e', 's', 'w'];

export function isSide(value: unknown): value is Side {
  return typeof value === 'string' && (SIDES as string[]).includes(value);
}

export function oppositeSide(side: Side): Side {
  return side === 'n' ? 's' : side === 's' ? 'n' : side === 'e' ? 'w' : 'e';
}

/** Unit vector pointing away from the box on the given side. */
export function sideNormal(side: Side): Point {
  switch (side) {
    case 'n':
      return { x: 0, y: -1 };
    case 's':
      return { x: 0, y: 1 };
    case 'e':
      return { x: 1, y: 0 };
    default:
      return { x: -1, y: 0 };
  }
}

export function anchorPoint(box: Box, side: Side): Point {
  switch (side) {
    case 'n':
      return { x: box.x + box.width / 2, y: box.y };
    case 's':
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'e':
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    default:
      return { x: box.x, y: box.y + box.height / 2 };
  }
}

/** The side of `box` that `point` is closest to, judged relative to the box's aspect ratio. */
export function nearestSide(box: Box, point: Point): Side {
  const halfW = Math.max(1, box.width / 2);
  const halfH = Math.max(1, box.height / 2);
  const dx = (point.x - (box.x + halfW)) / halfW;
  const dy = (point.y - (box.y + halfH)) / halfH;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}

/**
 * Which side of the target a connector should attach to when it is dropped at `pointer`.
 * Near an edge the user's aim wins; deep inside the box, face the source so the curve
 * stays visible instead of looping behind the card.
 */
export function pickTargetSide(box: Box, pointer: Point, facing: Point): Side {
  const halfW = Math.max(1, box.width / 2);
  const halfH = Math.max(1, box.height / 2);
  const dx = (pointer.x - (box.x + halfW)) / halfW;
  const dy = (pointer.y - (box.y + halfH)) / halfH;
  if (Math.max(Math.abs(dx), Math.abs(dy)) >= 0.55) return nearestSide(box, pointer);
  return nearestSide(box, facing);
}

export interface ConnectorGeometry {
  /** SVG path data for the curve. */
  d: string;
  /** Midpoint of the curve, useful for labels and the toolbar. */
  mid: Point;
  /** SVG `points` string for the arrowhead triangle, or null when the arrow is hidden. */
  arrow: string | null;
}

export function connectorGeometry(
  from: Point,
  fromSide: Side,
  to: Point,
  toSide: Side,
  arrowSize = 10,
  withArrow = true,
): ConnectorGeometry {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const offset = Math.min(220, Math.max(36, distance * 0.45));
  const n1 = sideNormal(fromSide);
  const n2 = sideNormal(toSide);
  const c1 = { x: from.x + n1.x * offset, y: from.y + n1.y * offset };
  const c2 = { x: to.x + n2.x * offset, y: to.y + n2.y * offset };
  const round = (value: number) => Math.round(value * 100) / 100;
  const d = `M ${round(from.x)} ${round(from.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(to.x)} ${round(to.y)}`;
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
  let arrow: string | null = null;
  if (withArrow) {
    const base = { x: to.x + n2.x * arrowSize * 1.4, y: to.y + n2.y * arrowSize * 1.4 };
    const perp = { x: -n2.y, y: n2.x };
    const half = arrowSize * 0.6;
    const left = { x: base.x + perp.x * half, y: base.y + perp.y * half };
    const right = { x: base.x - perp.x * half, y: base.y - perp.y * half };
    arrow = `${round(to.x)},${round(to.y)} ${round(left.x)},${round(left.y)} ${round(right.x)},${round(right.y)}`;
  }
  return { d, mid, arrow };
}

/** Topmost item (highest z) whose box contains `point`, optionally ignoring one id. */
export function hitTestBox<T extends Box & { id: string; z: number }>(
  items: T[],
  point: Point,
  ignoreId?: string,
  margin = 0,
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (item.id === ignoreId) continue;
    const inside =
      point.x >= item.x - margin &&
      point.x <= item.x + item.width + margin &&
      point.y >= item.y - margin &&
      point.y <= item.y + item.height + margin;
    if (inside && (!best || item.z > best.z)) best = item;
  }
  return best;
}

export function sameConnection(a: Pick<Connector, 'from' | 'to' | 'fromSide' | 'toSide'>, b: Pick<Connector, 'from' | 'to' | 'fromSide' | 'toSide'>): boolean {
  return a.from === b.from && a.to === b.to && a.fromSide === b.fromSide && a.toSide === b.toSide;
}

/**
 * Validates persisted connectors. Anything malformed, self-referencing, duplicated,
 * or pointing at a resource that no longer exists is dropped.
 */
export function migrateConnectors(raw: unknown, validIds: ReadonlySet<string>, makeId: () => string): Connector[] {
  if (!Array.isArray(raw)) return [];
  const result: Connector[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const data = entry as Record<string, unknown>;
    if (typeof data.from !== 'string' || typeof data.to !== 'string') continue;
    if (data.from === data.to || !validIds.has(data.from) || !validIds.has(data.to)) continue;
    const connector: Connector = {
      id: typeof data.id === 'string' && data.id && !ids.has(data.id) ? data.id : makeId(),
      from: data.from,
      to: data.to,
      fromSide: isSide(data.fromSide) ? data.fromSide : 'e',
      toSide: isSide(data.toSide) ? data.toSide : 'w',
      label: typeof data.label === 'string' && data.label.trim() ? data.label.trim().slice(0, 120) : undefined,
      arrow: data.arrow !== false,
    };
    if (result.some((existing) => sameConnection(existing, connector))) continue;
    ids.add(connector.id);
    result.push(connector);
  }
  return result;
}
