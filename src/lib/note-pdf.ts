import type { PDFImage, PDFPage, RGB } from 'pdf-lib';
import { isSafeUrl, parseMarkdown, type Block, type Inline } from './markdown.ts';
import { collectCodePoints, drawRun, measure, prepareTypesetter, toRuns, wrapText, type FontLoader, type TextStyle, type Typesetter } from './pdf-typeset.ts';
import { inlineText, noteDisplayTitle, normalizeNewlines, resolveImages, stripFrontMatter, type ImageResolver, type NoteSource, type ResolvedImage } from './note-export.ts';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 56;
const TOP = PAGE_H - M;
const BOTTOM = 66;
const BODY = 11;
const LEAD = 1.55;
const HEADING_SIZE = [22, 18, 15, 13, 11.5, 11];

interface Atom {
  text: string;
  style: TextStyle;
  color?: string;
  link?: string;
  strike?: boolean;
  code?: boolean;
  space?: boolean;
  br?: boolean;
}

interface Base {
  style: TextStyle;
  color?: string;
  link?: string;
  strike?: boolean;
}

interface Placed {
  atom: Atom;
  width: number;
  size: number;
}

interface Ctx {
  x: number;
  width: number;
  tight: boolean;
  color: string;
}

function flatten(nodes: Inline[], base: Base, out: Atom[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        for (const part of node.value.split(/(\s+)/)) {
          if (part === '') continue;
          if (/^\s+$/.test(part)) out.push({ ...base, text: ' ', space: true });
          else out.push({ ...base, text: part });
        }
        break;
      case 'strong':
        flatten(node.children, { ...base, style: { ...base.style, bold: true } }, out);
        break;
      case 'em':
        flatten(node.children, { ...base, style: { ...base.style, italic: true } }, out);
        break;
      case 'del':
        flatten(node.children, { ...base, strike: true }, out);
        break;
      case 'code':
      case 'math': {
        const code = node.type === 'code';
        for (const part of node.value.split(/(\s+)/)) {
          if (part === '') continue;
          const space = /^\s+$/.test(part);
          out.push({ ...base, style: { ...base.style, mono: true }, text: space ? ' ' : part, space, code, color: code ? base.color : '#6d28d9' });
        }
        break;
      }
      case 'link': {
        const usable = isSafeUrl(node.href) && /^(https?:|mailto:)/i.test(node.href) && /^[\x20-\x7e]+$/.test(node.href);
        flatten(node.children, usable ? { ...base, link: node.href, color: '#2563eb' } : base, out);
        break;
      }
      case 'wikilink':
        flatten([{ type: 'text', value: node.label }], { ...base, color: '#6d28d9' }, out);
        break;
      case 'image':
        flatten([{ type: 'text', value: `[Image: ${node.alt || node.src}]` }], { ...base, style: { ...base.style, italic: true }, color: '#6b7280' }, out);
        break;
      case 'break':
        out.push({ ...base, text: '', br: true });
        break;
    }
  }
}

