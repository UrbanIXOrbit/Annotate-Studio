import { discardPdfSaves, flushPdfSaves, waitForPdfSaves } from './pdf-saves';
import {
  createExternalNote,
  createNote,
  deleteWorkspaceFile,
  getDataDir,
  isTauri,
  readExternalFileBytes,
  readFileBytes,
  readTextFile,
  renameExternalFile,
  renameWorkspaceFile,
  writeFileBytes,
  writeTextFile,
  type StudyFile,
} from './tauri-commands';
import { extractPdfText, type ExtractedPdfText } from './pdf-engine';
import { BOOK_EXTENSIONS, extractBookText } from './book-engine';
import { baseName, extensionOf, isExternalPath, stripExtension } from './utils';
import { useApp } from '@/store/app';
import { useCanvas, type AudioTrack, type OpenOptions, type ResourceType } from '@/store/canvas';
import { confirmDialog, promptDialog } from '@/store/dialogs';
import { resolveWikiLink, useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { useSettings } from '@/store/settings';
import { toast } from '@/store/toast';

export { BOOK_EXTENSIONS };
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
export const NOTE_EXTENSIONS = ['md', 'markdown', 'mdx', 'txt', 'text'];
export const DOCUMENT_EXTENSIONS = ['docx', 'odt'];
export const AUDIO_EXTENSIONS = ['mp3', 'mp4', 'm4a', 'm4b', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'webm', 'aiff', 'aif', 'wma'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'mkv', '3gp', 'wmv', 'flv', 'mpeg', 'mpg'];

const AUDIO_MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', flac: 'audio/flac',
  webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma',
};

/** The MIME type to hand an audio element for a file name, from its extension. */
export function audioMediaType(name: string): string {
  return AUDIO_MEDIA_TYPES[extensionOf(name)] ?? 'audio/mpeg';
}

export function resourceTypeFor(file: Pick<StudyFile, 'file_type' | 'name'>): ResourceType | null {
  switch (file.file_type) {
    case 'Pdf':
      return 'pdf';
    case 'Image':
      return 'image';
    case 'Book':
      return 'book';
    case 'Audio':
      return 'audiobook';
    case 'Markdown':
    case 'Text':
      return 'note';
    default: {
      const ext = extensionOf(file.name);
      if (ext === 'pdf') return 'pdf';
      if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
      if (NOTE_EXTENSIONS.includes(ext)) return 'note';
      if (BOOK_EXTENSIONS.includes(ext)) return 'book';
      if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
      if (AUDIO_EXTENSIONS.includes(ext)) return 'audiobook';
      return null;
    }
  }
}

export function displayTitle(file: Pick<StudyFile, 'name' | 'file_type'>): string {
  return file.file_type === 'Markdown' || file.file_type === 'Audio' ? stripExtension(file.name) : file.name;
}

export function openFileOnCanvas(file: StudyFile, options: OpenOptions = {}): string | null {
  const type = resourceTypeFor(file);
  if (!type) {
    toast.warning('This file type cannot be opened on the canvas', file.name);
    return null;
  }
  const id = useCanvas.getState().openResource(
    {
      type,
      title: displayTitle(file),
      filePath: file.path,
      ...(type === 'audiobook'
        ? { tracks: [{ path: file.path, title: file.name, mediaType: audioMediaType(file.name) }] }
        : {}),
    },
    // Files kept outside the workspace are read in place through the external
    // file commands; workspace files go through the workspace ones.
    { ...options, isExternal: options.isExternal ?? isExternalPath(file.path) },
  );
  useSettings.getState().touchRecent(file.path);
  return id;
}

export async function addWebArticle(at?: { x: number; y: number }): Promise<string | null> {
  const url = await promptDialog({
    title: 'Add web article',
    label: 'Article URL',
    placeholder: 'https://example.com/article',
    confirmLabel: 'Open article',
    validate: (value) => {
      try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? null : 'Enter an HTTP or HTTPS web address.';
      } catch {
        return 'Enter a valid web address.';
      }
    },
  });
  if (!url?.trim()) return null;
  const parsed = new URL(url.trim());
  const id = useCanvas.getState().openResource(
    { type: 'article', title: parsed.hostname, articleUrl: parsed.href },
    { at, focusExisting: true },
  );
  return id;
}

