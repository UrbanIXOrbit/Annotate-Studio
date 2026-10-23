import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTitle, estimateCardSize, normalizeQuote, planCardPosition, CARD_MAX_HEIGHT, CARD_MIN_HEIGHT, type PlacementItem } from './cards.ts';

test('normalizeQuote joins hard-wrapped lines and split words', () => {
  assert.equal(normalizeQuote('Social work is a prac-\ntice-based profession\nthat promotes change.'), 'Social work is a practice-based profession that promotes change.');
  assert.equal(normalizeQuote('First paragraph\nstill first.\n\nSecond paragraph.'), 'First paragraph still first.\n\nSecond paragraph.');
  assert.equal(normalizeQuote('  \n\n  '), '');
  // A hyphen before a capital letter is kept (e.g. a proper noun or list marker).
  assert.equal(normalizeQuote('Anglo-\nSaxon'), 'Anglo- Saxon');
});

test('cardTitle strips the extension and adds the page', () => {
  assert.equal(cardTitle('Intro to Policy.pdf', 12), 'Intro to Policy · p. 12');
});

test('card size grows with text but stays within bounds', () => {
  const short = estimateCardSize('Hi');
  const long = estimateCardSize('word '.repeat(2000));
  assert.ok(short.height >= CARD_MIN_HEIGHT);
  assert.equal(long.height, CARD_MAX_HEIGHT);
  assert.ok(estimateCardSize('x'.repeat(300)).height > short.height);
});

const pdf: PlacementItem = { id: 'pdf', type: 'pdf', x: 0, y: 100, width: 800, height: 900, minimized: false };
const size = { width: 320, height: 200 };
const card = (id: string, y: number, extra: Partial<PlacementItem> = {}): PlacementItem => ({
  id,
  type: 'card',
  x: 848,
  y,
  width: 320,
  height: 200,
  minimized: false,
  source: { filePath: 'a.pdf' },
  ...extra,
});

test('the first card lands beside the source PDF, aligned to its top', () => {
  assert.deepEqual(planCardPosition([pdf], { anchor: pdf, filePath: 'a.pdf', size, fallbackCenter: { x: 0, y: 0 } }), { x: 848, y: 100 });
});

test('later cards stack in the same column without overlapping', () => {
  const items = [pdf, card('c1', 100), card('c2', 340)];
  const next = planCardPosition(items, { anchor: pdf, filePath: 'a.pdf', size, fallbackCenter: { x: 0, y: 0 } });
  assert.equal(next.x, 848);
  assert.equal(next.y, 580); // below c2 (340 + 200) plus the 40px gap
});

test('cards from a different PDF do not extend this column, but obstacles are avoided', () => {
  const other = card('o1', 100, { source: { filePath: 'b.pdf' } });
  const next = planCardPosition([pdf, other], { anchor: pdf, filePath: 'a.pdf', size, fallbackCenter: { x: 0, y: 0 } });
  assert.equal(next.x, 848);
  assert.equal(next.y, 340); // pushed below the other PDF's card, plus the gap
});

test('minimized windows are ignored and a missing anchor falls back to the view centre', () => {
  const hidden = card('h', 100, { minimized: true });
  assert.deepEqual(planCardPosition([hidden], { size, fallbackCenter: { x: 1000, y: 500 } }), { x: 840, y: 400 });
});