export async function buildNotePdf(source: NoteSource, loadFont: FontLoader, resolveImage: ImageResolver): Promise<{ bytes: Uint8Array; replacedChars: number }> {
  const lib = await import('pdf-lib');
  const { PDFDocument, PDFString, rgb } = lib;
  const pdf = await PDFDocument.create();

  const blocks = parseMarkdown(normalizeNewlines(stripFrontMatter(source.markdown)));
  const images = await resolveImages(blocks, resolveImage);
  const embedded = new Map<string, { image: PDFImage; source: ResolvedImage }>();
  for (const [src, image] of images) {
    try {
      const pdfImage = image.type === 'png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
      embedded.set(src, { image: pdfImage, source: image });
    } catch {
      // Unembeddable images fall back to their alt text.
    }
  }

  // Which characters appear, and which appear in code, decides which fonts get embedded.
  const all: string[] = [noteDisplayTitle(source.title), 'Image 0123456789 / .'];
  const mono: string[] = [];
  const scan = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'text') all.push(node.value);
      else if (node.type === 'code' || node.type === 'math') {
        all.push(node.value);
        mono.push(node.value);
      } else if (node.type === 'wikilink') all.push(node.label);
      else if (node.type === 'image') all.push(`[Image: ${node.alt || node.src}]`);
      else if ('children' in node) scan(node.children);
    }
  };
  const scanBlocks = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'heading' || block.type === 'paragraph') scan(block.children);
      else if (block.type === 'code' || block.type === 'math') {
        all.push(block.value);
        mono.push(block.value);
      } else if (block.type === 'quote') scanBlocks(block.children);
      else if (block.type === 'list') block.items.forEach((item) => scanBlocks(item.children));
      else if (block.type === 'table') {
        block.header.forEach(scan);
        block.rows.forEach((row) => row.forEach(scan));
      }
    }
  };
  scanBlocks(blocks);
  const type: Typesetter = await prepareTypesetter(pdf, loadFont, collectCodePoints(all), {
    italic: true,
    monoNeeded: mono.length > 0 ? collectCodePoints(mono) : undefined,
  });

  const hex = (value: string): RGB => {
    const h = value.replace('#', '');
    return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  };
  const INK = '#111827';
  const BODY_COLOR = '#1f2937';
  const MUTED = '#6b7280';
  const RULE = '#d1d5db';
  const CODE_BG = hex('#f3f4f6');

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = TOP;
  const bars: { x: number; startY: number }[] = [];

  const drawBar = (x: number, from: number, to: number) => {
    if (from - to > 0.5) page.drawRectangle({ x, y: to, width: 2.5, height: from - to, color: hex('#9ca3af') });
  };
  const newPage = () => {
    for (const bar of bars) drawBar(bar.x, bar.startY, BOTTOM - 6);
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = TOP;
    for (const bar of bars) bar.startY = TOP;
  };
  const ensure = (height: number) => {
    if (y - height < BOTTOM && y < TOP) newPage();
  };

  const addLink = (x: number, baseline: number, width: number, size: number, url: string) => {
    const annotation = pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, baseline - 3, x + width, baseline + size],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    });
    page.node.addAnnot(pdf.context.register(annotation));
  };

  const drawText = (value: string, x: number, baseline: number, size: number, style: TextStyle, color: RGB): number => {
    let cursor = x;
    for (const run of toRuns(type, value, style)) cursor += drawRun(page, type, run, cursor, baseline, size, color);
    return cursor - x;
  };

  // ───────── inline layout ─────────
  const atomSize = (atom: Atom, size: number) => (atom.code ? size * 0.9 : size);
  const atomWidth = (atom: Atom, size: number) => measure(type, atom.text, atomSize(atom, size), atom.style) + (atom.code ? 3 : 0);

  function layout(atoms: Atom[], size: number, maxWidth: number): Placed[][] {
    const lines: Placed[][] = [[]];
    let used = 0;
    const current = () => lines[lines.length - 1];
    const trim = () => {
      const line = current();
      while (line.length > 0 && line[line.length - 1].atom.space && !line[line.length - 1].atom.code) line.pop();
    };
    const breakLine = () => {
      trim();
      lines.push([]);
      used = 0;
    };
    for (const atom of atoms) {
      if (atom.br) {
        breakLine();
        continue;
      }
      const width = atomWidth(atom, size);
      if (atom.space) {
        if (current().length > 0) {
          current().push({ atom, width, size: atomSize(atom, size) });
          used += width;
        }
        continue;
      }
      if (used + width <= maxWidth) {
        current().push({ atom, width, size: atomSize(atom, size) });
        used += width;
        continue;
      }
      if (current().length > 0) breakLine();
      if (width <= maxWidth) {
        current().push({ atom, width, size: atomSize(atom, size) });
        used = width;
        continue;
      }
      for (const char of atom.text) {
        const piece: Atom = { ...atom, text: char };
        const pieceWidth = atomWidth(piece, size);
        if (used + pieceWidth > maxWidth && current().length > 0) breakLine();
        current().push({ atom: piece, width: pieceWidth, size: atomSize(piece, size) });
        used += pieceWidth;
      }
    }
    trim();
    while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
    return lines.filter((line, index) => line.length > 0 || index < lines.length - 1 || lines.length === 1);
  }

  function drawLine(line: Placed[], x: number, top: number, size: number, maxWidth: number, color: string, align: 'left' | 'center' | 'right' = 'left') {
    const total = line.reduce((sum, item) => sum + item.width, 0);
    let cursor = x + (align === 'center' ? (maxWidth - total) / 2 : align === 'right' ? maxWidth - total : 0);
    const baseline = top - size;
    // One clickable region per link per line, however many words it spans.
    let link: { url: string; from: number; fontSize: number } | null = null;
    const closeLink = (end: number) => {
      if (link) addLink(link.from, baseline, Math.max(1, end - link.from), link.fontSize, link.url);
      link = null;
    };
    for (const { atom, width, size: fontSize } of line) {
      if (atom.code) page.drawRectangle({ x: cursor, y: baseline - fontSize * 0.28, width, height: fontSize * 1.3, color: CODE_BG });
      if (!atom.space || atom.code) drawText(atom.text, cursor + (atom.code ? 1.5 : 0), baseline, fontSize, atom.style, hex(atom.color ?? color));
      if (atom.strike) page.drawLine({ start: { x: cursor, y: baseline + fontSize * 0.3 }, end: { x: cursor + width, y: baseline + fontSize * 0.3 }, thickness: 0.7, color: hex(atom.color ?? color) });
      if (atom.link) {
        page.drawLine({ start: { x: cursor, y: baseline - 1.5 }, end: { x: cursor + width, y: baseline - 1.5 }, thickness: 0.5, color: hex('#2563eb') });
        if (link && link.url !== atom.link) closeLink(cursor);
        if (!link) link = { url: atom.link, from: cursor, fontSize };
      } else {
        closeLink(cursor);
      }
      cursor += width;
    }
    closeLink(cursor);
  }

  interface TextOptions {
    size: number;
    x: number;
    width: number;
    color: string;
    lead?: number;
    align?: 'left' | 'center' | 'right';
    before?: number;
    after?: number;
    keepWithNext?: number;
  }

  function textBlock(atoms: Atom[], o: TextOptions) {
    const lines = layout(atoms, o.size, o.width);
    if (lines.length === 0 || lines.every((line) => line.length === 0)) return;
    const lh = o.size * (o.lead ?? LEAD);
    if (o.before && y < TOP) y -= o.before;
    lines.forEach((line, index) => {
      ensure(lh + (index === 0 ? (o.keepWithNext ?? 0) : 0));
      drawLine(line, o.x, y, o.size, o.width, o.color, o.align);
      y -= lh;
    });
    y -= o.after ?? 0;
  }

  const atomsOf = (nodes: Inline[], style: TextStyle = {}): Atom[] => {
    const out: Atom[] = [];
    flatten(nodes, { style }, out);
    return out;
  };

  // ───────── blocks ─────────
  function imageBlock(item: { image: PDFImage; source: ResolvedImage }, ctx: Ctx) {
    const natural = { width: item.source.width * 0.75, height: item.source.height * 0.75 };
    const scale = Math.min(1, ctx.width / natural.width, 460 / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    ensure(height + 8);
    page.drawImage(item.image, { x: ctx.x, y: y - height, width, height });
    y -= height + 10;
  }

  function paragraph(nodes: Inline[], ctx: Ctx) {
    let pending: Inline[] = [];
    const flush = () => {
      const plain = inlineText(pending).trim();
      if (plain || pending.some((node) => node.type === 'image')) {
        textBlock(atomsOf(pending), { size: BODY, x: ctx.x, width: ctx.width, color: ctx.color, after: ctx.tight ? 2 : 7 });
      }
      pending = [];
    };
    for (const node of nodes) {
      const found = node.type === 'image' ? embedded.get(node.src) : undefined;
      if (found) {
        flush();
        imageBlock(found, ctx);
      } else pending.push(node);
    }
    flush();
  }

  function drawMarker(kind: 'bullet' | 'ordered' | 'task', depth: number, label: string, checked: boolean, x: number, top: number) {
    const baseline = top - BODY;
    const cy = baseline + BODY * 0.32;
    if (kind === 'ordered') {
      drawText(label, x, baseline, BODY, {}, hex(MUTED));
    } else if (kind === 'task') {
      page.drawRectangle({ x: x + 1, y: baseline - 1.5, width: 9, height: 9, color: checked ? hex('#16a34a') : hex('#ffffff'), borderColor: checked ? hex('#16a34a') : hex('#9ca3af'), borderWidth: 0.9 });
      if (checked) {
        page.drawLine({ start: { x: x + 3, y: baseline + 3 }, end: { x: x + 5.2, y: baseline + 0.8 }, thickness: 1.2, color: hex('#ffffff') });
        page.drawLine({ start: { x: x + 5.2, y: baseline + 0.8 }, end: { x: x + 9, y: baseline + 6 }, thickness: 1.2, color: hex('#ffffff') });
      }
    } else if (depth % 3 === 0) {
      page.drawCircle({ x: x + 4, y: cy, size: 2.2, color: hex(BODY_COLOR) });
    } else if (depth % 3 === 1) {
      page.drawCircle({ x: x + 4, y: cy, size: 2.2, color: hex('#ffffff'), borderColor: hex(BODY_COLOR), borderWidth: 0.9 });
    } else {
      page.drawRectangle({ x: x + 2, y: cy - 2, width: 4, height: 4, color: hex(BODY_COLOR) });
    }
  }

  function list(block: Extract<Block, { type: 'list' }>, ctx: Ctx, depth: number) {
    const last = block.start + block.items.length - 1;
    const indent = block.ordered ? Math.max(18, measure(type, `${Math.max(last, block.start)}.`, BODY) + 9) : 16;
    block.items.forEach((item, index) => {
      ensure(BODY * LEAD);
      const task = item.checked !== null;
      drawMarker(task ? 'task' : block.ordered ? 'ordered' : 'bullet', depth, `${block.start + index}.`, item.checked === true, ctx.x + (task ? 0 : 0), y);
      const inner: Ctx = { ...ctx, x: ctx.x + indent + (task ? 4 : 0), width: ctx.width - indent - (task ? 4 : 0), tight: true, color: item.checked ? MUTED : ctx.color };
      render(item.children, inner, depth + 1);
      if (!block.tight) y -= 4;
    });
    y -= ctx.tight ? 1 : 5;
  }

  function quote(block: Extract<Block, { type: 'quote' }>, ctx: Ctx, depth: number) {
    const bar = { x: ctx.x + 2, startY: y };
    bars.push(bar);
    render(block.children, { ...ctx, x: ctx.x + 14, width: ctx.width - 14, color: '#4b5563' }, depth);
    bars.pop();
    drawBar(bar.x, bar.startY, y + 6);
  }

  function codeBlock(value: string, ctx: Ctx) {
    const size = 9.5;
    const lh = size * 1.45;
    const charWidth = measure(type, 'M', size, { mono: true }) || size * 0.6;
    const columns = Math.max(8, Math.floor((ctx.width - 20) / charWidth));
    const lines: string[] = [];
    for (const raw of value.replace(/\t/g, '    ').split('\n')) {
      const chars = [...raw];
      if (chars.length === 0) lines.push('');
      for (let at = 0; at < chars.length; at += columns) lines.push(chars.slice(at, at + columns).join(''));
    }
    let index = 0;
    while (index < lines.length) {
      if (y - (lh + 12) < BOTTOM) newPage();
      const fit = Math.max(1, Math.floor((y - BOTTOM - 12) / lh));
      const chunk = lines.slice(index, index + fit);
      const height = chunk.length * lh + 12;
      page.drawRectangle({ x: ctx.x, y: y - height, width: ctx.width, height, color: CODE_BG });
      chunk.forEach((line, i) => drawText(line, ctx.x + 10, y - 6 - i * lh - size, size, { mono: true }, hex(BODY_COLOR)));
      y -= height;
      index += chunk.length;
      if (index < lines.length) newPage();
    }
    y -= 9;
  }

  function table(block: Extract<Block, { type: 'table' }>, ctx: Ctx) {
    const size = 9.5;
    const lh = size * 1.45;
    const pad = 5;
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
    const plain = (cells: Inline[][], c: number) => inlineText(cells[c] ?? []).length;
    const weights = Array.from({ length: columns }, (_, c) => Math.min(40, Math.max(5, plain(block.header, c), ...block.rows.map((row) => plain(row, c)))));
    const total = weights.reduce((a, b) => a + b, 0);
    const minimum = 36;
    let widths = weights.map((weight) => Math.max(minimum, (weight / total) * ctx.width));
    const scale = ctx.width / widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => w * scale);

    const prepare = (cells: Inline[][], header: boolean) =>
      Array.from({ length: columns }, (_, c) => layout(atomsOf(cells[c] ?? [], header ? { bold: true } : {}), size, widths[c] - pad * 2));
    const drawRow = (cells: Placed[][][], header: boolean) => {
      const height = Math.max(1, ...cells.map((lines) => lines.length)) * lh + pad * 2;
      if (y - height < BOTTOM) newPage();
      const top = y;
      let x = ctx.x;
      if (header) page.drawRectangle({ x, y: top - height, width: ctx.width, height, color: hex('#f3f4f6') });
      cells.forEach((lines, c) => {
        lines.forEach((line, i) => drawLine(line, x + pad, top - pad - i * lh, size, widths[c] - pad * 2, header ? INK : BODY_COLOR, (block.align[c] ?? 'left') as 'left' | 'center' | 'right'));
        x += widths[c];
      });
      const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: hex(RULE) });
      line(ctx.x, top, ctx.x + ctx.width, top);
      line(ctx.x, top - height, ctx.x + ctx.width, top - height);
      let edge = ctx.x;
      for (let c = 0; c <= columns; c += 1) {
        line(edge, top, edge, top - height);
        edge += widths[c] ?? 0;
      }
      y -= height;
    };

    const headerCells = prepare(block.header, true);
    ensure(lh * 3);
    drawRow(headerCells, true);
    for (const row of block.rows) {
      const cells = prepare(row, false);
      const height = Math.max(1, ...cells.map((lines) => lines.length)) * lh + pad * 2;
      if (y - height < BOTTOM) {
        newPage();
        drawRow(headerCells, true);
      }
      drawRow(cells, false);
    }
    y -= 10;
  }

  function render(list_: Block[], ctx: Ctx, depth: number) {
    for (const block of list_) {
      switch (block.type) {
        case 'heading': {
          const level = block.level;
          const size = HEADING_SIZE[level - 1];
          textBlock(atomsOf(block.children, { bold: true }), {
            size,
            x: ctx.x,
            width: ctx.width,
            color: level === 6 ? MUTED : INK,
            lead: 1.3,
            before: level <= 2 ? 16 : 11,
            after: level <= 2 ? 4 : 3,
            keepWithNext: BODY * LEAD * 2,
          });
          if (level <= 2) {
            page.drawLine({ start: { x: ctx.x, y: y + 1 }, end: { x: ctx.x + ctx.width, y: y + 1 }, thickness: 0.6, color: hex(RULE) });
            y -= 6;
          }
          break;
        }
        case 'paragraph':
          paragraph(block.children, ctx);
          break;
        case 'quote':
          quote(block, ctx, depth);
          break;
        case 'list':
          list(block, ctx, depth);
          break;
        case 'code':
          codeBlock(block.value, ctx);
          break;
        case 'math':
          ensure(BODY * 2);
          for (const line of wrapText(type, block.value, 10.5, { mono: true }, ctx.width - 20)) {
            ensure(BODY * 1.6);
            const width = measure(type, line, 10.5, { mono: true });
            drawText(line, ctx.x + (ctx.width - width) / 2, y - 10.5, 10.5, { mono: true }, hex('#6d28d9'));
            y -= BODY * 1.6;
          }
          y -= 8;
          break;
        case 'table':
          table(block, ctx);
          break;
        case 'hr':
          ensure(20);
          page.drawLine({ start: { x: ctx.x, y: y - 6 }, end: { x: ctx.x + ctx.width, y: y - 6 }, thickness: 0.8, color: hex(RULE) });
          y -= 16;
          break;
      }
    }
  }

  if (blocks.length === 0) {
    textBlock(atomsOf([{ type: 'text', value: 'This note is empty.' }], { italic: true }), { size: BODY, x: M, width: PAGE_W - 2 * M, color: MUTED });
  } else {
    render(blocks, { x: M, width: PAGE_W - 2 * M, tight: false, color: BODY_COLOR }, 0);
  }

  // Footer: note title on the left, page number on the right.
  const title = noteDisplayTitle(source.title);
  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    page = p;
    const label = `${index + 1} / ${pages.length}`;
    const labelWidth = measure(type, label, 8);
    drawText(label, PAGE_W - M - labelWidth, 30, 8, {}, hex('#9ca3af'));
    let shown = title;
    while (shown.length > 1 && measure(type, shown, 8) > PAGE_W - 2 * M - labelWidth - 20) shown = `${shown.slice(0, -2)}…`;
    drawText(shown, M, 30, 8, {}, hex('#9ca3af'));
  });

  pdf.setTitle(title);
  pdf.setCreator('Annotate Studio');
  pdf.setProducer('Annotate Studio');
  pdf.setCreationDate(source.exportedAt);
  return { bytes: await pdf.save(), replacedChars: type.replaced };
}
