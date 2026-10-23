import { buildNoteDocx } from './note-docx';
import { NOTE_FORMATS, NOTE_FORMAT_ORDER, noteFileName, noteToMarkdown, noteToText, type NoteFormat, type NoteSource } from './note-export';
import { buildNotePdf } from './note-pdf';
import { resolveNoteImage } from './image-resolve';
import { loadFont, saveExportedFile, type ExportResult } from './export-file';
import { readNote } from './tauri-commands';
import { useNotes } from '@/store/notes';
import { toast } from '@/store/toast';
import type { MenuEntry } from '@/components/ui/ContextMenu';

export interface NoteExportInput {
  /** File name or display title, e.g. "Lecture 3.md". */
  title: string;
  content: string;
}

/** Build the chosen format from the note text and let the user save it. */
export async function exportNote(input: NoteExportInput, format: NoteFormat): Promise<ExportResult> {
  const source: NoteSource = { title: input.title, markdown: input.content, exportedAt: new Date() };
  let bytes: Uint8Array;
  let replacedChars = 0;
  if (format === 'md') {
    bytes = new TextEncoder().encode(noteToMarkdown(source.markdown));
  } else if (format === 'txt') {
    bytes = new TextEncoder().encode(noteToText(source.markdown));
  } else if (format === 'docx') {
    bytes = await buildNoteDocx(source, resolveNoteImage);
  } else {
    const built = await buildNotePdf(source, loadFont, resolveNoteImage);
    bytes = built.bytes;
    replacedChars = built.replacedChars;
  }
  return saveExportedFile(bytes, noteFileName(input.title, format), NOTE_FORMATS[format], replacedChars);
}

/** Export with progress and result toasts. `getInput` is read at click time so unsaved edits are included. */
export async function exportNoteWithToasts(getInput: () => Promise<NoteExportInput> | NoteExportInput, format: NoteFormat): Promise<void> {
  try {
    const input = await getInput();
    const result = await exportNote(input, format);
    if (result.status === 'cancelled') return;
    toast.success(`${NOTE_FORMATS[format].label} exported`, result.path ?? noteFileName(input.title, format));
    if (result.replacedChars > 0) {
      toast.warning(
        'Some characters are missing in the PDF',
        `${result.replacedChars} character${result.replacedChars === 1 ? '' : 's'} the PDF fonts cannot draw (for example Arabic or Chinese) became “?”. Export to Word or Markdown to keep them.`,
      );
    }
  } catch (error) {
    toast.error('Export failed', error);
  }
}

/** Menu items for exporting one note in every format. */
export function noteExportMenu(getInput: () => Promise<NoteExportInput> | NoteExportInput, labelPrefix = ''): MenuEntry[] {
  return NOTE_FORMAT_ORDER.map((format) => ({
    label: `${labelPrefix}${NOTE_FORMATS[format].menuLabel}`,
    onSelect: () => void exportNoteWithToasts(getInput, format),
  }));
}

/** The latest text of a note: the open editor buffer if there is one, otherwise the file on disk. */
export async function currentNoteText(path: string): Promise<string> {
  const buffer = useNotes.getState().buffers[path];
  if (buffer) return buffer.content;
  return (await readNote(path)).content;
}
