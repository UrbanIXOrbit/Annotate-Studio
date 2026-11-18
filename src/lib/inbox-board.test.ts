import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardKey,
  endOfDayGroup,
  findCard,
  laneCounts,
  laneSections,
  moveCard,
  parseInbox,
  removeCard,
  setCardLane,
  setCardText,
} from './inbox-board.ts';

const NOTE = `# Inbox

## Fri 14 Nov 2026
- 09:05 — first idea
- [ ] 16:32 — read Friston 2010
  second line
- [x] 18:00 — email Ana

## Sat 15 Nov 2026
- 08:00 — next day thought
`;

test('parseInbox reads lanes, times, headings and continuation lines', () => {
  const cards = parseInbox(NOTE);
  assert.equal(cards.length, 4);
  assert.deepEqual(
    cards.map((card) => [card.lane, card.time, card.heading]),
    [
      ['inbox', '09:05', '## Fri 14 Nov 2026'],
      ['todo', '16:32', '## Fri 14 Nov 2026'],
      ['done', '18:00', '## Fri 14 Nov 2026'],
      ['inbox', '08:00', '## Sat 15 Nov 2026'],
    ],
  );
  assert.equal(cards[1].text, 'read Friston 2010\nsecond line');
  assert.equal(cards[3].text, 'next day thought');
  assert.deepEqual(laneCounts(cards), { inbox: 2, todo: 1, done: 1 });
});

test('parseInbox ignores prose, nested bullets and unknown lines', () => {
  const cards = parseInbox(`# Inbox

Some prose.

- plain card
  - nested bullet stays with the card
### Subheading
- [ ] todo card
`);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].text, 'plain card\n- nested bullet stays with the card');
  assert.equal(cards[1].lane, 'todo');
  assert.equal(cards[1].heading, '');
});

test('laneSections groups by day newest first and keeps note order', () => {
  const cards = parseInbox(NOTE);
  const inbox = laneSections(cards, 'inbox');
  assert.deepEqual(
    inbox.map((section) => [section.heading, section.cards.map((card) => card.text)]),
    [
      ['## Sat 15 Nov 2026', ['next day thought']],
      ['## Fri 14 Nov 2026', ['first idea']],
    ],
  );
});

test('setCardLane rewrites only the checkbox marker', () => {
  const cards = parseInbox(NOTE);
  const todo = setCardLane(NOTE, cards[0], 'todo');
  assert.ok(todo.includes('- [ ] 09:05 — first idea'));
  assert.equal(parseInbox(todo)[0].lane, 'todo');

  const done = setCardLane(NOTE, cards[1], 'done');
  assert.ok(done.includes('- [x] 16:32 — read Friston 2010'));

  const back = setCardLane(NOTE, cards[2], 'inbox');
  assert.ok(back.includes('- 18:00 — email Ana'));

  // Every other line survives exactly.
  const before = NOTE.split('\n').filter((line) => !line.includes('first idea'));
  const after = todo.split('\n').filter((line) => !line.includes('first idea'));
  assert.deepEqual(after, before);
});

test('setCardText keeps lane and time, and re-indents continuation lines', () => {
  const cards = parseInbox(NOTE);
  const edited = setCardText(NOTE, cards[1], 'Read Friston\npages 5–9');
  assert.ok(edited.includes('- [ ] 16:32 — Read Friston\n  pages 5–9'));
  assert.equal(parseInbox(edited)[1].text, 'Read Friston\npages 5–9');
  assert.equal(parseInbox(edited)[1].lane, 'todo');

  // Untimed cards exist too (manually written capture notes).
  const untimed = parseInbox('## Day\n- no time here');
  assert.equal(untimed[0].time, null);
  assert.equal(setCardText('## Day\n- no time here', untimed[0], 'renamed'), '## Day\n- renamed');
});

test('removeCard deletes only that card', () => {
  const cards = parseInbox(NOTE);
  const trimmed = removeCard(NOTE, cards[1]);
  assert.equal(parseInbox(trimmed).length, 3);
  assert.ok(!trimmed.includes('read Friston'));
  assert.ok(trimmed.includes('- 09:05 — first idea'));
  assert.ok(trimmed.includes('- [x] 18:00 — email Ana'));
});

test('moveCard reorders within a lane and changes lane in one pass', () => {
  const cards = parseInbox(NOTE);
  // Move the todo card to Done, before the existing done card.
  const moved = moveCard(NOTE, cards[1], 'done', cards[2].start);
  const after = parseInbox(moved);
  const done = after.filter((card) => card.lane === 'done').map((card) => card.text);
  assert.deepEqual(done, ['read Friston 2010\nsecond line', 'email Ana']);
  assert.equal(after.length, 4);

  // Move the last card to Inbox at the end of the document.
  const cards2 = parseInbox(moved);
  const last = cards2[cards2.length - 1];
  const atEnd = moveCard(moved, last, 'inbox', null);
  const tail = parseInbox(atEnd).map((card) => card.text.split('\n')[0]);
  assert.equal(tail[tail.length - 1], 'next day thought');
});

test('endOfDayGroup points before the next heading', () => {
  const cards = parseInbox(NOTE);
  const lines = NOTE.split('\n');
  const index = endOfDayGroup(NOTE, cards, cards[0]);
  assert.equal(lines[index], '## Sat 15 Nov 2026');
});

test('endOfDayGroup keeps the trailing newline of the last day group', () => {
  const text = '## Day\n- a\n';
  const cards = parseInbox(text);
  const at = endOfDayGroup(text, cards, cards[0]);
  assert.equal(at, 2);
  assert.equal(moveCard(text, cards[0], 'done', at), '## Day\n- [x] a\n');

  const padded = '## Day\n- a\n\n\n';
  const paddedCards = parseInbox(padded);
  assert.equal(
    moveCard(padded, paddedCards[0], 'done', endOfDayGroup(padded, paddedCards, paddedCards[0])),
    '## Day\n- [x] a\n\n\n',
  );
});

test('cardKey finds the same card after unrelated lines are inserted', () => {
  const text = '# Inbox\n\n## Day\n- 09:05 — idea\n  more\n';
  const card = parseInbox(text)[0];
  const key = cardKey(card);
  const shifted = text.replace('## Day', 'an intro line\n\n## Day');
  const found = findCard(parseInbox(shifted), key);
  assert.ok(found);
  assert.equal(found.text, 'idea\nmore');
  assert.equal(found.start, card.start + 2);
  assert.equal(findCard(parseInbox('## Day\n- 09:05 — other\n'), key), undefined);
});

test('parseInbox ignores unrelated lists once the note has day groups', () => {
  const text = `# Inbox

## Projects
- [ ] unrelated task

## Sat 14 Nov 2026
- 09:05 — real card
`;
  const cards = parseInbox(text);
  assert.deepEqual(
    cards.map((card) => [card.text, card.heading]),
    [['real card', '## Sat 14 Nov 2026']],
  );
  assert.deepEqual(laneCounts(cards), { inbox: 1, todo: 0, done: 0 });
});
