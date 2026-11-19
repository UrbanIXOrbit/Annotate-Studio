/**
 * Capture facade for the scratch/inbox flow. The inbox is an ordinary
 * markdown note the user keeps on disk; captures are appended to it — never
 * copied into the workspace, and never written over unsaved editor text.
 */
import {
  createExternalNote,
  errorMessage,
  readExternalFileBytes,
  writeExternalFileBytes,
} from './tauri-commands';
import { appendCapture, captureNoteName, withLineEndings } from './scratch-note';
import { baseName, stripExtension } from './utils';
import { useApp } from '@/store/app';
import { useCanvas } from '@/store/canvas';
import { useInbox } from '@/store/inbox';
import { useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { useSettings, type CaptureNoteRef } from '@/store/settings';
import { useToasts } from '@/store/toast';
import { resolveNoteFolder } from './workspace-actions';

function joinPath(directory: string, name: string): string {
  const separator = /\\/.test(directory) && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function splitPath(path: string): { directory: string; name: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { directory: index > 0 ? path.slice(0, index) : '', name: index > 0 ? path.slice(index + 1) : path };
}

/** The inbox note's path, when the notes folder is already known. */
export function inboxNotePath(): string | null {
  const { inboxNotePath: configured, noteFolder } = useSettings.getState();
  if (configured) return configured;
  if (!noteFolder) return null;
  return joinPath(noteFolder, 'Inbox.md');
}

/** Resolve the inbox, asking for the notes folder once when none is set yet. */
export async function resolveInboxPath(): Promise<string | null> {
  const known = inboxNotePath();
  if (known) return known;
  const folder = await resolveNoteFolder();
  if (!folder) return null;
  const path = joinPath(folder, 'Inbox.md');
  useSettings.getState().update({ inboxNotePath: path });
  return path;
}

/** Read a note from disk; null when it does not exist yet. */
async function readNoteIfPresent(path: string): Promise<string | null> {
  try {
    return new TextDecoder('utf-8').decode(await readExternalFileBytes(path));
  } catch {
    return null;
  }
}

/**
 * Append one capture to a note. When the note is open on the canvas its live
 * buffer is extended (so unsaved edits are not clobbered) and saved through
 * the notes store; otherwise the file is read, appended and written in place.
 * Returns the path actually written — a brand-new note may land on a
 * deduplicated name.
 */
export async function captureToNote(path: string, text: string): Promise<string | null> {
  const body = text.trim();
  if (!body) return null;
  try {
    const at = new Date();

    // 1. Open note window: append to its buffer so nothing typed is lost.
    const notes = useNotes.getState();
    const buffer = notes.buffers[path];
    if (buffer && buffer.editable && buffer.status === 'ready') {
      notes.edit(path, appendCapture(buffer.content, body, at));
      await notes.save(path);
      return path;
    }

    // 2. Not open: append on disk.
    const existing = await readNoteIfPresent(path);
    if (existing !== null) {
      const crlf = existing.includes('\r\n');
      const next = appendCapture(crlf ? existing.replace(/\r\n/g, '\n') : existing, body, at);
      await writeExternalFileBytes(path, new TextEncoder().encode(crlf ? next.replace(/\n/g, '\r\n') : next));
      // The link index re-reads just this note, so new [[links]] resolve at once.
      void import('@/store/graph').then((graph) => graph.refreshPath(path)).catch(() => undefined);
      return path;
    }

    // 3. New note: create it beside where it was meant to live, then fill it.
    const { directory } = splitPath(path);
    if (!directory) return null;
    const title = stripExtension(baseName(path));
    const initial = `# ${title}\n\n${appendCapture('', body, at)}`;
    const file = await createExternalNote(directory, title, initial);
    if (file.path !== path) {
      const settings = useSettings.getState();
      if (settings.inboxNotePath === path) settings.update({ inboxNotePath: file.path });
      else if (settings.captureNotes.some((note) => note.path === path)) {
        settings.update({
          captureNotes: settings.captureNotes.map((note) => (note.path === path ? { ...note, path: file.path } : note)),
        });
      }
    }
    void useLibrary.getState().refresh();
    return file.path;
  } catch (error) {
    useToasts.getState().push({ kind: 'error', title: 'Could not capture the note', description: errorMessage(error) });
    return null;
  }
}

/** Create (and remember) a new named capture note in the notes folder. */
export async function createCaptureNote(rawName: string): Promise<CaptureNoteRef | null> {
  const folder = await resolveNoteFolder();
  if (!folder) return null;
  const name = captureNoteName(rawName);
  try {
    const file = await createExternalNote(folder, name, `# ${name}\n\n`);
    const settings = useSettings.getState();
    const existing = settings.captureNotes.find((note) => note.path === file.path);
    const ref: CaptureNoteRef = { name: stripExtension(file.name), path: file.path };
    if (!existing) settings.update({ captureNotes: [...settings.captureNotes, ref] });
    void useLibrary.getState().refresh();
    return existing ?? ref;
  } catch (error) {
    useToasts.getState().push({ kind: 'error', title: 'Could not create the note', description: errorMessage(error) });
    return null;
  }
}

/** The default Inbox note inside a notes folder. */
export function inboxPathFor(folder: string): string {
  return joinPath(folder, 'Inbox.md');
}

/**
 * Switch to the Inbox section, optionally on a specific note. No folder prompt:
 * the board itself offers to choose the notes folder when none is set yet.
 */
export function openInboxSection(path?: string): void {
  const target = path ?? inboxNotePath();
  if (target) useInbox.getState().select(target);
  useApp.getState().setView('inbox');
}

/**
 * Read a capture note for the board. Prefers the live editor buffer so
 * unsaved typing is never replaced by the older file contents.
 */
export async function readCaptureNote(path: string): Promise<string | null> {
  const buffer = useNotes.getState().buffers[path];
  if (buffer && buffer.status === 'ready' && buffer.editable) return buffer.content;
  return readNoteIfPresent(path);
}

/** Disk-only read, used to roll back a failed board write. */
export async function readCaptureFile(path: string): Promise<string | null> {
  return readNoteIfPresent(path);
}

/**
 * Write board edits back to the note. When the note is open, its buffer is
 * updated and saved through the notes store (preserving its line endings);
 * otherwise the file is rewritten in place.
 */
export async function writeCaptureNote(path: string, content: string, lineEnding: '\n' | '\r\n' = '\n'): Promise<boolean> {
  try {
    const notes = useNotes.getState();
    const buffer = notes.buffers[path];
    if (buffer && buffer.status === 'ready' && buffer.editable) {
      // Editor buffers are LF-normalized by design; notes.save() puts the
      // file's own endings back using buffer.lineEnding. Converting before
      // edit() here would double the CR characters on save.
      notes.edit(path, withLineEndings(content, '\n'));
      await notes.save(path);
      return true;
    }
    const payload = withLineEndings(content, lineEnding);
    await writeExternalFileBytes(path, new TextEncoder().encode(payload));
    // The link index re-reads just this note, so [[links]] stay accurate.
    void import('@/store/graph').then((graph) => graph.refreshPath(path)).catch(() => undefined);
    return true;
  } catch (error) {
    useToasts.getState().push({ kind: 'error', title: 'Could not update the note', description: errorMessage(error) });
    return false;
  }
}

/** Open a capture note on the canvas, where it behaves like any other note. */
export function openCaptureNote(path: string): void {
  useApp.getState().setView('canvas');
  useCanvas.getState().openResource(
    { type: 'note', title: stripExtension(baseName(path)), filePath: path },
    { isExternal: true },
  );
}

/** Capture into (or create) the chosen target, then confirm with an Open action. */
export async function captureTo(
  target: { path?: string; newName?: string },
  text: string,
): Promise<string | null> {
  let path = target.path ?? null;
  const wantsNewNote = !path && !!target.newName?.trim();
  if (wantsNewNote) {
    const created = await createCaptureNote(target.newName!.trim());
    path = created?.path ?? null;
    // The user asked for a specific new note. If it could not be created, do
    // not silently redirect the capture into the default Inbox.
    if (!path) return null;
  }
  if (!path) path = await resolveInboxPath();
  if (!path) return null;
  const written = await captureToNote(path, text);
  if (!written) return null;
  useToasts.getState().push({
    kind: 'success',
    title: `Captured to ${stripExtension(baseName(written))}`,
    // Long enough to actually click Open, not just read the confirmation.
    duration: 9000,
    action: { label: 'Open', run: () => openInboxSection(written) },
  });
  return written;
}