function openImported(files: StudyFile[], at?: { x: number; y: number }) {
  files.forEach((file, index) => {
    const offset = index * 40;
    openFileOnCanvas(file, at ? { at: { x: at.x + offset, y: at.y + offset } } : {});
  });
}

/**
 * Opens dragged/picked files at their original paths — nothing is copied into
 * app storage. Each file is referenced in place on the canvas and, via
 * `openResource`, in the library.
 */
export async function importPaths(paths: string[], at?: { x: number; y: number }): Promise<void> {
  if (paths.length === 0) return;
  let skipped = 0;
  paths.forEach((path, index) => {
    const name = baseName(path);
    const type = resourceTypeFor({ file_type: 'Unknown', name });
    if (!type) {
      skipped += 1;
      return;
    }
    const title = type === 'note' || type === 'audiobook' ? stripExtension(name) : name;
    useCanvas.getState().openResource(
      {
        type,
        title,
        filePath: path,
        ...(type === 'audiobook'
          ? { tracks: [{ path, title: name, mediaType: audioMediaType(name) }] }
          : {}),
      },
      { at: at ? { x: at.x + index * 40, y: at.y + index * 40 } : undefined, isExternal: true, focusExisting: false },
    );
  });
  if (skipped > 0) {
    toast.warning(
      `${skipped} file${skipped > 1 ? 's were' : ' was'} skipped`,
      'Only PDFs, e-books, images, videos, audio and text notes are supported.',
    );
  }
}

export async function importBrowserFiles(files: File[], at?: { x: number; y: number }): Promise<StudyFile[]> {
  const imported: StudyFile[] = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    const isNote = NOTE_EXTENSIONS.includes(ext);
    const isBook = BOOK_EXTENSIONS.includes(ext);
    const isAudio = AUDIO_EXTENSIONS.includes(ext) || file.type.startsWith('audio/');
    const supported = ext === 'pdf' || isBook || IMAGE_EXTENSIONS.includes(ext) || isNote || isAudio || file.type.startsWith('image/');
    if (!supported) {
      toast.warning('Unsupported file', file.name);
      continue;
    }
    try {
      const name = file.name || `Pasted ${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const saved = await writeFileBytes({ dir: isNote ? 'notes' : 'documents', name, unique: true }, await file.arrayBuffer());
      useLibrary.getState().upsert(saved);
      imported.push(saved);
    } catch (error) {
      toast.error(`Could not import ${file.name}`, error);
    }
  }
  openImported(imported, at);
  return imported;
}

export async function pickAndImport(kind: 'pdf' | 'image' | 'note' | 'audiobook' | 'video' | 'any', at?: { x: number; y: number }) {
  if (!isTauri()) {
    toast.warning('Importing files requires the desktop app');
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const filters =
    kind === 'pdf'
      ? [{ name: 'PDF', extensions: ['pdf'] }]
      : kind === 'image'
        ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
        : kind === 'note'
          ? [{ name: 'Notes', extensions: NOTE_EXTENSIONS }]
          : kind === 'audiobook'
            ? [{ name: 'Audio files', extensions: AUDIO_EXTENSIONS }]
            : kind === 'video'
              ? [{ name: 'Video files', extensions: VIDEO_EXTENSIONS }]
            : [{ name: 'Study files', extensions: ['pdf', ...BOOK_EXTENSIONS, ...IMAGE_EXTENSIONS, ...NOTE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] }];
  const selection = await open({ multiple: true, filters });
  if (!selection) return;
  const paths = Array.isArray(selection) ? selection : [selection];
  if (kind === 'pdf') {
    for (const path of paths) {
      const title = baseName(path);
      useCanvas.getState().openResource(
        { type: 'pdf', title, filePath: path },
        { at, isExternal: true, focusExisting: false },
      );
    }
    return;
  }
  if (kind === 'audiobook') {
    const tracks: AudioTrack[] = paths.map((path) => {
      const title = path.split(/[\\/]/).pop() || 'Audio track';
      const ext = extensionOf(title);
      return { path, title, mediaType: AUDIO_MEDIA_TYPES[ext] ?? 'application/octet-stream' };
    });
    if (tracks.length > 0) {
      useCanvas.getState().openResource(
        { type: 'audiobook', title: tracks.length === 1 ? tracks[0].title : stripExtension(tracks[0].title), filePath: tracks[0].path, tracks },
        { at, isExternal: true, focusExisting: false },
      );
    }
    return;
  }
  if (kind === 'video') {
    for (const path of paths) {
      const title = path.split(/[\\/]/).pop() || 'Video';
      useCanvas.getState().openResource({ type: 'video', title, filePath: path }, { at, isExternal: true, focusExisting: false });
    }
    return;
  }
  await importPaths(paths, at);
}

/**
 * The folder new notes go to: the user's chosen notes folder, or a one-time
 * folder picker (persisted afterwards) exactly like the recording flow. The
 * picker defaults to the workspace notes folder but may be anywhere on disk.
 */
export async function resolveNoteFolder(): Promise<string | null> {
  const settings = useSettings.getState();
  if (settings.noteFolder) return settings.noteFolder;
  if (!isTauri()) {
    toast.warning('Creating notes requires the desktop app');
    return null;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  let defaultPath: string | undefined;
  try {
    defaultPath = `${(await getDataDir()).replace(/[\\/]+$/, '')}/notes`;
  } catch {
    defaultPath = undefined;
  }
  const picked = await open({
    directory: true,
    multiple: false,
    title: 'Choose where new notes are saved',
    defaultPath,
  });
  if (typeof picked !== 'string') return null;
  settings.update({ noteFolder: picked });
  return picked;
}

export async function createNewNote(
  options: { at?: { x: number; y: number }; content?: string; title?: string; near?: string; directory?: string } = {},
) {
  try {
    const title = options.title?.trim() || 'Untitled';
    const content = options.content ?? `# ${title}\n\n`;
    const directory = options.directory ?? await resolveNoteFolder();
    if (!directory) return null;
    // The note is created in the chosen folder — never copied into the
    // workspace — and referenced there by the library and the canvas.
    const file = await createExternalNote(directory, title, content);
    useCanvas.getState().openResource(
      { type: 'note', title: displayTitle(file), filePath: file.path },
      { at: options.at, near: options.near, focusExisting: false, isExternal: true },
    );
    return file;
  } catch (error) {
    toast.error('Could not create the note', error);
    return null;
  }
}

