import { PdfAnnotationSubtype, type PdfAnnotationObject } from '@embedpdf/models';
import { getPdfEngine } from './pdf-engine';
import { readFileBytes, type StudyFile } from './tauri-commands';
import { stripExtension, uid } from './utils';
import {
  charIndicesInRects,
  indicesToRanges,
  isTextMarkup,
  joinSlices,
  normalizeColor,
  sortEntries,
  type AnnotationEntry,
  type AnnotationKind,
  type BookAnnotations,
  type RectLike,
} from './annotations';

const KIND_BY_SUBTYPE = new Map<PdfAnnotationSubtype, AnnotationKind>([
  [PdfAnnotationSubtype.HIGHLIGHT, 'highlight'],
  [PdfAnnotationSubtype.UNDERLINE, 'underline'],
  [PdfAnnotationSubtype.STRIKEOUT, 'strikeout'],
  [PdfAnnotationSubtype.SQUIGGLY, 'squiggly'],
  [PdfAnnotationSubtype.TEXT, 'note'],
  [PdfAnnotationSubtype.FREETEXT, 'text'],
  [PdfAnnotationSubtype.INK, 'drawing'],
  [PdfAnnotationSubtype.SQUARE, 'shape'],
  [PdfAnnotationSubtype.CIRCLE, 'shape'],
  [PdfAnnotationSubtype.POLYGON, 'shape'],
  [PdfAnnotationSubtype.POLYLINE, 'shape'],
  [PdfAnnotationSubtype.LINE, 'line'],
  [PdfAnnotationSubtype.STAMP, 'stamp'],
]);

function readColor(annotation: PdfAnnotationObject): string | undefined {
  const bag = annotation as unknown as Record<string, unknown>;
  return normalizeColor(bag.strokeColor) ?? normalizeColor(bag.color) ?? normalizeColor(bag.fontColor);
}

function readIso(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return undefined;
}

function markupRects(annotation: PdfAnnotationObject): RectLike[] {
  const rects = (annotation as unknown as { segmentRects?: RectLike[] }).segmentRects;
  return Array.isArray(rects) && rects.length > 0 ? rects : [annotation.rect];
}

/** Read every user annotation (and the text under each markup) from the bytes of one PDF. */
export async function scanPdfBytes(bytes: Uint8Array, path: string, title: string): Promise<BookAnnotations> {
  const engine = await getPdfEngine();
  const content = bytes.slice().buffer as ArrayBuffer;
  const doc = await engine.openDocumentBuffer({ id: `scan-${uid()}`, content }).toPromise();
  try {
    const byPage = await engine.getAllAnnotations(doc).toPromise();
    const entries: AnnotationEntry[] = [];

    for (const [key, annotations] of Object.entries(byPage)) {
      const pageIndex = Number(key);
      const page = doc.pages[pageIndex];
      if (!page) continue;

      const kept = annotations.filter((annotation) => KIND_BY_SUBTYPE.has(annotation.type));
      if (kept.length === 0) continue;

      const markup = kept.filter((annotation) => isTextMarkup(KIND_BY_SUBTYPE.get(annotation.type)!));
      const textById = new Map<string, string>();

      if (markup.length > 0) {
        try {
          const { runs } = await engine.getPageGeometry(doc, page).toPromise();
          const wanted: { id: string; start: number; count: number }[] = [];
          const slices: { pageIndex: number; charIndex: number; charCount: number }[] = [];
          for (const annotation of markup) {
            const ranges = indicesToRanges(charIndicesInRects(runs, markupRects(annotation)));
            const start = slices.length;
            for (const range of ranges) slices.push({ pageIndex, ...range });
            wanted.push({ id: annotation.id, start, count: ranges.length });
          }
          const extracted = slices.length > 0 ? await engine.getTextSlices(doc, slices).toPromise() : [];
          for (const item of wanted) textById.set(item.id, joinSlices(extracted.slice(item.start, item.start + item.count)));
        } catch {
          // Pages with no text layer (scans) still list their highlights, just without quoted words.
        }
      }

      for (const annotation of kept) {
        const kind = KIND_BY_SUBTYPE.get(annotation.type)!;
        entries.push({
          id: annotation.id,
          page: pageIndex + 1,
          kind,
          text: isTextMarkup(kind) ? (textById.get(annotation.id) ?? '') : '',
          comment: (annotation.contents ?? '').replace(/\r\n?/g, '\n').trim(),
          color: readColor(annotation),
          author: annotation.author?.trim() || undefined,
          modified: readIso(annotation.modified ?? annotation.created),
          x: annotation.rect.origin.x,
          y: annotation.rect.origin.y,
        });
      }
    }

    return { path, title, pageCount: doc.pageCount, entries: sortEntries(entries) };
  } finally {
    await engine.closeDocument(doc).toPromise().catch(() => undefined);
  }
}

export async function scanPdfFile(file: StudyFile): Promise<BookAnnotations> {
  const bytes = await readFileBytes(file.path);
  return scanPdfBytes(bytes, file.path, stripExtension(file.name));
}
