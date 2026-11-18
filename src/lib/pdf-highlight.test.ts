import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGHLIGHT_OPACITY, highlightTint } from './pdf-highlight.ts';

test('highlightTint keeps already light colours and lightens dark ones', () => {
  assert.equal(highlightTint('#FFCD45'), '#FFCD45');
  assert.equal(highlightTint('#A7F3D0'), '#A7F3D0');
  assert.equal(highlightTint('#1F2937'), '#9A9FA5');
  assert.equal(highlightTint('#FFFFFF'), '#FFCD45');
  assert.equal(highlightTint('not-a-color'), '#FFCD45');
});

test('highlight opacity stays translucent', () => {
  assert.ok(HIGHLIGHT_OPACITY > 0 && HIGHLIGHT_OPACITY < 0.5);
});
