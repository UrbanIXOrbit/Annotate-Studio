import { exportFileStem, formatExportDate, reportSummary, reportToMarkdown, type Report, type ReportItem } from './annotations.ts';
import { collectCodePoints, drawRun, measure, prepareTypesetter, toRuns, wrapText, type FontLoader } from './pdf-typeset.ts';

export type { FontLoader } from './pdf-typeset.ts';

export type ExportFormat = 'md' | 'docx' | 'pdf';

export const FORMAT_META: Record<ExportFormat, { label: string; extension: string; mime: string }> = {
  md: { label: 'Markdown', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  docx: {
    label: 'Word',
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  pdf: { label: 'PDF', extension: 'pdf', mime: 'application/pdf' },
};

export function exportFileName(report: Report, format: ExportFormat): string {
  return `${exportFileStem(report.title)} - annotations.${FORMAT_META[format].extension}`;
}

export function buildMarkdown(report: Report): Uint8Array {
  return new TextEncoder().encode(reportToMarkdown(report));
}

// ───────── colour helpers ─────────

const NEUTRAL = '9ca3af';

export function hexDigits(color: string | undefined, fallback = NEUTRAL): string {
  const match = color ? /^#?([0-9a-fA-F]{6})/.exec(color) : null;
  return (match ? match[1] : fallback).toLowerCase();
}

/** Mix a colour with white. amount=0 keeps it, amount=1 is white. Returns six hex digits. */
export function tintColor(color: string | undefined, amount: number): string {
  const hex = hexDigits(color);
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(value + (255 - value) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `${channel(0)}${channel(2)}${channel(4)}`;
}

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

export function isRtl(text: string): boolean {
  return RTL.test(text);
}

/** What to show as the body of an item: quoted text, or the note itself for notes and text boxes. */
export function itemBody(item: ReportItem): { quote: string; comment: string } {
  if (item.text) return { quote: item.text, comment: item.comment };
  if (item.kind === 'note' || item.kind === 'text') return { quote: item.comment, comment: '' };
  return { quote: '', comment: item.comment };
}

function itemMeta(item: ReportItem): string {
  return [item.author, item.modified ? item.modified.slice(0, 10) : ''].filter(Boolean).join(' · ');
}

// ───────── Word ─────────

export async function buildDocx(report: Report): Promise<Uint8Array> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, Footer, PageNumber, ShadingType, LineRuleType } = docx;

  const grey = '6b7280';
  const children: InstanceType<typeof Paragraph>[] = [];

  const runs = (text: string, options: Record<string, unknown> = {}) =>
    text.split('\n').map((line, index) => new TextRun({ text: line, break: index > 0 ? 1 : undefined, rightToLeft: isRtl(text) || undefined, ...options }));

  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`Annotations: ${report.title}`)] }));
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: `Exported ${formatExportDate(report.exportedAt)} · ${reportSummary(report)}`, color: grey, size: 20 })],
    }),
  );

  if (report.books.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: 'No annotations to export.', italics: true, color: grey })] }));
  }

  report.books.forEach((book, bookIndex) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: bookIndex > 0 ? 520 : 240, after: 60 },
        bidirectional: isRtl(book.title) || undefined,
        children: [new TextRun(book.title)],
      }),
    );
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `${book.count} annotation${book.count === 1 ? '' : 's'} · ${book.pageCount} pages`, color: grey, size: 20 })],
      }),
    );

    for (const page of book.pages) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(`Page ${page.page}`)] }));
      for (const item of page.items) {
        const { quote, comment } = itemBody(item);
        const accent = hexDigits(item.color);
        const rtl = isRtl(quote || comment);

        children.push(
          new Paragraph({
            keepNext: true,
            spacing: { before: 140, after: 40 },
            children: [
              new TextRun({ text: '\u25A0 ', color: accent, size: 18 }),
              new TextRun({ text: item.label.toUpperCase(), bold: true, color: grey, size: 16 }),
            ],
          }),
        );

        if (quote) {
          children.push(
            new Paragraph({
              indent: { left: 240 },
              spacing: { after: comment ? 60 : 100, line: 300, lineRule: LineRuleType.AUTO },
              bidirectional: rtl || undefined,
              border: { left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 8 } },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: tintColor(item.color, 0.86) },
              children: runs(quote, { size: 22 }),
            }),
          );
        }
        if (comment) {
          children.push(
            new Paragraph({
              indent: { left: 240 },
              spacing: { after: 100, line: 280, lineRule: LineRuleType.AUTO },
              bidirectional: isRtl(comment) || undefined,
              children: [new TextRun({ text: 'Comment: ', bold: true, size: 20 }), ...runs(comment, { size: 20 })],
            }),
          );
        }
        if (!quote && !comment) {
          children.push(new Paragraph({ indent: { left: 240 }, spacing: { after: 100 }, children: [new TextRun({ text: 'No text', italics: true, color: grey, size: 20 })] }));
        }
        const meta = itemMeta(item);
        if (meta) {
          children.push(new Paragraph({ indent: { left: 240 }, spacing: { after: 60 }, children: [new TextRun({ text: meta, color: grey, size: 16 })] }));
        }
      }
    }
  });

  const doc = new Document({
    creator: 'Annotate Studio',
    title: `Annotations: ${report.title}`,
    description: reportSummary(report),
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 44, bold: true, color: '111827' }, paragraph: { spacing: { after: 80 } } },
        { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: '111827' }, paragraph: { spacing: { before: 240, after: 60 }, keepNext: true } },
        { id: 'Heading2', name: 'heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true, color: '374151' }, paragraph: { spacing: { before: 280, after: 60 }, keepNext: true } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '9ca3af' })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

// ───────── PDF ─────────

function codePointsOf(report: Report): Set<number> {
  const texts = [`Annotations: ${report.title} Exported · ${reportSummary(report)}`];
  for (const book of report.books) {
    texts.push(book.title);
    for (const page of book.pages) for (const item of page.items) texts.push(`${item.label} ${item.text} ${item.comment} ${item.author ?? ''}`);
  }
  return collectCodePoints(texts);
}

export async function buildPdf(report: Report, loadFont: FontLoader): Promise<{ bytes: Uint8Array; replacedChars: number }> {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const type = await prepareTypesetter(pdf, loadFont, codePointsOf(report));

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const M = 54;
  const BOTTOM = 60;
  const CONTENT_W = PAGE_W - 2 * M;
  const INDENT = 14;

  const color = (hex: string) => {
    const h = hexDigits(hex);
    return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  };
  const INK = color('111827');
  const SOFT = color('374151');
  const GREY = color('6b7280');

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
  };
  const ensure = (height: number) => {
    if (y - height < BOTTOM) newPage();
  };

  const drawRuns = (text: string, x: number, baseline: number, size: number, bold: boolean, fill: ReturnType<typeof rgb>) => {
    let cursor = x;
    for (const run of toRuns(type, text, { bold })) cursor += drawRun(page, type, run, cursor, baseline, size, fill);
  };

  /** Lay out wrapped text, flowing onto new pages; optionally with a coloured bar down the left. */
  const paragraph = (text: string, opts: { size: number; bold?: boolean; fill: ReturnType<typeof rgb>; indent?: number; bar?: string; gapAfter?: number; leading?: number }) => {
    const indent = opts.indent ?? 0;
    const leading = opts.leading ?? opts.size * 1.5;
    const lines = wrapText(type, text, opts.size, { bold: opts.bold ?? false }, CONTENT_W - indent);
    for (const line of lines) {
      ensure(leading);
      const baseline = y - opts.size;
      if (opts.bar) page.drawRectangle({ x: M + 2, y: y - leading + (leading - opts.size) / 2 - 1.5, width: 2.5, height: leading, color: color(opts.bar) });
      if (line) drawRuns(line, M + indent, baseline, opts.size, opts.bold ?? false, opts.fill);
      y -= leading;
    }
    y -= opts.gapAfter ?? 0;
  };

  paragraph(`Annotations: ${report.title}`, { size: 20, bold: true, fill: INK, gapAfter: 4 });
  paragraph(`Exported ${formatExportDate(report.exportedAt)} · ${reportSummary(report)}`, { size: 9.5, fill: GREY, gapAfter: 10 });

  if (report.books.length === 0) paragraph('No annotations to export.', { size: 11, fill: GREY });

  report.books.forEach((book, bookIndex) => {
    if (bookIndex > 0) y -= 22;
    ensure(120);
    paragraph(book.title, { size: 15, bold: true, fill: INK, gapAfter: 1 });
    paragraph(`${book.count} annotation${book.count === 1 ? '' : 's'} · ${book.pageCount} pages`, { size: 9, fill: GREY, gapAfter: 4 });
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: PAGE_W - M, y: y + 2 }, thickness: 0.6, color: color('d1d5db') });
    y -= 8;

    for (const bookPage of book.pages) {
      ensure(70);
      y -= 6;
      paragraph(`Page ${bookPage.page}`, { size: 11.5, bold: true, fill: SOFT, gapAfter: 2 });

      for (const item of bookPage.items) {
        const { quote, comment } = itemBody(item);
        const accent = hexDigits(item.color);
        ensure(52);
        const labelBase = y - 8.5;
        page.drawRectangle({ x: M + 2, y: labelBase - 0.5, width: 6, height: 6, color: color(accent) });
        drawRuns(item.label.toUpperCase(), M + 14, labelBase, 8, true, GREY);
        y -= 15;

        if (quote) paragraph(quote, { size: 10.5, fill: INK, indent: INDENT, bar: accent, leading: 15, gapAfter: comment ? 3 : 0 });
        if (comment) {
          ensure(16);
          const base = y - 10;
          drawRuns('Comment:', M + INDENT, base, 9.5, true, SOFT);
          const labelWidth = measure(type, 'Comment: ', 9.5, { bold: true });
          const lines = wrapText(type, comment, 9.5, {}, CONTENT_W - INDENT - labelWidth);
          lines.forEach((line, index) => {
            ensure(14);
            const baseline = y - 10;
            drawRuns(line, M + INDENT + (index === 0 ? labelWidth : 0), baseline, 9.5, false, SOFT);
            y -= 14;
          });
        }
        if (!quote && !comment) paragraph('No text', { size: 9.5, fill: GREY, indent: INDENT });
        const meta = itemMeta(item);
        if (meta) paragraph(meta, { size: 8, fill: GREY, indent: INDENT });
        y -= 8;
      }
    }
  });

  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    const label = `${index + 1} / ${pages.length}`;
    const width = measure(type, label, 8);
    page = p;
    drawRuns(label, (PAGE_W - width) / 2, 28, 8, false, GREY);
  });

  pdf.setTitle(`Annotations: ${report.title}`);
  pdf.setCreator('Annotate Studio');
  pdf.setProducer('Annotate Studio');
  pdf.setCreationDate(report.exportedAt);
  return { bytes: await pdf.save(), replacedChars: type.replaced };
}
