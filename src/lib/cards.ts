import type { Box, Point } from './connectors.ts';

export const CARD_WIDTH = 320;
export const CARD_MIN_HEIGHT = 150;
export const CARD_MAX_HEIGHT = 420;
export const CARD_COLORS = ['#FFCD45', '#F97316', '#E44234', '#22C55E', '#3B82F6', '#8B5CF6'];

const COLUMN_GAP = 48;
const CARD_GAP = 40;

export interface PlacementItem extends Box {
  id: string;
  type: string;
  minimized: boolean;
  source?: { filePath: string };
}

/**
 * Text selected from a PDF contains hard line breaks and split words. Join it back
 * into readable paragraphs while keeping blank-line paragraph breaks.
 */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function cardTitle(sourceTitle: string, page: number): string {
  return `${sourceTitle.replace(/\.pdf$/i, '')} · p. ${page}`;
}

export function estimateCardSize(content: string, note = ''): { width: number; height: number } {
  const charsPerLine = 38;
  const lines = (text: string) =>
    text
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const quote = content.trim() ? lines(content) * 20 + 24 : 0;
  const comment = note.trim() ? lines(note) * 19 + 20 : 56;
  const chrome = 34 + 40;
  const height = Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, chrome + quote + comment));
  return { width: CARD_WIDTH, height };
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function pushDown(items: PlacementItem[], rect: Box): Point {
  let y = rect.y;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocker = items.find((item) => overlaps(item, { ...rect, y }, CARD_GAP / 2));
    if (!blocker) break;
    y = blocker.y + blocker.height + CARD_GAP;
  }
  return { x: rect.x, y: Math.round(y) };
}

/**
 * Where a new highlight card should land. Cards from the same PDF stack in a column
 * to the right of the PDF window; anything in the way pushes the card further down.
 */
export function planCardPosition(
  items: PlacementItem[],
  options: { anchor?: Box; filePath?: string; size: { width: number; height: number }; fallbackCenter: Point },
): Point {
  const live = items.filter((item) => !item.minimized);
  const { anchor, filePath, size, fallbackCenter } = options;
  if (!anchor) {
    return pushDown(live, {
      x: Math.round(fallbackCenter.x - size.width / 2),
      y: Math.round(fallbackCenter.y - size.height / 2),
      ...size,
    });
  }
  const x = Math.round(anchor.x + anchor.width + COLUMN_GAP);
  const siblings = live.filter(
    (item) => item.type === 'card' && filePath !== undefined && item.source?.filePath === filePath && Math.abs(item.x - x) < 40,
  );
  const y = siblings.length > 0 ? Math.max(...siblings.map((item) => item.y + item.height)) + CARD_GAP : anchor.y;
  return pushDown(live, { x, y, ...size });
}
