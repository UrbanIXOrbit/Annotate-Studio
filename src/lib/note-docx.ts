import { isSafeUrl, parseMarkdown, type Block, type Inline } from './markdown.ts';
import { fitImage, inlineText, noteDisplayTitle, normalizeNewlines, resolveImages, stripFrontMatter, type ImageResolver, type NoteSource, type ResolvedImage } from './note-export.ts';

type Docx = typeof import('docx');
type DocChild = import('docx').Paragraph | import('docx').Table;
type ParaChild = import('docx').ParagraphChild;

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const MAX_IMAGE_W = 580;
const MAX_IMAGE_H = 720;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  math?: boolean;
  color?: string;
  size?: number;
}

interface Ctx {
  /** Left indent in twips. */
  indent: number;
  quote: boolean;
  /** Paragraphs inside tight list items sit closer together. */
  tight: boolean;
}

export async function buildNoteDocx(source: NoteSource, resolveImage: ImageResolver): Promise<Uint8Array> {
  const docx = await import('docx');
  const {
    AlignmentType,
    BorderStyle,
    ExternalHyperlink,
    Footer,
    HeadingLevel,
    ImageRun,
    LevelFormat,
    LineRuleType,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
    Document,
  } = docx as Docx;

  const blocks = parseMarkdown(normalizeNewlines(stripFrontMatter(source.markdown)));
  const images = await resolveImages(blocks, resolveImage);
  const orderedLists: { reference: string; start: number }[] = [];

  // ───────── inline ─────────
  const text = (value: string, style: RunStyle, rtl: boolean): ParaChild =>
    new TextRun({
      text: value,
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      color: style.color,
      size: style.size,
      font: style.code ? 'Consolas' : style.math ? 'Cambria Math' : undefined,
      shading: style.code ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined,
      rightToLeft: rtl || undefined,
    });

  const imageRun = (image: ResolvedImage, alt: string): ParaChild => {
    const size = fitImage(image.width, image.height, MAX_IMAGE_W, MAX_IMAGE_H);
    return new ImageRun({
      type: image.type,
      data: image.bytes,
      transformation: size,
      altText: { name: alt || 'Image', description: alt || 'Image', title: alt || 'Image' },
    });
  };

  const inline = (nodes: Inline[], style: RunStyle, rtl: boolean): ParaChild[] => {
    const out: ParaChild[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out.push(text(node.value, style, rtl));
          break;
        case 'strong':
          out.push(...inline(node.children, { ...style, bold: true }, rtl));
          break;
        case 'em':
          out.push(...inline(node.children, { ...style, italics: true }, rtl));
          break;
        case 'del':
          out.push(...inline(node.children, { ...style, strike: true }, rtl));
          break;
        case 'code':
          out.push(text(node.value, { ...style, code: true, size: style.size ? Math.round(style.size * 0.9) : 20 }, false));
          break;
        case 'math':
          out.push(text(node.value, { ...style, math: true, italics: true }, false));
          break;
        case 'wikilink':
          out.push(text(node.label, { ...style, color: '6D28D9' }, rtl));
          break;
        case 'break':
          out.push(new TextRun({ break: 1 }));
          break;
        case 'image': {
          const image = images.get(node.src);
          if (image) out.push(imageRun(image, node.alt));
          else out.push(text(`[Image: ${node.alt || node.src}]`, { ...style, color: '6B7280', italics: true }, rtl));
          break;
        }
        case 'link': {
          const children = inline(node.children, { ...style, color: '0563C1' }, rtl);
          if (isSafeUrl(node.href) && /^(https?:|mailto:)/i.test(node.href)) {
            out.push(new ExternalHyperlink({ link: node.href, children }));
          } else {
            out.push(...children);
          }
          break;
        }
      }
    }
    return out;
  };

  const paraProps = (ctx: Ctx, rtl: boolean) => ({
    indent: { left: ctx.indent + (ctx.quote ? 360 : 0) },
    border: ctx.quote ? { left: { style: BorderStyle.SINGLE, size: 18, color: '9CA3AF', space: 10 } } : undefined,
    bidirectional: rtl || undefined,
  });

  // ───────── blocks ─────────
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  const tableOf = (block: Extract<Block, { type: 'table' }>, ctx: Ctx): import('docx').Table => {
    const alignment = (index: number) => {
      const align = block.align[index];
      return align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
    };
    const cell = (nodes: Inline[], index: number, header: boolean) => {
      const plain = inlineText(nodes);
      const rtl = RTL.test(plain);
      return new TableCell({
        shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ alignment: alignment(index), bidirectional: rtl || undefined, children: inline(nodes, { bold: header, size: 21 }, rtl) })],
      });
    };
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
    const fill = (cells: Inline[][]) => Array.from({ length: columns }, (_, index) => cells[index] ?? []);
    const line = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      indent: ctx.indent ? { size: ctx.indent, type: WidthType.DXA } : undefined,
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: fill(block.header).map((nodes, index) => cell(nodes, index, true)) }),
        ...block.rows.map((row) => new TableRow({ cantSplit: true, children: fill(row).map((nodes, index) => cell(nodes, index, false)) })),
      ],
    });
  };

  const listOf = (block: Extract<Block, { type: 'list' }>, level: number, ctx: Ctx): DocChild[] => {
    const out: DocChild[] = [];
    let reference = 'bullets';
    if (block.ordered) {
      reference = `ol-${orderedLists.length + 1}`;
      orderedLists.push({ reference, start: block.start });
    }
    const textIndent = (level + 1) * 540;
    for (const item of block.items) {
      const task = item.checked !== null;
      const [first, ...rest] = item.children;
      const numbering = { reference: task ? 'tasks' : reference, level: Math.min(level, 8) };
      const box = task ? [new TextRun({ text: item.checked ? '\u2611 ' : '\u2610 ', font: 'Segoe UI Symbol', color: item.checked ? '16A34A' : '6B7280' })] : [];
      if (first && first.type === 'paragraph') {
        const plain = inlineText(first.children);
        const rtl = RTL.test(plain);
        out.push(
          new Paragraph({
            numbering,
            bidirectional: rtl || undefined,
            spacing: { after: 40, line: 290, lineRule: LineRuleType.AUTO },
            children: [...box, ...inline(first.children, task && item.checked ? { color: '6B7280', strike: true } : {}, rtl)],
          }),
        );
      } else {
        out.push(new Paragraph({ numbering, spacing: { after: 40 }, children: box }));
        if (first) rest.unshift(first);
      }
      const inner: Ctx = { indent: ctx.indent + textIndent, quote: false, tight: true };
      for (const child of rest) {
        if (child.type === 'list') out.push(...listOf(child, level + 1, ctx));
        else out.push(...render([child], inner));
      }
    }
    return out;
  };

  function render(list: Block[], ctx: Ctx): DocChild[] {
    const out: DocChild[] = [];
    for (const block of list) {
      switch (block.type) {
        case 'heading': {
          const plain = inlineText(block.children);
          const rtl = RTL.test(plain);
          out.push(
            new Paragraph({
              heading: HEADINGS[block.level - 1],
              keepNext: true,
              ...paraProps(ctx, rtl),
              children: inline(block.children, {}, rtl),
            }),
          );
          break;
        }
        case 'paragraph': {
          const plain = inlineText(block.children);
          const rtl = RTL.test(plain);
          out.push(
            new Paragraph({
              spacing: { after: ctx.tight ? 60 : 140, line: 300, lineRule: LineRuleType.AUTO },
              ...paraProps(ctx, rtl),
              children: inline(block.children, ctx.quote ? { color: '4B5563' } : {}, rtl),
            }),
          );
          break;
        }
        case 'quote':
          out.push(...render(block.children, { ...ctx, quote: true }));
          break;
        case 'list':
          out.push(...listOf(block, 0, ctx));
          out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
          break;
        case 'code': {
          const lines = block.value.split('\n');
          out.push(
            new Paragraph({
              spacing: { before: 60, after: 160, line: 260, lineRule: LineRuleType.AUTO },
              indent: { left: ctx.indent + 120, right: 120 },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D5DB', space: 6 } },
              children: lines.map((line, index) => new TextRun({ text: line, font: 'Consolas', size: 19, break: index > 0 ? 1 : undefined })),
            }),
          );
          break;
        }
        case 'math':
          out.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 80, after: 160 },
              children: block.value.split('\n').map((line, index) => new TextRun({ text: line, italics: true, font: 'Cambria Math', break: index > 0 ? 1 : undefined })),
            }),
          );
          break;
        case 'table':
          out.push(tableOf(block, ctx));
          out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
          break;
        case 'hr':
          out.push(new Paragraph({ thematicBreak: true, spacing: { before: 120, after: 160 }, children: [] }));
          break;
      }
    }
    return out;
  }

  const body = render(blocks, { indent: 0, quote: false, tight: false });
  if (body.length === 0) body.push(new Paragraph({ children: [new TextRun({ text: 'This note is empty.', italics: true, color: '6B7280' })] }));

  // ───────── numbering ─────────
  const BULLETS = ['\u2022', '\u25E6', '\u25AA'];
  const ORDERED = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const levels = (make: (level: number) => import('docx').ILevelsOptions) => Array.from({ length: 9 }, (_, level) => make(level));
  const indentFor = (level: number) => ({ left: (level + 1) * 540, hanging: 300 });
  const numbering = {
    config: [
      { reference: 'bullets', levels: levels((level) => ({ level, format: LevelFormat.BULLET, text: BULLETS[level % 3], alignment: AlignmentType.LEFT, style: { paragraph: { indent: indentFor(level) } } })) },
      { reference: 'tasks', levels: levels((level) => ({ level, format: LevelFormat.NONE, text: '', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: (level + 1) * 540, hanging: 0 } } } })) },
      ...orderedLists.map(({ reference, start }) => ({
        reference,
        levels: levels((level) => ({
          level,
          format: ORDERED[level % 3],
          text: `%${level + 1}.`,
          start: level === 0 ? start : 1,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: indentFor(level) } },
        })),
      })),
    ],
  };

  const title = noteDisplayTitle(source.title);
  const doc = new Document({
    creator: 'Annotate Studio',
    title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      characterStyles: [{ id: 'Hyperlink', name: 'Hyperlink', basedOn: 'DefaultParagraphFont', run: { color: '0563C1', underline: {} } }],
      paragraphStyles: [
        { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 40, bold: true, color: '111827' }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
        { id: 'Heading2', name: 'heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: '111827' }, paragraph: { spacing: { before: 300, after: 100 }, keepNext: true } },
        { id: 'Heading3', name: 'heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 27, bold: true, color: '1F2937' }, paragraph: { spacing: { before: 260, after: 80 }, keepNext: true } },
        { id: 'Heading4', name: 'heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: '1F2937' }, paragraph: { spacing: { before: 220, after: 60 }, keepNext: true } },
        { id: 'Heading5', name: 'heading 5', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: '374151' }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
        { id: 'Heading6', name: 'heading 6', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: '6B7280' }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
      ],
    },
    numbering,
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${title}   \u00B7   `, size: 16, color: '9CA3AF' }),
                  new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '9CA3AF' }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
