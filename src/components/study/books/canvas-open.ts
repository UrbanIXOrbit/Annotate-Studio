import type { BookFile } from '@/store/books';
import { useCanvas } from '@/store/canvas';
import { useApp } from '@/store/app';
import { BOOK_EXTENSIONS, IMAGE_EXTENSIONS, NOTE_EXTENSIONS } from '@/lib/workspace-actions';

/**
 * Open a library file on the canvas and switch to it. Shared by the file
 * row's buttons/menus and the list's keyboard navigation (Enter), so the
 * supported-type rules live in exactly one place.
 */
export async function openBookFileOnCanvas(file: BookFile): Promise<void> {
  const label = file.displayName || file.name;
  const ext = file.extension.toLowerCase();
  let type: 'pdf' | 'image' | 'note' | 'book' | null = null;

  if (ext === 'pdf') {
    type = 'pdf';
  } else if (IMAGE_EXTENSIONS.includes(ext)) {
    type = 'image';
  } else if (NOTE_EXTENSIONS.includes(ext)) {
    type = 'note';
  } else if (BOOK_EXTENSIONS.includes(ext)) {
    type = 'book';
  }

  if (!type) {
    alert('This file type cannot be opened on the canvas. Only PDFs, e-books, images, and text notes are supported.');
    return;
  }

  try {
    const canvas = useCanvas.getState();
    canvas.openResource({ type, title: label, filePath: file.filePath }, { isExternal: true });
    useApp.getState().setView('canvas');
  } catch (error) {
    alert(`Failed to open file on canvas: ${error}`);
  }
}
