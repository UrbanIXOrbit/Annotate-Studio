import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { buildNoteDocx } from './note-docx.ts';
import { buildNotePdf } from './note-pdf.ts';
import { decodeDataUrl, sniffImage } from './image-sniff.ts';
import { collectCodePoints, prepareTypesetter, toRuns } from './pdf-typeset.ts';
import {
  fitImage,
  noteDisplayTitle,
  noteFileName,
  noteToMarkdown,
  noteToText,
  stripFrontMatter,
  type ImageResolver,
  type ResolvedImage,
} from './note-export.ts';

const loadFont = async (name: string) => new Uint8Array(await readFile(new URL(`../../public/fonts/${name}`, import.meta.url)));
const JPG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAVACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDNoooryT6kKKKKACiiigAooooAKKKKACiiigD/2Q==';
const GIF_B64 = 'R0lGODdhCQAFAIAAAAAAAAAAACwAAAAACQAFAAAIDQABCBxIsKDBgwgTBgQAOw==';

// A real PNG built from scratch, so image handling is tested without any binary files in the repo.
function makePng(width: number, height: number): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set([x % 256, y % 256, 128], y * (width * 3 + 1) + 1 + x * 3);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const png: ResolvedImage = { bytes: makePng(80, 40), type: 'png', width: 80, height: 40 };
const resolveImage: ImageResolver = async (src) => (src === 'figures/chart.png' ? png : null);

const RICH = `---
title: SSC 202
tags: [study]
---
# Lecture 3

Some *italic*, **bold**, ~~strike~~, \`code\`, a [docs link](https://example.org/docs), [[Programme Evaluation]] and \$E=mc^2\$.

## Plan
- First **point**
  - Nested
- [ ] Draft
- [x] Read

3. Third
4. Fourth

> Quoted text
> over two lines

\`\`\`js
const a = 1;
\`\`\`

| Stage | Owner |
|:--|--:|
| Design | Ọmọ |

![Chart](figures/chart.png)

![Gone](nowhere.png)

---

Done.
`;

// ───────── front matter, names, markdown ─────────

test('front matter is stripped only when it looks like metadata', () => {
  assert.equal(stripFrontMatter('---\ntitle: X\n---\n# Hi\n'), '# Hi\n');
  assert.equal(stripFrontMatter('---\r\ntags: [a]\r\n---\r\nBody'), 'Body');
  // A horizontal rule followed by prose is content, not metadata.
  assert.equal(stripFrontMatter('---\nJust a sentence\n---\nBody'), '---\nJust a sentence\n---\nBody');
  assert.equal(stripFrontMatter('# No front matter'), '# No front matter');
});

test('file names and titles drop the note extension and unsafe characters', () => {
  assert.equal(noteFileName('Lecture 3.md', 'docx'), 'Lecture 3.docx');
  assert.equal(noteFileName('Week: 1/2?.markdown', 'pdf'), 'Week 1 2.pdf');
  assert.equal(noteFileName('notes.txt', 'md'), 'notes.md');
  assert.equal(noteDisplayTitle('Lecture 3.md'), 'Lecture 3');
  assert.equal(noteDisplayTitle('.md'), 'Note');
});

test('markdown export keeps the note as written with consistent line endings', () => {
  assert.equal(noteToMarkdown('# A\r\n\r\ntext'), '# A\n\ntext\n');
  assert.equal(noteToMarkdown(''), '');
  assert.equal(noteToMarkdown('\uFEFFkeep'), 'keep\n');
  assert.ok(noteToMarkdown(RICH).startsWith('---\ntitle: SSC 202'));
});

// ───────── plain text ─────────

