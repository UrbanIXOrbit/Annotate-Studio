/**
 * Scratch/inbox capture — the pure text layer. A capture is appended to an
 * ordinary markdown note under a day heading, so the inbox is just a note with
 * backlinks, tags and search like any other. Pure — no store imports.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `## Fri 14 Nov 2026` — the per-day group heading inside a capture note. */
export function dayHeading(at: Date): string {
  return `## ${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/** `14:32` — the capture's time, in the user's local clock. */
export function captureTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * One capture as a list item. The first line follows the time stamp; any
 * following lines are indented so markdown keeps them inside the same bullet
 * (and so pasted lists do not split the capture into separate entries).
 */
export function captureEntry(text: string, at: Date): string {
  const [first, ...rest] = text.replace(/\r\n?/g, '\n').trim().split('\n');
  const continuation = rest.map((line) =>
    line.trim() === '' ? '' : line.startsWith('  ') || line.startsWith('\t') ? line : `  ${line.trimEnd()}`,
  );
  return `- ${captureTime(at)} — ${first.trimEnd()}${continuation.length > 0 ? `\n${continuation.join('\n')}` : ''}`;
}

/** The last `## ` heading in a note, or null when it has none. */
function lastHeading(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith('## ')) return line.trim();
  }
  return null;
}

/**
 * Append a capture to an existing note (or an empty string for a new one).
 * The day heading is reused when today's is already the last group, otherwise
 * a new heading is added. Existing content is preserved byte-for-byte apart
 * from trailing blank lines, and the result ends with exactly one newline.
 */
export function appendCapture(existing: string, text: string, at: Date = new Date()): string {
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) return existing;
  const heading = dayHeading(at);
  const entry = captureEntry(body, at);
  const base = existing.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!base) return `${heading}\n${entry}\n`;
  const lines = base.split('\n');
  if (lastHeading(lines) === heading) return `${base}\n${entry}\n`;
  return `${base}\n\n${heading}\n${entry}\n`;
}

/** A note title safe for a file name (the app adds the `.md` extension). */
export function captureNoteName(raw: string): string {
  const cleaned = raw
    .replace(/\.(md|markdown)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || 'Capture';
}
