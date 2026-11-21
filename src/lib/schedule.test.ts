import { test } from 'node:test';
import assert from 'node:assert/strict';
// The preview calculator lives in a component folder but is pure (its only
// import is type-only, erased at runtime), so it can be tested directly.
import { formatInterval, nextIntervalDays } from '../components/study/flashcards/schedule.ts';

const card = (over: Record<string, number> = {}) =>
  ({ interval_days: 0, repetitions: 0, ease_factor: 2.5, ...over }) as never;

test('nextIntervalDays mirrors the Rust spacing rules', () => {
  assert.equal(nextIntervalDays(card(), 'Again'), 0);
  assert.equal(nextIntervalDays(card(), 'Hard'), 1);
  assert.equal(nextIntervalDays(card(), 'Good'), 1);
  assert.equal(nextIntervalDays(card(), 'Easy'), 4);
  assert.equal(nextIntervalDays(card({ interval_days: 1, repetitions: 1 }), 'Good'), 6);
  assert.equal(nextIntervalDays(card({ interval_days: 2, repetitions: 1 }), 'Easy'), 8);
  assert.equal(nextIntervalDays(card({ interval_days: 40000, repetitions: 5 }), 'Good'), 36500);
  assert.equal(nextIntervalDays(card({ interval_days: Number.MAX_SAFE_INTEGER, repetitions: 5 }), 'Hard'), 36500);
});

test('interval labels are readable', () => {
  assert.equal(formatInterval(0), '10m');
  assert.equal(formatInterval(6), '6d');
  assert.equal(formatInterval(60), '2mo');
  assert.equal(formatInterval(365), '1.0y');
});
