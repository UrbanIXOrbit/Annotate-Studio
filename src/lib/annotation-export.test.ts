import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  buildDocx,
  buildMarkdown,
  buildPdf,
  exportFileName,
  hexDigits,
  isRtl,
  itemBody,
  tintColor,
} from './annotation-export.ts';
import { ALL_GROUPS, buildReport, type AnnotationEntry, type BookAnnotations } from './annotations.ts';

const loadFont = async (name: string) => new Uint8Array(await readFile(new URL(`../../public/fonts/${name}`, import.meta.url)));

let counter = 0;
const entry = (over: Partial<AnnotationEntry>): AnnotationEntry => ({
  id: `e${++counter}`,
  page: 1,
  kind: 'highlight',
  text: '',
  comment: '',
  x: 0,
  y: counter,
  ...over,
});

function reportOf(books: BookAnnotations[], title = 'All books') {
  return buildReport(books, { groups: ALL_GROUPS, query: '' }, title, new Date('2026-10-15T09:30:00Z'));
}

const sample: BookAnnotations[] = [
  {
    path: 'a.pdf',
    title: 'Social Planning & Policy',
    pageCount: 120,
    entries: [
      entry({ page: 3, text: 'Social planning is a deliberate process of problem solving.', comment: 'Link to the Beveridge report', color: '#ffcd45', author: 'Emmanuel' }),
      entry({ page: 3, kind: 'note', comment: 'Revisit this definition\nbefore the seminar', color: '#3b82f6' }),
      entry({ page: 17, kind: 'underline', text: 'needs assessment precedes design', color: '#22c55e' }),
      entry({ page: 40, kind: 'drawing' }),
    ],
  },
  { path: 'b.pdf', title: 'Programme Evaluation', pageCount: 30, entries: [entry({ page: 2, text: 'Monitoring is continuous; evaluation is periodic.' })] },
];

test('colour helpers', () => {
  assert.equal(hexDigits('#FFCD45'), 'ffcd45');
  assert.equal(hexDigits(undefined), '9ca3af');
  assert.equal(tintColor('#000000', 0.5), '808080');
  assert.equal(tintColor('#ffffff', 0.9), 'ffffff');
  assert.equal(isRtl('مرحبا'), true);
  assert.equal(isRtl('Hello'), false);
});

test('itemBody treats a note as its own body and a highlight comment as a comment', () => {
  const [note] = reportOf([{ path: 'x', title: 'X', pageCount: 1, entries: [entry({ kind: 'note', comment: 'hello' })] }]).books[0].pages[0].items;
  assert.deepEqual(itemBody(note), { quote: 'hello', comment: '' });
  const [hl] = reportOf([{ path: 'x', title: 'X', pageCount: 1, entries: [entry({ text: 'quoted', comment: 'mine' })] }]).books[0].pages[0].items;
  assert.deepEqual(itemBody(hl), { quote: 'quoted', comment: 'mine' });
});

test('file names are derived from the report title and format', () => {
  const report = reportOf(sample, 'Social Planning: Vol/2');
  assert.equal(exportFileName(report, 'md'), 'Social Planning Vol 2 - annotations.md');
  assert.equal(exportFileName(report, 'docx'), 'Social Planning Vol 2 - annotations.docx');
  assert.equal(exportFileName(report, 'pdf'), 'Social Planning Vol 2 - annotations.pdf');
});

test('markdown export is UTF-8 bytes of the report', () => {
  const text = new TextDecoder().decode(buildMarkdown(reportOf(sample)));
  assert.match(text, /### Page 3/);
  assert.match(text, /Link to the Beveridge report/);
});

test('docx export is a valid package containing every annotation in order', async () => {
  const bytes = await buildDocx(reportOf(sample));
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file('[Content_Types].xml'));
  const xml = await zip.file('word/document.xml')!.async('string');
  const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const needle of ['Social Planning &amp; Policy', 'Programme Evaluation', 'Page 3', 'Page 17', 'Page 40', 'Social planning is a deliberate process', 'Link to the Beveridge report', 'Revisit this definition', 'before the seminar', 'needs assessment precedes design']) {
    assert.ok(xml.includes(needle) || text.includes(needle.replace('&amp;', '&')), `missing: ${needle}`);
  }
  // Books sort alphabetically; pages ascend.
  assert.ok(xml.indexOf('Programme Evaluation') < xml.indexOf('Social Planning &amp; Policy'));
  assert.ok(xml.indexOf('Page 3') < xml.indexOf('Page 17') && xml.indexOf('Page 17') < xml.indexOf('Page 40'));
  // The highlight's colour is used for its accent border.
  assert.ok(xml.includes('ffcd45'));
  const footer = Object.keys(zip.files).find((name) => name.startsWith('word/footer'));
  assert.ok(footer, 'has a page-number footer');
});

test('docx marks right-to-left text', async () => {
  const report = reportOf([{ path: 'r', title: 'Arabic', pageCount: 2, entries: [entry({ text: 'مرحبا بالعالم' })] }]);
  const zip = await JSZip.loadAsync(await buildDocx(report));
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.ok(xml.includes('<w:bidi'), 'paragraph is bidirectional');
  assert.ok(xml.includes('<w:rtl'), 'run is right-to-left');
});

test('docx export of an empty report still opens', async () => {
  const zip = await JSZip.loadAsync(await buildDocx(reportOf([])));
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.ok(xml.includes('No annotations to export'));
});

test('pdf export produces a valid multi-page document', async () => {
  const many: BookAnnotations = {
    path: 'big.pdf',
    title: 'Large Book',
    pageCount: 300,
    entries: Array.from({ length: 80 }, (_, i) => entry({ page: i + 1, text: `Quotation number ${i + 1}. `.repeat(12), comment: i % 3 === 0 ? 'A short comment on this passage.' : '', color: '#ffcd45' })),
  };
  const { bytes, replacedChars } = await buildPdf(reportOf([many, ...sample]), loadFont);
  assert.equal(replacedChars, 0);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() > 5, `pages=${loaded.getPageCount()}`);
  assert.equal(loaded.getTitle(), 'Annotations: All books');
  assert.ok(new TextDecoder('latin1').decode(bytes.slice(0, 8)).startsWith('%PDF-'));
});

test('pdf export handles Yoruba, Vietnamese, Greek and Cyrillic without substitution', async () => {
  const report = reportOf([{ path: 'u', title: 'Ìwé Ẹ̀kọ́', pageCount: 4, entries: [entry({ text: 'Ọmọ Ìbàdàn ṣe ẹ̀bùn. Việt Nam đẹp. Ελλάδα. Привет мир. café “quoted” — dash' })] }]);
  const { replacedChars } = await buildPdf(report, loadFont);
  assert.equal(replacedChars, 0);
});

test('pdf export reports characters it cannot draw instead of failing', async () => {
  const report = reportOf([{ path: 'u', title: 'Mixed', pageCount: 4, entries: [entry({ text: 'English 日本語 text' })] }]);
  const { bytes, replacedChars } = await buildPdf(report, loadFont);
  assert.equal(replacedChars, 3);
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test('pdf export survives very long unbroken words and an empty report', async () => {
  const long = reportOf([{ path: 'l', title: 'Long', pageCount: 1, entries: [entry({ text: 'https://example.org/' + 'abcdefghij'.repeat(40) })] }]);
  assert.ok((await PDFDocument.load((await buildPdf(long, loadFont)).bytes)).getPageCount() >= 1);
  assert.ok((await PDFDocument.load((await buildPdf(reportOf([]), loadFont)).bytes)).getPageCount() === 1);
});
