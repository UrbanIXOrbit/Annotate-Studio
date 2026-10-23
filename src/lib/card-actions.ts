import { useCanvas, type CardSource } from '@/store/canvas';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/toast';
import { usePdfNav } from '@/lib/pdf-nav';
import { openFileOnCanvas } from '@/lib/workspace-actions';

/** Focus (or open) a PDF on the canvas and scroll it to `page` (1-based). Returns false if the file is gone. */
export function openPdfAtPage(path: string, page: number, fallbackTitle = 'PDF'): boolean {
  const library = useLibrary.getState();
  const file = library.files.find((candidate) => candidate.path === path);
  if (library.loaded && !file) {
    toast.warning('Source PDF not found', 'It may have been moved or deleted from your library.');
    return false;
  }
  if (file) openFileOnCanvas(file);
  else useCanvas.getState().openResource({ type: 'pdf', title: fallbackTitle, filePath: path });
  usePdfNav.getState().request(path, page);
  return true;
}

/** Focus (or open) the source PDF of a highlight card and scroll it to the quoted page. */
export function openCardSource(source: CardSource): void {
  openPdfAtPage(source.filePath, source.page, source.title);
}