export async function openWikiLink(target: string, near?: string) {
  const library = useLibrary.getState();
  const files = library.loaded ? library.files : await library.refresh();
  const file = resolveWikiLink(files, target);
  useApp.getState().setView('canvas');
  if (file) {
    openFileOnCanvas(file, near ? { near } : {});
    return;
  }
  const create = await confirmDialog({
    title: `Create “${target}”?`,
    message: 'There is no note with this name yet. Create it now?',
    confirmLabel: 'Create note',
  });
  if (create) await createNewNote({ title: target, near });
}

export async function renameFile(path: string, newName: string): Promise<StudyFile | null> {
  const trimmed = newName.trim();
  if (!trimmed) return null;
  try {
    const notes = useNotes.getState();
    if (notes.buffers[path]?.dirty) await notes.save(path);
    await flushPdfSaves(path);
    const file = isExternalPath(path)
      ? await renameExternalFile(path, trimmed)
      : await renameWorkspaceFile(path, trimmed);
    if (file.path !== path) {
      discardPdfSaves(path);
      notes.move(path, file.path);
      if (isExternalPath(file.path)) {
        useLibrary.getState().replaceExternal(path, file);
      } else {
        useLibrary.getState().replace(path, file);
      }
      const settings = useSettings.getState();
      const opened = settings.recentFiles[path];
      settings.forgetRecent(path);
      if (opened) settings.touchRecent(file.path);
      if (settings.noteClip.lastNote === path) settings.updateNoteClip({ lastNote: file.path });
    } else {
      useLibrary.getState().upsert(file);
    }
    useCanvas.getState().replaceFilePath(path, file.path, displayTitle(file));
    return file;
  } catch (error) {
    toast.error('Rename failed', error);
    return null;
  }
}

