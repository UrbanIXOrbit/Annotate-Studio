import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameFingerprint, readFingerprint, changedSince } from './file-conflict.ts';
import type { FileFingerprint } from './tauri-commands.ts';

const fp = (over: Partial<FileFingerprint> = {}): FileFingerprint => ({
  size: 100,
  modifiedAt: '1700000000000',
  hash: 'abc123',
  ...over,
});

test('fingerprints match only when size, mtime and hash all match', () => {
  assert.equal(sameFingerprint(fp(), fp()), true);
  assert.equal(sameFingerprint(fp(), fp({ hash: 'different' })), false);
  assert.equal(sameFingerprint(fp(), fp({ size: 101 })), false);
  assert.equal(sameFingerprint(fp(), fp({ modifiedAt: '1700000000001' })), false);
});

test('a missing fingerprint is never a match', () => {
  assert.equal(sameFingerprint(null, null), false);
  assert.equal(sameFingerprint(fp(), null), false);
  assert.equal(sameFingerprint(null, fp()), false);
});

test('an unreadable file is reported as changed (safe default: block the write)', async () => {
  // Outside Tauri, fileFingerprint throws; readFingerprint swallows it and
  // changedSince treats the missing fingerprint as a conflict.
  assert.equal(await readFingerprint('/definitely/not/a/file.pdf'), null);
  assert.equal(await changedSince('/definitely/not/a/file.pdf', fp()), true);
});
