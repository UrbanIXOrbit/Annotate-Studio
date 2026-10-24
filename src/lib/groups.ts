import { CARD_COLORS } from './cards.ts';
import { boundsOf, centerOf } from './arrange.ts';
import { bookLabel } from './note-clip.ts';
import type { Box, Point } from './connectors.ts';

/**
 * A group is a named, coloured frame around related cards. The frame is never stored: it is always
 * worked out from where its members are, so it follows them as they move, resize or get arranged.
 */
export interface Group {
  id: string;
  title: string;
  color: string;
  members: string[];
  collapsed: boolean;
}

export const GROUP_PAD = 28;
export const GROUP_HEADER = 40;
export const COLLAPSED_WIDTH = 270;
/** How far outside the frame a card may be dropped and still count as inside. */
export const DROP_MARGIN = 24;

const COLOR_NAMES: Record<string, string> = {
  '#ffcd45': 'Yellow',
  '#f97316': 'Orange',
  '#e44234': 'Red',
  '#22c55e': 'Green',
  '#3b82f6': 'Blue',
  '#8b5cf6': 'Purple',
};

export const colorName = (color: string | undefined) => (color ? (COLOR_NAMES[color.toLowerCase()] ?? 'Other') : 'No colour');

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validate groups loaded from disk: unknown cards are dropped, a card keeps only its first group, empty groups vanish. */
export function migrateGroups(raw: unknown, validIds: ReadonlySet<string>, makeId: () => string): Group[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set<string>();
  const ids = new Set<string>();
  const groups: Group[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const data = entry as Record<string, unknown>;
    const members = (Array.isArray(data.members) ? data.members : []).filter(
      (id): id is string => typeof id === 'string' && validIds.has(id) && !taken.has(id),
    );
    const unique = [...new Set(members)];
    if (unique.length === 0) continue;
    unique.forEach((id) => taken.add(id));
    let id = typeof data.id === 'string' && data.id && !ids.has(data.id) ? data.id : makeId();
    ids.add(id);
    groups.push({
      id,
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 80) : `Group ${groups.length + 1}`,
      color: typeof data.color === 'string' && HEX.test(data.color) ? data.color : CARD_COLORS[0],
      members: unique,
      collapsed: data.collapsed === true,
    });
  }
  return groups;
}

export const groupOf = (groups: Group[], id: string): Group | undefined => groups.find((group) => group.members.includes(id));

export function liveMembers(group: Group, existing: ReadonlySet<string>): string[] {
  return group.members.filter((id) => existing.has(id));
}

/** The padded frame around the member boxes, with room on top for the header. */
export function frameRect(boxes: Box[]): Box | null {
  const bounds = boundsOf(boxes);
  if (!bounds) return null;
  return {
    x: bounds.x - GROUP_PAD,
    y: bounds.y - GROUP_PAD - GROUP_HEADER,
    width: bounds.width + GROUP_PAD * 2,
    height: bounds.height + GROUP_PAD * 2 + GROUP_HEADER,
  };
}

/** A collapsed group is just its header, sitting where the top-left of the frame was. */
export function collapsedRect(frame: Box): Box {
  return { x: frame.x, y: frame.y, width: Math.min(COLLAPSED_WIDTH, Math.max(frame.width, 180)), height: GROUP_HEADER };
}

/** Cards that are tucked away because their group is collapsed. */
export function hiddenIds(groups: Group[], existing: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>();
  for (const group of groups) if (group.collapsed) liveMembers(group, existing).forEach((id) => hidden.add(id));
  return hidden;
}

const inside = (point: Point, box: Box, margin = 0) =>
  point.x >= box.x - margin && point.x <= box.x + box.width + margin && point.y >= box.y - margin && point.y <= box.y + box.height + margin;

const withoutEmpty = (groups: Group[]) => groups.filter((group) => group.members.length > 0);

/** Put `ids` into the group, taking them out of any other group first. */
export function addMembers(groups: Group[], groupId: string, ids: string[]): Group[] {
  const moving = new Set(ids);
  return withoutEmpty(
    groups.map((group) =>
      group.id === groupId
        ? { ...group, members: [...group.members.filter((id) => !moving.has(id)), ...ids] }
        : { ...group, members: group.members.filter((id) => !moving.has(id)) },
    ),
  );
}

export function removeMembers(groups: Group[], ids: string[]): Group[] {
  const leaving = new Set(ids);
  return withoutEmpty(groups.map((group) => ({ ...group, members: group.members.filter((id) => !leaving.has(id)) })));
}

export function nextGroupColor(groups: Group[]): string {
  const used = new Set(groups.map((group) => group.color.toLowerCase()));
  return CARD_COLORS.find((color) => !used.has(color.toLowerCase())) ?? CARD_COLORS[groups.length % CARD_COLORS.length];
}

export interface GroupableCard {
  id: string;
  color?: string;
  source?: string;
}

/** A sensible default name: the book if every card is from the same one, otherwise "Group N". */
export function defaultGroupTitle(cards: GroupableCard[], existingCount: number): string {
  const sources = new Set(cards.map((card) => card.source).filter((s): s is string => s !== undefined));
  if (sources.size === 1 && cards.every((card) => card.source !== undefined)) return bookLabel([...sources][0]);
  return `Group ${existingCount + 1}`;
}

export function defaultGroupColor(cards: GroupableCard[], groups: Group[]): string {
  // Only a colour that every card shares becomes the group's colour; otherwise take the next free one.
  const colors = cards.map((card) => card.color?.toLowerCase());
  if (colors.length > 0 && colors.every((color) => color !== undefined && color === colors[0])) return colors[0]!;
  return nextGroupColor(groups);
}

/** Cards with a source, bucketed by that source, in first-seen order. */
export function bucketBySource(cards: GroupableCard[]): { source: string; ids: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const card of cards) {
    if (card.source === undefined) continue;
    buckets.set(card.source, [...(buckets.get(card.source) ?? []), card.id]);
  }
  return [...buckets].map(([source, ids]) => ({ source, ids }));
}

export function bucketByColor(cards: GroupableCard[]): { color: string | undefined; ids: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const card of cards) {
    const key = card.color?.toLowerCase() ?? '';
    buckets.set(key, [...(buckets.get(key) ?? []), card.id]);
  }
  return [...buckets].map(([color, ids]) => ({ color: color || undefined, ids }));
}

/**
 * After cards were dropped, let them join the group they landed in, or leave the one they were dragged out of.
 * Judged from the dropped card's centre against the frame of the group's cards that did NOT move.
 */
export function reconcileMembership(groups: Group[], boxes: ReadonlyMap<string, Box>, moved: ReadonlySet<string>, margin = DROP_MARGIN): Group[] {
  let result = groups;
  const frameOfOthers = (group: Group) => {
    const others = group.members.filter((id) => !moved.has(id) && boxes.has(id)).map((id) => boxes.get(id)!);
    return others.length > 0 ? frameRect(others) : null;
  };
  for (const id of moved) {
    const box = boxes.get(id);
    if (!box) continue;
    const point = centerOf(box);
    const current = groupOf(result, id);
    if (current) {
      const frame = frameOfOthers(current);
      if (frame && !inside(point, frame, margin)) result = removeMembers(result, [id]);
      else continue;
    }
    const target = result
      .filter((group) => !group.collapsed && group.id !== current?.id)
      .map((group) => ({ group, frame: frameOfOthers(group) }))
      .filter((entry): entry is { group: Group; frame: Box } => entry.frame !== null && inside(point, entry.frame))
      .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0];
    if (target) result = addMembers(result, target.group.id, [id]);
  }
  return result;
}