export async function deleteFile(path: string): Promise<boolean> {
  try {
    discardPdfSaves(path);
    await waitForPdfSaves(path);
    if (isExternalPath(path)) {
      // Files outside the workspace stay on the user's device; only the
      // library reference to them is removed.
      useCanvas.getState().closeByFilePath(path);
      useLibrary.getState().removeExternal(path);
      useNotes.getState().drop(path);
      useSettings.getState().forgetRecent(path);
      return true;
    }
    await deleteWorkspaceFile(path);
    useCanvas.getState().closeByFilePath(path);
    useLibrary.getState().remove(path);
    useNotes.getState().drop(path);
    useSettings.getState().forgetRecent(path);
    return true;
  } catch (error) {
    toast.error('Delete failed', error);
    return false;
  }
}

function parentDirectoryOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return index > 0 ? cleaned.slice(0, index) : cleaned;
}

export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parentDirectoryOf(path));
  } catch (error) {
    toast.error('Could not open the file location', error);
  }
}

export async function migrateInlineNotes(): Promise<void> {
  const { workspaces } = useCanvas.getState();
  for (const workspace of workspaces) {
    for (const resource of workspace.resources) {
      if (resource.type !== 'note' || resource.content === undefined) continue;
      try {
        let path = resource.filePath;
        if (path) {
          const saved = await writeTextFile(path, resource.content);
          useLibrary.getState().upsert(saved);
          useNotes.getState().reset(path, resource.content);
        } else {
          const file = await createNote(stripExtension(resource.title) || 'Untitled', resource.content);
          useLibrary.getState().upsert(file);
          path = file.path;
        }
        useCanvas.getState().patchResourceIn(workspace.id, resource.id, {
          filePath: path,
          content: undefined,
          title: stripExtension(baseName(path)),
        });
      } catch {
        continue;
      }
    }
  }
}

/**
 * Catch-up for external files opened before the library referenced them in
 * place: every canvas resource whose file lives outside the workspace is
 * registered in the library at its own path — nothing is copied — so it shows
 * up in the library like everything opened from now on.
 */
export async function registerExternalResources(): Promise<void> {
  const { workspaces } = useCanvas.getState();
  const library = useLibrary.getState();
  for (const workspace of workspaces) {
    for (const resource of workspace.resources) {
      if (!resource.isExternal || !resource.filePath || !isExternalPath(resource.filePath)) continue;
      try {
        await library.registerExternal(resource.filePath);
      } catch {
        continue;
      }
    }
  }
}

export interface DocumentText {
  name: string;
  text: string;
  pageCount?: number;
  truncated: boolean;
}

export async function readDocumentText(path: string, maxChars = 40_000): Promise<DocumentText> {
  const name = baseName(path);
  const ext = extensionOf(name);
  if (isExternalPath(path)) {
    // Files referenced in place are read through the external file commands,
    // extracted exactly like their workspace counterparts.
    const bytes = await readExternalFileBytes(path);
    if (ext === 'pdf') {
      const extracted: ExtractedPdfText = await extractPdfText(bytes, maxChars);
      return { name, text: extracted.text, pageCount: extracted.pageCount, truncated: extracted.truncated };
    }
    if (BOOK_EXTENSIONS.includes(ext)) {
      const extracted = await extractBookText(bytes, name, maxChars);
      return { name, text: extracted.text, truncated: extracted.truncated };
    }
    if (IMAGE_EXTENSIONS.includes(ext)) {
      return { name, text: '', truncated: false };
    }
    const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n');
    return { name, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  if (ext === 'pdf') {
    const bytes = await readFileBytes(path);
    const extracted: ExtractedPdfText = await extractPdfText(bytes, maxChars);
    return { name, text: extracted.text, pageCount: extracted.pageCount, truncated: extracted.truncated };
  }
  if (BOOK_EXTENSIONS.includes(ext)) {
    const bytes = await readFileBytes(path);
    const extracted = await extractBookText(bytes, baseName(path), maxChars);
    return { name, text: extracted.text, truncated: extracted.truncated };
  }
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return { name, text: '', truncated: false };
  }
  const buffer = useNotes.getState().buffers[path];
  const text = buffer && buffer.status === 'ready' ? buffer.content : await readTextFile(path);
  return { name, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
