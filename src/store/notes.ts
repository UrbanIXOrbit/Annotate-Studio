import { create } from 'zustand';
import { readExternalFileBytes, readNote, writeExternalFileBytes, writeTextFile } from '@/lib/tauri-commands';
import { registerFlusher } from '@/lib/persist';
import { isExternalPath } from '@/lib/utils';
import { useLibrary } from './library';

export interface NoteBuffer {
  content: string;
  status: 'loading' | 'ready' | 'error';
  dirty: boolean;
  saving: boolean;
  error: string | null;
  savedAt: number | null;
  editable: boolean;
  lineEnding: '\n' | '\r\n';
  /** Normalized content last seen on disk, used to detect external edits. */
  diskContent: string | null;
  /** Disk changed since load/save while this buffer has unsaved edits. */
  conflict: boolean;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Read a note kept outside the workspace through the external file commands,
 * mirroring what `read_note` does for workspace files (BOM strip, binary check). */
function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  const control = sample.reduce(
    (count, byte) => count + (byte < 0x20 && ![10, 13, 9, 12, 27].includes(byte) ? 1 : 0),
    0,
  );
  return control * 20 > sample.length;
}

async function readExternalNote(path: string): Promise<{ content: string; editable: boolean }> {
  const bytes = await readExternalFileBytes(path);
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  // Match the Rust read_note checks: strict UTF-8 plus a control-character
  // heuristic. A lossy decode of Latin-1 bytes would be saved back corrupted.
  let editable = !looksBinary(body);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    editable = false;
    text = new TextDecoder('utf-8').decode(body);
  }
  return { content: text, editable };
}

interface NotesStore {
  buffers: Record<string, NoteBuffer>;
  load: (path: string, fallback?: string) => Promise<void>;
  edit: (path: string, content: string) => void;
  save: (path: string) => Promise<void>;
  move: (oldPath: string, newPath: string) => void;
  drop: (path: string) => void;
  reset: (path: string, content: string) => void;
  resolveConflict: (path: string, choice: 'keep' | 'disk') => Promise<void>;
  retrySave: (path: string) => Promise<void>;
}

const SAVE_DELAY = 700;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();

function clearRetryTimer(path: string): void {
  const timer = retryTimers.get(path);
  if (timer) clearTimeout(timer);
  retryTimers.delete(path);
}

function clearRetry(path: string): void {
  clearRetryTimer(path);
  retryAttempts.delete(path);
}

