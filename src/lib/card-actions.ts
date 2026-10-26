import { activeWorkspace, useCanvas, type CardSource, type ResourceType } from '@/store/canvas';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/toast';
import { usePdfNav } from '@/lib/pdf-nav';
import { openFileOnCanvas, resourceTypeFor } from '@/lib/workspace-actions';

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

/** Focus (or open) the source document of a highlight card and scroll it to the quote. */
export function openCardSource(source: CardSource): void {
  if (!source.cfi) {
    openPdfAtPage(source.filePath, source.page, source.title);
    return;
  }
  const existing = activeWorkspace(useCanvas.getState()).resources.find(
    (resource) => resource.filePath === source.filePath && resource.type !== 'card',
  );
  if (existing) {
    useCanvas.getState().focusResource(existing.id);
    usePdfNav.getState().request(source.filePath, source.page, source.cfi);
    return;
  }
  const library = useLibrary.getState();
  const file = library.files.find((candidate) => candidate.path === source.filePath);
  const type: ResourceType = (file && resourceTypeFor(file)) || 'book';
  if (library.loaded && !file && !source.isExternal) {
    toast.warning('Source document not found', 'It may have been moved or deleted from your library.');
    return;
  }
  if (file) openFileOnCanvas(file);
  else useCanvas.getState().openResource({ type, title: source.title, filePath: source.filePath }, { isExternal: source.isExternal });
  usePdfNav.getState().request(source.filePath, source.page, source.cfi);
}
