import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from './persist.ts';

test('createSaver debounces a burst into a single write', async () => {
  const writes: number[] = [];
  const saver = createSaver<number>(async (value) => void writes.push(value), 20, undefined, 200);
  saver.schedule(1);
  saver.schedule(2);
  saver.schedule(3);
  await new Promise((resolve) => setTimeout(resolve, 70));
  await saver.flush();
  assert.deepEqual(writes, [3]);
});

test('createSaver writes during continuous activity instead of waiting forever', async () => {
  const writes: number[] = [];
  const saver = createSaver<number>(async (value) => void writes.push(value), 20, undefined, 60);
  const interval = setInterval(() => saver.schedule(Date.now()), 5);
  await new Promise((resolve) => setTimeout(resolve, 150));
  clearInterval(interval);
  await saver.flush();
  assert.ok(writes.length >= 1, 'expected at least one write despite continuous scheduling');
});