export const useNotes = create<NotesStore>((set, get) => {
  const patch = (path: string, change: Partial<NoteBuffer>) =>
    set((state) => {
      const current = state.buffers[path];
      if (!current) return state;
      return { buffers: { ...state.buffers, [path]: { ...current, ...change } } };
    });

  return {
    buffers: {},
    load: async (path, fallback) => {
      const existing = get().buffers[path];
      if (existing && existing.status !== 'error') return;
      set((state) => ({
        buffers: {
          ...state.buffers,
          [path]: {
            content: '',
            status: 'loading',
            dirty: false,
            saving: false,
            error: null,
            savedAt: null,
            editable: true,
            lineEnding: '\n',
            diskContent: null,
            conflict: false,
          },
        },
      }));
      try {
        const note = isExternalPath(path) ? await readExternalNote(path) : await readNote(path);
        const current = get().buffers[path];
        if (!current || current.dirty || current.status !== 'loading') return;
        patch(path, {
          content: normalizeNewlines(note.content),
          lineEnding: note.content.includes('\r\n') ? '\r\n' : '\n',
          editable: note.editable,
          status: 'ready',
          error: null,
          diskContent: normalizeNewlines(note.content),
          conflict: false,
        });
      } catch (error) {
        if (fallback !== undefined) {
          patch(path, {
            content: normalizeNewlines(fallback),
            status: 'ready',
            dirty: true,
            error: null,
            diskContent: null,
            conflict: false,
          });
          get().save(path).catch(() => {});
          return;
        }
        patch(path, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    },
    edit: (path, content) => {
      const current = get().buffers[path];
      if (!current || !current.editable || current.content === content) return;
      patch(path, { content, dirty: true, status: 'ready' });
      const timer = timers.get(path);
      if (timer) clearTimeout(timer);
      timers.set(path, setTimeout(() => void get().save(path), SAVE_DELAY));
    },
    save: async (path) => {
      clearRetryTimer(path);
      const timer = timers.get(path);
      if (timer) clearTimeout(timer);
      timers.delete(path);
      const previous = inflight.get(path);
      if (previous) await previous.catch(() => {});
      const buffer = get().buffers[path];
      if (!buffer || !buffer.dirty || !buffer.editable || buffer.conflict) return;
      const content = buffer.content;
      // Detect a sync client or external editor changing the file underneath
      // us. A blind write here would silently destroy those changes.
      if (buffer.diskContent !== null) {
        try {
          const disk = isExternalPath(path) ? await readExternalNote(path) : await readNote(path);
          if (normalizeNewlines(disk.content) !== buffer.diskContent) {
            patch(path, {
              saving: false,
              conflict: true,
              error: 'This note changed on disk while it was open.',
            });
            return;
          }
        } catch {
          // A transient read failure must not cause a blind overwrite either.
          patch(path, { saving: false, error: 'Could not check the note on disk before saving.' });
          return;
        }
      }
      patch(path, { saving: true });
      const payload = buffer.lineEnding === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
      const job = (isExternalPath(path)
        // External notes are written back in place, byte for byte, at their own path.
        ? writeExternalFileBytes(path, new TextEncoder().encode(payload)).then(() => undefined)
        : writeTextFile(path, payload)
      )
        .then((file) => {
          const latest = get().buffers[path];
          patch(path, {
            saving: false,
            dirty: latest ? latest.content !== content : false,
            savedAt: Date.now(),
            error: null,
            diskContent: content,
            conflict: false,
          });
          clearRetry(path);
          if (file) useLibrary.getState().upsert(file);
          // The link index (backlinks/graph) re-reads just this file. Dynamic
          // import keeps the notes → graph edge cycle-safe.
          void import('./graph')
            .then((graph) => graph.refreshPath(path))
            .catch(() => undefined);
        })
        .catch((error: unknown) => {
          patch(path, { saving: false, error: error instanceof Error ? error.message : String(error) });
          const attempt = retryAttempts.get(path) ?? 0;
          if (attempt < 3) {
            retryAttempts.set(path, attempt + 1);
            retryTimers.set(
              path,
              setTimeout(() => {
                retryTimers.delete(path);
                void get().save(path).catch(() => undefined);
              }, 2000 * (attempt + 1)),
            );
          }
          throw error;
        })
        .finally(() => inflight.delete(path));
      inflight.set(path, job);
      await job;
    },
    move: (oldPath, newPath) => {
      if (oldPath === newPath) return;
      clearRetry(oldPath);
      const timer = timers.get(oldPath);
      if (timer) {
        clearTimeout(timer);
        timers.delete(oldPath);
      }
      set((state) => {
        const buffer = state.buffers[oldPath];
        if (!buffer) return state;
        const next = { ...state.buffers };
        delete next[oldPath];
        next[newPath] = buffer;
        return { buffers: next };
      });
      if (get().buffers[newPath]?.dirty) {
        timers.set(newPath, setTimeout(() => void get().save(newPath), SAVE_DELAY));
      }
      // The link index is path-keyed: forget the old path, index the new one.
      void import('./graph')
        .then((graph) => {
          graph.forgetPath(oldPath);
          graph.refreshPath(newPath);
        })
        .catch(() => undefined);
    },
    reset: (path, content) => {
      const current = get().buffers[path];
      if (!current || current.dirty) return;
      patch(path, { content: normalizeNewlines(content), status: 'ready', error: null, diskContent: normalizeNewlines(content), conflict: false });
    },
    retrySave: async (path) => {
      clearRetry(path);
      await get().save(path);
    },

    resolveConflict: async (path, choice) => {
      const buffer = get().buffers[path];
      if (!buffer || !buffer.conflict) return;
      if (choice === 'disk') {
        try {
          const disk = isExternalPath(path) ? await readExternalNote(path) : await readNote(path);
          const content = normalizeNewlines(disk.content);
          patch(path, {
            content,
            dirty: false,
            saving: false,
            conflict: false,
            error: null,
            diskContent: content,
            lineEnding: disk.content.includes('\r\n') ? '\r\n' : '\n',
            editable: disk.editable,
          });
        } catch (error) {
          patch(path, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // Keep the editor version: adopt the current disk state as the baseline
      // in ONE read. If that read fails, stay in conflict — save() would read
      // again and could either re-raise the conflict or clobber unknown bytes.
      let diskContent: string;
      try {
        const disk = isExternalPath(path) ? await readExternalNote(path) : await readNote(path);
        diskContent = normalizeNewlines(disk.content);
      } catch (error) {
        patch(path, { error: `Could not read the note on disk: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      patch(path, { conflict: false, error: null, diskContent });
      await get().save(path);
    },

    drop: (path) => {
      clearRetry(path);
      const timer = timers.get(path);
      if (timer) clearTimeout(timer);
      timers.delete(path);
      set((state) => {
        if (!state.buffers[path]) return state;
        const next = { ...state.buffers };
        delete next[path];
        return { buffers: next };
      });
    },
  };
});

registerFlusher(async () => {
  const { buffers, save } = useNotes.getState();
  await Promise.allSettled(
    Object.entries(buffers)
      .filter(([, buffer]) => buffer.dirty)
      .map(([path]) => save(path)),
  );
});
