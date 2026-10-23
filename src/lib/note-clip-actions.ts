import { useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { useSettings } from '@/store/settings';
import { promptDialog } from '@/store/dialogs';
import { toast, useToasts } from '@/store/toast';
import { createNewNote, openFileOnCanvas } from '@/lib/workspace-actions';
import { appendClip, clipKindFor, defaultNewNoteName, formatClip, noteLabel, type ClipSource } from '@/lib/note-clip';

/** A note may still be loading (for instance, its window is just opening); give it a moment. */
async function waitUntilReady(path: string, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    const buffer = useNotes.getState().buffers[path];
    if (!buffer || buffer.status !== 'loading' || Date.now() - started > timeoutMs) return buffer;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function remember(path: string) {
  useSettings.getState().updateNoteClip({ lastNote: path });
}

function reportAdded(label: string, page: number, open: () => void) {
  useToasts.getState().push({
    kind: 'success',
    title: `Added to \u201C${label}\u201D`,
    description: `Page ${page}`,
    action: { label: 'Open note', run: open },
  });
}

/**
 * Append a passage from a PDF to an existing note. This goes through the same buffer the editor uses, so
 * a note that is open on the canvas updates live, and one that is closed is read, changed and saved.
 */
export async function clipToNote(path: string, clip: ClipSource): Promise<boolean> {
  const file = useLibrary.getState().files.find((candidate) => candidate.path === path);
  if (!file) {
    toast.error('Note not found', 'It may have been moved or deleted.');
    return false;
  }
  try {
    await useNotes.getState().load(path);
    const buffer = await waitUntilReady(path);
    if (!buffer || buffer.status !== 'ready') throw new Error(buffer?.error ?? 'The note could not be opened.');
    if (!buffer.editable) throw new Error('This note is read-only, so text cannot be added to it.');
    useNotes.getState().edit(path, appendClip(buffer.content, formatClip(clip, clipKindFor(file))));
    await useNotes.getState().save(path);
  } catch (error) {
    toast.error('Could not add to the note', error);
    return false;
  }
  remember(path);
  reportAdded(noteLabel(file.name), clip.page, () => openFileOnCanvas(file));
  return true;
}

/** Create a new note holding the passage, named by the user, and open it next to the PDF. */
export async function clipToNewNote(clip: ClipSource, near?: string): Promise<boolean> {
  const name = await promptDialog({
    title: 'New note',
    label: 'Note name',
    initialValue: defaultNewNoteName(clip.title),
    confirmLabel: 'Create and add',
  });
  if (!name) return false;
  const title = name.trim();
  const file = await createNewNote({ title, content: `# ${title}\n\n${appendClip('', formatClip(clip, 'markdown'))}`, near });
  if (!file) return false;
  remember(file.path);
  toast.success(`Created \u201C${noteLabel(file.name)}\u201D`, `Page ${clip.page} added`);
  return true;
}
