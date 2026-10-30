import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveBooksState,
  saveCanvasState,
  saveChatSessions,
  saveCollections,
  saveExams,
  saveSettings,
} from './tauri-commands.ts';

/**
 * The Tauri commands write to disk using the argument names of their Rust
 * signatures (camelCase in the invoke payload, snake_case in Rust, matched by
 * Tauri's automatic case conversion). A wrong key makes the command fail on
 * the Rust side — and the app's savers swallow that error, so the data is
 * silently never stored. These tests pin the invoke keys to the Rust
 * parameter names, in data.rs and commands/books.rs.
 */

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

async function withInvokeStub(run: (calls: InvokeCall[]) => Promise<void>): Promise<void> {
  const calls: InvokeCall[] = [];
  const global = globalThis as { window?: unknown };
  const previous = global.window;
  global.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        return Promise.resolve(null);
      },
    },
  };
  try {
    await run(calls);
  } finally {
    global.window = previous;
  }
}

type AnySaver = (payload: unknown) => Promise<unknown>;

const cases: Array<{
  name: string;
  act: AnySaver;
  command: string;
  /** The Rust command's data argument name (camelCase key in the payload). */
  argKey: string;
  payload: unknown;
}> = [
  {
    name: 'save_canvas_state',
    act: saveCanvasState as unknown as AnySaver,
    command: 'save_canvas_state',
    argKey: 'canvas',
    payload: { version: 2 },
  },
  {
    name: 'save_settings',
    act: saveSettings as unknown as AnySaver,
    command: 'save_settings',
    argKey: 'settings',
    payload: { theme: 'white' },
  },
  {
    name: 'save_exams',
    act: saveExams as unknown as AnySaver,
    command: 'save_exams',
    argKey: 'exams',
    payload: [],
  },
  {
    name: 'save_collections',
    act: saveCollections as unknown as AnySaver,
    command: 'save_collections',
    argKey: 'collections',
    payload: [],
  },
  {
    name: 'save_chat_sessions',
    act: saveChatSessions as unknown as AnySaver,
    command: 'save_chat_sessions',
    argKey: 'sessions',
    payload: [],
  },
  {
    name: 'save_books_state',
    act: saveBooksState as unknown as AnySaver,
    command: 'save_books_state',
    argKey: 'booksState',
    payload: { projects: [], folders: {}, files: {} },
  },
];

for (const { act, ...rest } of cases) {
  const saver = act as AnySaver;
  const { name, command, argKey, payload } = rest;
  test(`${name} posts its payload under the key the Rust command expects (${argKey})`, async () => {
    await withInvokeStub(async (calls) => {
      await saver(payload);
      assert.equal(calls.length, 1, `expected exactly one ${command} call`);
      assert.equal(calls[0].command, command);
      assert.deepEqual(calls[0].args, { [argKey]: payload });
    });
  });
}
