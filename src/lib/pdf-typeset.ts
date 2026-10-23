import type { PDFDocument, PDFFont, PDFOperator, PDFPage, RGB } from 'pdf-lib';

/**
 * Shared PDF text helpers. PDF's built-in fonts only cover Western European text, so we embed
 * Inter (Latin, Latin Extended, Vietnamese, Greek, Cyrillic) and JetBrains Mono for code, and pick
 * a font per character. Characters no font can draw are replaced by "?" and counted.
 */

export type FontLoader = (fileName: string) => Promise<Uint8Array>;

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

type Variant = 'regular' | 'bold' | 'italic' | 'boldItalic';
type ScriptFonts = Partial<Record<Variant, PDFFont>>;

const SANS_SCRIPTS = ['latin', 'latin-ext', 'vietnamese', 'greek', 'cyrillic'] as const;
const MONO_SCRIPTS = ['latin', 'latin-ext'] as const;

const SANS_FILES: Record<Variant, (script: string) => string> = {
  regular: (script) => `inter-${script}-400-normal.woff`,
  bold: (script) => `inter-${script}-700-normal.woff`,
  italic: (script) => `inter-${script}-400-italic.woff`,
  boldItalic: (script) => `inter-${script}-700-italic.woff`,
};

/** The subset of fontkit's Font API used for shaping marks. */
interface KitFont {
  unitsPerEm: number;
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string): {
    glyphs: { codePoints: number[]; path: { scale(x: number, y: number): { toSVG(): string } } }[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}

export interface Typesetter {
  sans: ScriptFonts[];
  sansMap: Map<number, number>;
  /** Every needed code point each embedded sans font can draw (used to keep a letter and its accents together). */
  coverage: Set<number>[];
  /** fontkit instances, used to read the font's own positions for combining marks. */
  kits: Map<PDFFont, KitFont>;
  /** pdf-lib operators needed to draw accented text (loaded with the library). */
  ops: { setTextRenderingMode: (mode: number) => PDFOperator; invisible: number; fill: number };
  mono: ScriptFonts[];
  monoMap: Map<number, number>;
  replaced: number;
}

export interface Run {
  text: string;
  font: PDFFont;
}

export const isSpace = (cp: number) =>
  cp === 0x20 || cp === 0xa0 || cp === 0x09 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x3000;

export const isIgnorable = (cp: number) =>
  cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp === 0x2060 || cp === 0xfeff;

/** Every distinct code point in the given strings, plus printable ASCII. */
export function collectCodePoints(texts: Iterable<string>): Set<number> {
  const all = new Set<number>();
  for (let code = 32; code < 127; code += 1) all.add(code);
  for (const text of texts) for (const char of text.normalize('NFC')) all.add(char.codePointAt(0)!);
  return all;
}

export async function prepareTypesetter(
  pdf: PDFDocument,
  loadFont: FontLoader,
  needed: Set<number>,
  options: { italic?: boolean; monoNeeded?: Set<number> } = {},
): Promise<Typesetter> {
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const lib = await import('pdf-lib');
  pdf.registerFontkit(fontkit);
  const variants: Variant[] = options.italic ? ['regular', 'bold', 'italic', 'boldItalic'] : ['regular', 'bold'];

  const sans: ScriptFonts[] = [];
  const sansMap = new Map<number, number>();
  const coverage: Set<number>[] = [];
  const kits = new Map<PDFFont, KitFont>();
  const remaining = new Set([...needed].filter((cp) => !isIgnorable(cp)));
  for (const script of SANS_SCRIPTS) {
    if (script !== 'latin' && remaining.size === 0) break;
    const regularBytes = await loadFont(SANS_FILES.regular(script));
    const probe = fontkit.create(regularBytes) as unknown as KitFont;
    const covered = [...remaining].filter((cp) => probe.hasGlyphForCodePoint(cp));
    if (script !== 'latin' && covered.length === 0) continue;
    const fonts: ScriptFonts = {};
    for (const variant of variants) {
      const bytes = variant === 'regular' ? regularBytes : await loadFont(SANS_FILES[variant](script));
      fonts[variant] = await pdf.embedFont(bytes, { subset: true });
      kits.set(fonts[variant]!, (variant === 'regular' ? probe : fontkit.create(bytes)) as unknown as KitFont);
    }
    sans.push(fonts);
    coverage.push(new Set([...needed].filter((cp) => probe.hasGlyphForCodePoint(cp))));
    for (const cp of covered) {
      sansMap.set(cp, sans.length - 1);
      remaining.delete(cp);
    }
  }

  const mono: ScriptFonts[] = [];
  const monoMap = new Map<number, number>();
  const monoRemaining = new Set([...(options.monoNeeded ?? [])].filter((cp) => !isIgnorable(cp)));
  for (const script of MONO_SCRIPTS) {
    if (monoRemaining.size === 0) break;
    const bytes = await loadFont(`jetbrains-mono-${script}-400-normal.woff`);
    const probe = fontkit.create(bytes) as unknown as KitFont;
    const covered = [...monoRemaining].filter((cp) => probe.hasGlyphForCodePoint(cp));
    if (covered.length === 0) continue;
    mono.push({ regular: await pdf.embedFont(bytes, { subset: true }) });
    for (const cp of covered) {
      monoMap.set(cp, mono.length - 1);
      monoRemaining.delete(cp);
    }
  }
  return {
    sans,
    sansMap,
    coverage,
    kits,
    ops: { setTextRenderingMode: lib.setTextRenderingMode, invisible: lib.TextRenderingMode.Invisible, fill: lib.TextRenderingMode.Fill },
    mono,
    monoMap,
    replaced: 0,
  };
}

function pickFont(type: Typesetter, cp: number, style: TextStyle): PDFFont | null {
  if (style.mono) {
    const index = type.monoMap.get(cp);
    if (index !== undefined) return type.mono[index].regular!;
  }
  const index = type.sansMap.get(cp);
  if (index === undefined) return null;
  const fonts = type.sans[index];
  const variant = variantOf(style);
  return fonts[variant] ?? (style.bold ? fonts.bold : undefined) ?? fonts.regular!;
}

function variantOf(style: TextStyle): Variant {
  return style.bold && style.italic ? 'boldItalic' : style.bold ? 'bold' : style.italic ? 'italic' : 'regular';
}

/**
 * A letter plus its combining accents (for example Yoruba "ẹ̀") must be drawn by one font,
 * or the accent cannot be positioned over the letter. Returns that font if one covers them all.
 */
function pickClusterFont(type: Typesetter, cps: number[], style: TextStyle): PDFFont | null {
  for (let index = 0; index < type.sans.length; index += 1) {
    if (cps.every((cp) => type.coverage[index].has(cp))) {
      const fonts = type.sans[index];
      return fonts[variantOf(style)] ?? fonts.regular ?? null;
    }
  }
  return null;
}

const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
const HAS_MARK = /\p{M}/u;

/** Split text into runs that each use a single font. Unsupported characters become "?". */
export function toRuns(type: Typesetter, text: string, style: TextStyle = {}, count = true): Run[] {
  const runs: Run[] = [];
  const push = (value: string, font: PDFFont) => {
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += value;
    else runs.push({ text: value, font });
  };
  for (const cluster of text.normalize('NFC').match(CLUSTER) ?? []) {
    const chars = [...cluster];
    if (chars.length > 1 && !style.mono) {
      const cps = chars.map((char) => char.codePointAt(0)!).filter((cp) => !isIgnorable(cp));
      const font = cps.length > 1 ? pickClusterFont(type, cps, style) : null;
      if (font) {
        push(String.fromCodePoint(...cps), font);
        continue;
      }
    }
    for (const char of chars) {
      let cp = char.codePointAt(0)!;
      if (isIgnorable(cp)) continue;
      let out = char;
      if (isSpace(cp)) {
        out = ' ';
        cp = 0x20;
      }
      let font = pickFont(type, cp, style);
      // Keep a space with the letters before it when that font can draw it: fewer font switches, and
      // some PDF readers drop a space that sits alone at the start of a differently-fonted run.
      if (cp === 0x20 && runs.length > 0 && type.kits.get(runs[runs.length - 1].font)?.hasGlyphForCodePoint(0x20)) {
        font = runs[runs.length - 1].font;
      }
      if (!font) {
        out = '?';
        font = pickFont(type, 0x3f, style)!;
        if (count) type.replaced += 1;
      }
      push(out, font);
    }
  }
  return runs;
}

/**
 * Draw one run and return its width.
 *
 * Runs with combining accents (Yoruba "ẹ̀", "ọ́" and the like) need the font's own mark positioning, which PDF text
 * drawing cannot express. So the run is drawn twice: once as invisible text, in one piece and in the right order,
 * so copying, searching and screen readers see the real word; and once as vector outlines placed by the font's
 * positioning data, which is what you see.
 */
export function drawRun(page: PDFPage, type: Typesetter, run: Run, x: number, y: number, size: number, color: RGB): number {
  const kit = type.kits.get(run.font);
  if (!kit || !HAS_MARK.test(run.text)) {
    page.drawText(run.text, { x, y, size, font: run.font, color });
    return run.font.widthOfTextAtSize(run.text, size);
  }
  page.pushOperators(type.ops.setTextRenderingMode(type.ops.invisible));
  page.drawText(run.text, { x, y, size, font: run.font, color });
  page.pushOperators(type.ops.setTextRenderingMode(type.ops.fill));

  const layout = kit.layout(run.text);
  const scale = size / kit.unitsPerEm;
  let pen = x;
  layout.glyphs.forEach((glyph, index) => {
    const position = layout.positions[index];
    const outline = glyph.path.scale(scale, -scale).toSVG();
    if (outline) page.drawSvgPath(outline, { x: pen + position.xOffset * scale, y: y + position.yOffset * scale, color, borderWidth: 0 });
    pen += position.xAdvance * scale;
  });
  return pen - x;
}

export function measure(type: Typesetter, text: string, size: number, style: TextStyle = {}): number {
  return toRuns(type, text, style, false).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
}

export function wrapText(type: Typesetter, text: string, size: number, style: TextStyle, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length > 0);
    let line = '';
    let lineWidth = 0;
    const flush = () => {
      lines.push(line.trimEnd());
      line = '';
      lineWidth = 0;
    };
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (line) {
          line += ' ';
          lineWidth += measure(type, ' ', size, style);
        }
        continue;
      }
      const width = measure(type, token, size, style);
      if (lineWidth + width <= maxWidth) {
        line += token;
        lineWidth += width;
        continue;
      }
      if (line) flush();
      if (width <= maxWidth) {
        line = token;
        lineWidth = width;
        continue;
      }
      // A single word wider than the line (a URL, say): break it by characters.
      for (const char of token) {
        const charWidth = measure(type, char, size, style);
        if (lineWidth + charWidth > maxWidth && line) flush();
        line += char;
        lineWidth += charWidth;
      }
    }
    if (line || tokens.length === 0) flush();
  }
  return lines;
}