test('plain text export removes markup but keeps the structure readable', () => {
  const text = noteToText(RICH);
  assert.ok(!text.includes('tags:'), 'front matter removed');
  assert.match(text, /^Lecture 3\n=+\n/);
  assert.match(text, /Plan\n-+\n/);
  assert.match(text, /Some italic, bold, strike, code, a docs link \(https:\/\/example\.org\/docs\), Programme Evaluation and \$E=mc\^2\$\./);
  assert.match(text, /- First point\n {2}- Nested\n- \[ \] Draft\n- \[x\] Read\n/);
  assert.match(text, /3\. Third\n4\. Fourth/);
  // Single line breaks inside a paragraph are spaces in Markdown, exactly as the preview shows them.
  assert.match(text, /> Quoted text over two lines/);
  assert.match(text, /\n {4}const a = 1;\n/);
  assert.match(text, /Stage +\| +Owner\n-+-\+-+\nDesign +\| +Ọmọ/);
  assert.match(text, /\[Image: Chart\]/);
  assert.match(text, /-{20,}\n\nDone\.\n$/);
  assert.ok(!/[*~`]/.test(text.replace(/\$[^$]*\$/g, '')), 'no leftover markdown symbols');
});

test('plain text export of an empty note is empty', () => {
  assert.equal(noteToText(''), '');
  assert.equal(noteToText('---\ntitle: x\n---\n'), '');
});

// ───────── Word ─────────

test('docx export keeps structure: headings, lists, table, link, image, code, footer', async () => {
  const zip = await JSZip.loadAsync(await buildNoteDocx({ title: 'Lecture 3.md', markdown: RICH, exportedAt: new Date() }, resolveImage));
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.ok(xml.includes('w:val="Heading1"') && xml.includes('w:val="Heading2"'));
  assert.ok(xml.includes('Lecture 3') && xml.includes('Programme Evaluation'));
  assert.ok(!xml.includes('tags: [study]'), 'front matter removed');
  assert.ok(xml.includes('<w:tbl>') && xml.includes('Ọmọ'));
  assert.ok(xml.includes('<w:hyperlink'), 'external link');
  assert.ok(xml.includes('<w:drawing>'), 'embedded image');
  assert.ok(Object.keys(zip.files).some((name) => name.startsWith('word/media/')), 'image stored in the package');
  assert.ok(xml.includes('[Image: Gone]'), 'unresolvable image becomes alt text');
  assert.ok(xml.includes('Consolas') && xml.includes('const a = 1;'));
  assert.ok(xml.includes('w:strike'), 'strikethrough');
  assert.ok(xml.includes('\u2610') && xml.includes('\u2611'), 'task checkboxes');
  const numbering = await zip.file('word/numbering.xml')!.async('string');
  assert.ok(/w:start w:val="3"/.test(numbering), 'ordered list keeps its starting number');
  assert.ok(Object.keys(zip.files).some((name) => name.startsWith('word/footer')));
});

test('docx export marks right-to-left paragraphs and survives empty notes', async () => {
  const rtl = await JSZip.loadAsync(await buildNoteDocx({ title: 'a', markdown: 'مرحبا بالعالم', exportedAt: new Date() }, resolveImage));
  assert.ok((await rtl.file('word/document.xml')!.async('string')).includes('<w:bidi'));
  const empty = await JSZip.loadAsync(await buildNoteDocx({ title: 'a', markdown: '', exportedAt: new Date() }, resolveImage));
  assert.ok((await empty.file('word/document.xml')!.async('string')).includes('This note is empty'));
});

// ───────── PDF ─────────

test('pdf export of a rich note is a valid document with its title', async () => {
  const { bytes, replacedChars } = await buildNotePdf({ title: 'Lecture 3.md', markdown: RICH, exportedAt: new Date() }, loadFont, resolveImage);
  assert.equal(replacedChars, 0);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(doc.getTitle(), 'Lecture 3');
  assert.ok(new TextDecoder('latin1').decode(bytes.slice(0, 5)) === '%PDF-');
});

test('pdf export flows long content across pages: paragraphs, code and tables', async () => {
  const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: ${'lorem ipsum dolor sit amet '.repeat(12)}`).join('\n\n');
  const code = '```\n' + Array.from({ length: 150 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') + '\n```';
  const table = '| A | B |\n|--|--|\n' + Array.from({ length: 90 }, (_, i) => `| row ${i} | ${'cell text '.repeat(6)} |`).join('\n');
  for (const markdown of [paragraphs, code, table]) {
    const { bytes } = await buildNotePdf({ title: 'Long', markdown, exportedAt: new Date() }, loadFont, resolveImage);
    assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 3);
  }
});

test('pdf export copes with an empty note, a huge word and unsupported scripts', async () => {
  const empty = await buildNotePdf({ title: 'E', markdown: '', exportedAt: new Date() }, loadFont, resolveImage);
  assert.equal((await PDFDocument.load(empty.bytes)).getPageCount(), 1);
  const wide = await buildNotePdf({ title: 'W', markdown: 'https://example.org/' + 'abcdefghij'.repeat(60), exportedAt: new Date() }, loadFont, resolveImage);
  assert.ok((await PDFDocument.load(wide.bytes)).getPageCount() >= 1);
  const cjk = await buildNotePdf({ title: 'C', markdown: 'English 日本語 text', exportedAt: new Date() }, loadFont, resolveImage);
  assert.equal(cjk.replacedChars, 3);
});

test('pdf export draws Yoruba, Vietnamese, Greek and Cyrillic without substitution', async () => {
  const markdown = '**Ọmọ Ìbàdàn** ṣe ẹ̀bùn ọ́mọ. *Việt Nam đẹp.* Ελλάδα. Привет мир. `ẹ̀bùn`';
  const { replacedChars } = await buildNotePdf({ title: 'U', markdown, exportedAt: new Date() }, loadFont, resolveImage);
  assert.equal(replacedChars, 0);
});

test('a letter and its combining accent are always drawn by the same font', async () => {
  const pdf = await PDFDocument.create();
  const text = 'ẹ̀bùn ọ́mọ Ẹ́';
  const type = await prepareTypesetter(pdf, loadFont, collectCodePoints([text]), {});
  const runs = toRuns(type, text, {});
  const withMarks = runs.filter((run) => /\p{M}/u.test(run.text));
  assert.ok(withMarks.length > 0);
  for (const run of withMarks) {
    // Each run containing an accent also contains the letter it sits on.
    assert.ok(/[\p{L}]\p{M}/u.test(run.text), `accent separated from its letter in "${run.text}"`);
  }
  assert.equal(type.replaced, 0);
});

// ───────── images ─────────

test('image headers are read without decoding', () => {
  assert.deepEqual(sniffImage(makePng(123, 45)), { type: 'png', width: 123, height: 45 });
  assert.deepEqual(sniffImage(Uint8Array.from(Buffer.from(JPG_B64, 'base64'))), { type: 'jpg', width: 37, height: 21 });
  assert.deepEqual(sniffImage(Uint8Array.from(Buffer.from(GIF_B64, 'base64'))), { type: 'gif', width: 9, height: 5 });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10"></svg>'))?.type, 'svg');
  assert.equal(sniffImage(new TextEncoder().encode('hello world, not an image')), null);
  assert.equal(sniffImage(new Uint8Array(3)), null);
});

test('data URLs decode as base64 or percent-encoded text', () => {
  assert.deepEqual([...decodeDataUrl('data:text/plain;base64,aGk=')!], [104, 105]);
  assert.deepEqual([...decodeDataUrl('data:text/plain,hi%21')!], [104, 105, 33]);
  assert.equal(decodeDataUrl('https://example.org/a.png'), null);
});

test('images are scaled down to fit but never enlarged', () => {
  assert.deepEqual(fitImage(1000, 500, 500, 700), { width: 500, height: 250 });
  assert.deepEqual(fitImage(100, 50, 500, 700), { width: 100, height: 50 });
  assert.deepEqual(fitImage(400, 2000, 500, 700), { width: 140, height: 700 });
});
