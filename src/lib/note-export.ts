import { inlineText, isSafeUrl, parseMarkdown, type Block, type Inline } from './markdown.ts';
import { exportFileStem } from './annotations.ts';

export type NoteFormat = 'md' | 'txt' | 'docx' | 'pdf';

export const NOTE_FORMATS: Record<NoteFormat, { label: string; menuLabel: string; extension: string; mime: string }> = {
  md: { label: 'Markdown', menuLabel: 'Markdown (.md)', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  txt: { label: 'Plain text', menuLabel: 'Plain text (.txt)', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  docx: {
    label: 'Word',
    menuLabel: 'Word (.docx)',
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  pdf: { label: 'PDF', menuLabel: 'PDF (.pdf)', extension: 'pdf', mime: 'application/pdf' },
};

export const NOTE_FORMAT_ORDER: NoteFormat[] = ['md', 'txt', 'docx', 'pdf'];

export interface NoteSource {
  /** File name or display title of the note. */
  title: string;
  markdown: string;
  exportedAt: Date;
}

/** An image ready to be embedded in a Word or PDF document. */
export interface ResolvedImage {
  bytes: Uint8Array;
  type: 'png' | 'jpg';
  /** Pixel size. */
  width: number;
  height: number;
}

export type ImageResolver = (src: string) => Promise<ResolvedImage | null>;

export function noteFileStem(title: string): string {
  return exportFileStem(title.replace(/\.(md|markdown|txt)$/i, ''));
}

export function noteFileName(title: string, format: NoteFormat): string {
  return `${noteFileStem(title)}.${NOTE_FORMATS[format].extension}`;
}

export function noteDisplayTitle(title: string): string {
  return title.replace(/\.(md|markdown|txt)$/i, '').trim() || 'Note';
}

/**
 * Notes may start with a YAML front-matter block (--- ... ---). It is metadata, not content,
 * so Word, PDF and plain-text exports leave it out. The Markdown export keeps the file as-is.
 */
export function stripFrontMatter(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return text;
  const firstLine = match[1].split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  if (!/^[A-Za-z0-9_-]+[ \t]*:/.test(firstLine)) return text;
  return text.slice(match[0].length).replace(/^\s*\n/, '');
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ───────── plain text ─────────

function inlineToText(nodes: Inline[]): string {
  return nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'strong':
        case 'em':
        case 'del':
          return inlineToText(node.children);
        case 'code':
          return node.value;
        case 'math':
          return node.display ? `$$${node.value}$$` : `$${node.value}$`;
        case 'link': {
          const label = inlineToText(node.children);
          if (!isSafeUrl(node.href) || label === node.href || label === '') return label || node.href;
          return `${label} (${node.href})`;
        }
        case 'image':
          return `[Image: ${node.alt || node.src}]`;
        case 'wikilink':
          return node.label;
        case 'break':
          return '\n';
      }
    })
    .join('');
}

function indentLines(lines: string[], first: string, rest: string): string[] {
  return lines.map((line, index) => (index === 0 ? first + line : line === '' ? '' : rest + line));
}

function pad(text: string, width: number, align: 'left' | 'center' | 'right' | null): string {
  const gap = Math.max(0, width - [...text].length);
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2));
  return text + ' '.repeat(gap);
}

function tableToLines(block: Extract<Block, { type: 'table' }>): string[] {
  const rows = [block.header, ...block.rows].map((row) => row.map((cell) => inlineToText(cell).replace(/\n/g, ' ')));
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(3, ...rows.map((row) => [...(row[c] ?? '')].length)));
  const render = (row: string[]) =>
    widths
      .map((width, c) => pad(row[c] ?? '', width, block.align[c] ?? null))
      .join(' | ')
      .trimEnd();
  const rule = widths.map((width) => '-'.repeat(width)).join('-+-');
  return [render(rows[0]), rule, ...rows.slice(1).map(render)];
}

function blocksToLines(blocks: Block[], tight = false): string[] {
  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0 && !tight) out.push('');
    switch (block.type) {
      case 'heading': {
        const text = inlineToText(block.children).replace(/\n/g, ' ');
        out.push(text);
        if (block.level === 1) out.push('='.repeat(Math.max(3, [...text].length)));
        else if (block.level === 2) out.push('-'.repeat(Math.max(3, [...text].length)));
        break;
      }
      case 'paragraph':
        out.push(...inlineToText(block.children).split('\n'));
        break;
      case 'code':
        out.push(...block.value.split('\n').map((line) => (line ? `    ${line}` : '')));
        break;
      case 'math':
        out.push('$$', ...block.value.split('\n'), '$$');
        break;
      case 'quote':
        out.push(...blocksToLines(block.children).map((line) => (line ? `> ${line}` : '>')));
        break;
      case 'list':
        block.items.forEach((item, itemIndex) => {
          if (itemIndex > 0 && !block.tight) out.push('');
          const marker = block.ordered ? `${block.start + itemIndex}. ` : '- ';
          const task = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
          const inner = blocksToLines(item.children, block.tight);
          const lead = marker + task;
          out.push(...indentLines(inner.length ? inner : [''], lead, ' '.repeat(marker.length)));
        });
        break;
      case 'table':
        out.push(...tableToLines(block));
        break;
      case 'hr':
        out.push('-'.repeat(40));
        break;
    }
  });
  return out;
}

/** Readable plain text: no Markdown symbols, tables aligned, links followed by their address. */
export function noteToText(markdown: string): string {
  const blocks = parseMarkdown(normalizeNewlines(stripFrontMatter(markdown)));
  const text = blocksToLines(blocks).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return text ? `${text}\n` : '';
}

/** The Markdown export is the note exactly as written, with consistent line endings. */
export function noteToMarkdown(markdown: string): string {
  const text = normalizeNewlines(markdown.replace(/^\uFEFF/, ''));
  return text.endsWith('\n') || text === '' ? text : `${text}\n`;
}

// ───────── helpers shared by the Word and PDF renderers ─────────

/** Every image source referenced by the note. */
export function collectImageSources(blocks: Block[]): string[] {
  const found = new Set<string>();
  const inline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'image') found.add(node.src);
      else if ('children' in node) inline(node.children);
    }
  };
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'heading' || block.type === 'paragraph') inline(block.children);
      else if (block.type === 'quote') walk(block.children);
      else if (block.type === 'list') block.items.forEach((item) => walk(item.children));
      else if (block.type === 'table') {
        block.header.forEach(inline);
        block.rows.forEach((row) => row.forEach(inline));
      }
    }
  };
  walk(blocks);
  return [...found];
}

export async function resolveImages(blocks: Block[], resolve: ImageResolver): Promise<Map<string, ResolvedImage>> {
  const resolved = new Map<string, ResolvedImage>();
  for (const src of collectImageSources(blocks)) {
    try {
      const image = await resolve(src);
      if (image) resolved.set(src, image);
    } catch {
      // A missing or unreadable image falls back to its alt text.
    }
  }
  return resolved;
}

/** Fit an image inside a box without enlarging it. */
export function fitImage(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export { inlineText };
