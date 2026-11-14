/**
 * Inbox board — a pure view over a capture note's markdown. Cards are list
 * items under `## day` headings; the checkbox marker is the card's lane:
 * plain = Inbox, `[ ]` = To do, `[x]` = Done. Every edit rewrites only the
 * affected lines, so the note stays a plain, portable markdown file.
 */

export type InboxLane = 'inbox' | 'todo' | 'done';

export interface InboxCard {
  /** First line of the card's block (its bullet). */
  start: number;
  /** Last line of the block, inclusive. */
  end: number;
  lane: InboxLane;
  /** The `## ` heading the card sits under (empty before the first heading). */
  heading: string;
  /** `14:32` when the capture carries a time stamp. */
  time: string | null;
  /** Card text without the bullet, checkbox or time; continuation lines joined with `\n`. */
  text: string;
}

const BULLET = /^(\s*)- (?:(\[(?: |x|X)\]) ?)?(.*)$/;
const TIME = /^(\d{1,2}:\d{2})\s*[—–-]\s*(.*)$/;

function laneOf(marker: string | undefined): InboxLane {
  if (!marker) return 'inbox';
  return marker[1].toLowerCase() === 'x' ? 'done' : 'todo';
}

/** Split one card's first line into its parts; null when the line is not a capture. */
function readBullet(line: string): { indent: string; marker: string; time: string | null; text: string } | null {
  const match = BULLET.exec(line);
  if (!match) return null;
  // Nested bullets (indented) belong to their parent card, not the board.
  if (match[1].length > 0) return null;
  const marker = match[2] ?? '';
  const rest = match[3];
  const timed = TIME.exec(rest);
  return {
    indent: match[1],
    marker,
    time: timed ? timed[1] : null,
    text: timed ? timed[2] : rest,
  };
}

function isContinuation(line: string): boolean {
  return line.startsWith('  ') || line.startsWith('\t');
}

/** Every card in the note, in document order. Non-card lines are left untouched. */
export function parseInbox(markdown: string): InboxCard[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const cards: InboxCard[] = [];
  let heading = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('## ')) {
      heading = line.trim();
      continue;
    }
    const bullet = readBullet(line);
    if (!bullet) continue;
    let end = index;
    const continuation: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor];
      if (isContinuation(next)) {
        continuation.push(next.replace(/^\t|^ {1,2}/, ''));
        end = cursor;
        cursor += 1;
        continue;
      }
      // A blank line stays inside the card only when indented text follows it.
      if (next.trim() === '' && cursor + 1 < lines.length && isContinuation(lines[cursor + 1])) {
        continuation.push('');
        end = cursor;
        cursor += 1;
        continue;
      }
      break;
    }
    cards.push({
      start: index,
      end,
      lane: laneOf(bullet.marker),
      heading,
      time: bullet.time,
      text: [bullet.text.trimEnd(), ...continuation].join('\n'),
    });
    index = end;
  }
  return cards;
}

/** The `## day` sections of one lane, newest first, cards in note order. */
export function laneSections(cards: InboxCard[], lane: InboxLane): Array<{ heading: string; cards: InboxCard[] }> {
  const sections = new Map<string, InboxCard[]>();
  for (const card of cards) {
    if (card.lane !== lane) continue;
    const group = sections.get(card.heading);
    if (group) group.push(card);
    else sections.set(card.heading, [card]);
  }
  return [...sections.entries()].map(([heading, grouped]) => ({ heading, cards: grouped })).reverse();
}

/** Counts for the lane headers. */
export function laneCounts(cards: InboxCard[]): Record<InboxLane, number> {
  return cards.reduce(
    (counts, card) => {
      counts[card.lane] += 1;
      return counts;
    },
    { inbox: 0, todo: 0, done: 0 } as Record<InboxLane, number>,
  );
}

function markerFor(lane: InboxLane): string {
  return lane === 'todo' ? '[ ] ' : lane === 'done' ? '[x] ' : '';
}

function firstLineFor(card: InboxCard, lane: InboxLane, text: string): string {
  return `- ${markerFor(lane)}${card.time ? `${card.time} — ` : ''}${text}`;
}

/** Rewrite just the affected block; everything else keeps its exact bytes. */
function replaceBlock(markdown: string, card: InboxCard, block: string[]): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  lines.splice(card.start, card.end - card.start + 1, ...block);
  return lines.join('\n');
}

/** Move a card to another lane (the checkbox marker), keeping its text. */
export function setCardLane(markdown: string, card: InboxCard, lane: InboxLane): string {
  if (card.lane === lane) return markdown;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const continuation = lines.slice(card.start + 1, card.end + 1);
  lines.splice(card.start, card.end - card.start + 1, firstLineFor(card, lane, card.text.split('\n')[0]), ...continuation);
  return lines.join('\n');
}

/** Replace a card's text (multi-line allowed), preserving its lane and time. */
export function setCardText(markdown: string, card: InboxCard, text: string): string {
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) return markdown;
  const [first, ...rest] = body.split('\n');
  const continuation = rest.map((line) => (line.trim() === '' ? '' : `  ${line.trimEnd()}`));
  return replaceBlock(markdown, card, [firstLineFor(card, card.lane, first), ...continuation]);
}

/** Remove a card and nothing else. */
export function removeCard(markdown: string, card: InboxCard): string {
  return replaceBlock(markdown, card, []);
}

/**
 * Move a card to `lane`, inserting it before line `insertAt` of the current
 * document (or at the end when null). Used by drag-and-drop: the UI decides the
 * insertion line from the drop position, this rewrites the note to match.
 */
export function moveCard(markdown: string, card: InboxCard, lane: InboxLane, insertAt: number | null): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const block = lines.slice(card.start, card.end + 1);
  block[0] = firstLineFor(card, lane, card.text.split('\n')[0]);
  const removed = card.end - card.start + 1;
  lines.splice(card.start, removed);
  let target = insertAt ?? lines.length;
  if (insertAt !== null && insertAt > card.end) target = insertAt - removed;
  if (insertAt !== null && insertAt >= card.start && insertAt <= card.end) target = card.start;
  target = Math.max(0, Math.min(target, lines.length));
  lines.splice(target, 0, ...block);
  return lines.join('\n');
}

/** Insertion line at the end of the card's own day group (before the next heading). */
export function endOfDayGroup(markdown: string, cards: InboxCard[], card: InboxCard): number {
  const sameDay = cards.filter((entry) => entry.heading === card.heading).map((entry) => entry.end);
  const last = Math.max(card.end, ...sameDay);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = last + 1;
  while (index < lines.length && !lines[index].startsWith('## ') && lines[index].trim() === '') index += 1;
  return lines[index]?.startsWith('## ') ? index : Math.min(index, lines.length);
}
