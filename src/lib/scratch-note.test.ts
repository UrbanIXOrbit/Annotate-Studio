import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, captureEntry, captureNoteName, captureTime, dayHeading, withLineEndings } from './scratch-note.ts';

// Fixed local dates so the assertions hold in any timezone.
const morning = new Date(2026, 10, 14, 9, 5);
const later = new Date(2026, 10, 14, 16, 32);
const nextDay = new Date(2026, 10, 15, 8, 0);

test('dayHeading and captureTime are stable local strings', () => {
  assert.equal(dayHeading(morning), '## Sat 14 Nov 2026');
  assert.equal(captureTime(morning), '09:05');
  assert.equal(captureTime(later), '16:32');
});

test('a first capture creates the day heading and bullet', () => {
  assert.equal(
    appendCapture('', 'idea for the attention chapter', morning),
    '## Sat 14 Nov 2026\n- 09:05 — idea for the attention chapter\n',
  );
});

test('same-day captures reuse the heading; a new day gets a fresh group', () => {
  const first = appendCapture('# Inbox\n\n', 'first', morning);
  assert.equal(first, '# Inbox\n\n## Sat 14 Nov 2026\n- 09:05 — first\n');

  const second = appendCapture(first, 'second', later);
  assert.equal(second, '# Inbox\n\n## Sat 14 Nov 2026\n- 09:05 — first\n- 16:32 — second\n');

  const third = appendCapture(second, 'next day', nextDay);
  assert.equal(
    third,
    '# Inbox\n\n## Sat 14 Nov 2026\n- 09:05 — first\n- 16:32 — second\n\n## Sun 15 Nov 2026\n- 08:00 — next day\n',
  );
});

test('multi-line captures stay one bullet with indented continuation', () => {
  const entry = captureEntry('First line\nsecond line\n\n- a list item\n  already indented', morning);
  assert.equal(
    entry,
    '- 09:05 — First line\n  second line\n\n  - a list item\n  already indented',
  );

  const note = appendCapture('', 'First line\nsecond line', morning);
  assert.equal(note, '## Sat 14 Nov 2026\n- 09:05 — First line\n  second line\n');
});

test('existing content is preserved and trailing blank lines collapse', () => {
  const existing = '# Meeting\n\nNotes here.\n\n\n';
  const next = appendCapture(existing, 'follow up', morning);
  assert.ok(next.startsWith('# Meeting\n\nNotes here.\n\n## Sat 14 Nov 2026'));
  assert.ok(next.endsWith('- 09:05 — follow up\n'));
  assert.equal(appendCapture(existing, '   ', morning), existing);
  assert.equal(appendCapture(existing, 'a\r\nb', morning).includes('\r'), false);
});

test('captureNoteName strips extensions, illegal characters and extra spaces', () => {
  assert.equal(captureNoteName('  Reading log '), 'Reading log');
  assert.equal(captureNoteName('Ideas.md'), 'Ideas');
  assert.equal(captureNoteName('A/B: C?'), 'A-B- C-');
  assert.equal(captureNoteName('   '), 'Capture');
  assert.equal(captureNoteName('x'.repeat(90)).length, 60);
});

test('withLineEndings restores the note own endings without doubling them', () => {
  const lf = '## Day\n- a\n- [x] b\n';
  assert.equal(withLineEndings(lf, '\n'), lf);
  assert.equal(withLineEndings(lf, '\r\n'), '## Day\r\n- a\r\n- [x] b\r\n');
  assert.equal(withLineEndings(lf.replace(/\n/g, '\r\n'), '\n'), lf);
});
