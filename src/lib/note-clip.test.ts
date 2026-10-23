import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendClip, bookLabel, clipKindFor, defaultNewNoteName, formatClip, isNoteFile, noteLabel, orderNotes, type NoteLike } from './note-clip.ts';

const source = { text: 'Social planning is a deliberate process.', title: 'Social Planning.pdf', page: 12 };

test('markdown clips are a block quote with the source on the last line', () => {
  assert.equal(formatClip(source, 'markdown'), '> Social planning is a deliberate process.\n>\n> \u2014 *Social Planning*, p. 12');
});

test('plain-text clips use quotation marks and no markdown symbols', () => {
  assert.equal(formatClip(source, 'text'), '\u201CSocial planning is a deliberate process.\u201D\n\u2014 Social Planning, p. 12');
});

test('markdown characters in the passage cannot change the note\'s formatting', () => {
  const clip = formatClip({ text: '# Heading *bold* and _under_ [link](x)\n1. item', title: 'A_B.pdf', page: 3 }, 'markdown');
  assert.ok(clip.includes('> \\# Heading \\*bold\\* and \\_under\\_ \\[link\\](x)'));
  assert.ok(clip.includes('> 1\\. item'));
  assert.ok(clip.includes('*A\\_B*'));
  assert.ok(clip.split('\n').every((line) => line.startsWith('>')), 'every line stays inside the quote');
});

test('multi-paragraph passages keep the quote unbroken', () => {
  const clip = formatClip({ text: 'First paragraph.\n\nSecond paragraph.', title: 'X.pdf', page: 1 }, 'markdown');
  assert.equal(clip, '> First paragraph.\n>\n> Second paragraph.\n>\n> \u2014 *X*, p. 1');
});

test('appending separates the clip with exactly one blank line', () => {
  const clip = '> quote';
  assert.equal(appendClip('# Notes', clip), '# Notes\n\n> quote\n');
  assert.equal(appendClip('# Notes\n', clip), '# Notes\n\n> quote\n');
  assert.equal(appendClip('# Notes\n\n', clip), '# Notes\n\n> quote\n');
  assert.equal(appendClip('# Notes\n\n\n\n', clip), '# Notes\n\n\n\n> quote\n', 'existing blank lines are never removed');
});

test('appending never alters what is already in the note', () => {
  const existing = '# Title\n\n  indented line  \n- item\n';
  assert.ok(appendClip(existing, '> q').startsWith(existing));
  assert.equal(appendClip('', '> q'), '> q\n');
  assert.equal(appendClip('  \n\n', '> q'), '> q\n');
});

test('a second clip stacks neatly under the first', () => {
  const once = appendClip('# Notes', '> one');
  assert.equal(appendClip(once, '> two'), '# Notes\n\n> one\n\n> two\n');
});

test('note kinds and labels', () => {
  assert.equal(isNoteFile({ file_type: 'Markdown' }), true);
  assert.equal(isNoteFile({ file_type: 'Text' }), true);
  assert.equal(isNoteFile({ file_type: 'Pdf' }), false);
  assert.equal(isNoteFile({ file_type: 'Image' }), false);
  assert.equal(clipKindFor({ file_type: 'Markdown', name: 'a.md' }), 'markdown');
  assert.equal(clipKindFor({ file_type: 'Text', name: 'a.txt' }), 'text');
  assert.equal(clipKindFor({ file_type: 'Text', name: 'a.markdown' }), 'markdown');
  assert.equal(noteLabel('Lecture 3.md'), 'Lecture 3');
  assert.equal(noteLabel('todo.txt'), 'todo');
  assert.equal(bookLabel('Big Book.pdf'), 'Big Book');
  assert.equal(defaultNewNoteName('Big Book.pdf'), 'Notes on Big Book');
});

const file = (name: string, modified: string, type = 'Markdown'): NoteLike => ({ path: `notes/${name}`, name, file_type: type, modified_at: modified });
const FILES = [
  file('Old.md', '2026-01-01T00:00:00Z'),
  file('Newest.md', '2026-10-01T00:00:00Z'),
  file('Middle.md', '2026-05-01T00:00:00Z'),
  file('Todo.txt', '2026-07-01T00:00:00Z', 'Text'),
  { path: 'Book.pdf', name: 'Book.pdf', file_type: 'Pdf', modified_at: '2026-12-01T00:00:00Z' },
];

test('the picker lists only notes, newest first', () => {
  assert.deepEqual(orderNotes(FILES).map((f) => f.name), ['Newest.md', 'Todo.txt', 'Middle.md', 'Old.md']);
});

test('last used comes first, then open notes, then the rest', () => {
  const open = new Set(['notes/Old.md']);
  assert.deepEqual(orderNotes(FILES, { lastPath: 'notes/Middle.md', openPaths: open }).map((f) => f.name), ['Middle.md', 'Old.md', 'Newest.md', 'Todo.txt']);
  assert.deepEqual(orderNotes(FILES, { openPaths: open }).map((f) => f.name)[0], 'Old.md');
  assert.deepEqual(orderNotes(FILES, { lastPath: 'notes/Missing.md' }).map((f) => f.name)[0], 'Newest.md');
});

test('searching filters by name, ignoring case and extension', () => {
  assert.deepEqual(orderNotes(FILES, { query: 'MID' }).map((f) => f.name), ['Middle.md']);
  assert.deepEqual(orderNotes(FILES, { query: 'todo' }).map((f) => f.name), ['Todo.txt']);
  assert.deepEqual(orderNotes(FILES, { query: '.md' }).map((f) => f.name), [], 'the extension is not part of the name');
  assert.deepEqual(orderNotes(FILES, { query: '  ' }).length, 4);
  assert.deepEqual(orderNotes(FILES, { query: 'zzz' }), []);
});

test('equal dates fall back to a natural name order', () => {
  const same = [file('Note 10.md', '2026-01-01T00:00:00Z'), file('Note 2.md', '2026-01-01T00:00:00Z'), file('Note 1.md', 'not a date')];
  assert.deepEqual(orderNotes(same).map((f) => f.name), ['Note 2.md', 'Note 10.md', 'Note 1.md']);
});
