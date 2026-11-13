import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileReport, demoteHeadings, type CompileInput, type CompileNote } from './report-compiler.ts';
import type { ResolvedEntry } from './bibliography.ts';
import type { BookCitation } from '../store/books.ts';

const note = (title: string, markdown: string): CompileNote => ({ path: `/${title}.md`, title, markdown });

const citation = (title: string, authors: string[], year: string): BookCitation => ({
  title,
  authors,
  year,
  type: 'book',
  publisher: 'Acme Press',
  source: 'manual',
} as unknown as BookCitation);

const resolved = (title: string, note?: string): ResolvedEntry =>
  ({
    entry: { id: title, included: true },
    citation: { ...citation(title, ['A. Author'], '2020'), ...(note ? { note } : {}) },
    label: title,
    missing: false,
  }) as unknown as ResolvedEntry;

const base = (overrides: Partial<CompileInput> = {}): CompileInput => ({
  title: 'My research report',
  notes: [],
  cards: [],
  sourceBooks: [],
  bibliography: [],
  options: { includeToc: false, includeHighlights: true, includeBibliography: true, style: 'apa' },
  ...overrides,
});

test('demoteHeadings shifts ATX headings and leaves code blocks alone', () => {
  const md = '# Top\n\n## Section\n\n```md\n# not a heading\n```\n\n### Deep\n\n~~~txt\n## also not\n~~~\n\nnot # a heading';
  assert.equal(
    demoteHeadings(md, 1),
    '## Top\n\n### Section\n\n```md\n# not a heading\n```\n\n#### Deep\n\n~~~txt\n## also not\n~~~\n\nnot # a heading',
  );
  // Level 6 heading stays at 6 (capped).
  assert.equal(demoteHeadings('###### six', 2), '###### six');
});

test('compileReport assembles title, notes and TOC', () => {
  const { markdown, stats } = compileReport(
    base({
      notes: [
        note('First idea', '---\ntitle: x\n---\n# First idea\n\n## Detail\n\nBody text here.\n'),
      ],
      options: { includeToc: true, includeHighlights: false, includeBibliography: false, style: 'apa' },
    }),
  );
  assert.match(markdown, /^# My research report\n/);
  assert.match(markdown, /## Contents\n\n- First idea\n  - Detail\n/);
  assert.match(markdown, /## First idea\n\n### Detail\n\nBody text here\./);
  // Front matter is stripped; empty note contributes nothing.
  assert.doesNotMatch(markdown, /title: x/);
  assert.doesNotMatch(markdown, /## Empty/);
  assert.deepEqual(
    { notes: stats.notes, highlights: stats.highlights, citations: stats.citations },
    { notes: 1, highlights: 0, citations: 0 },
  );
  assert.ok(stats.words > 5);
});

test('compileReport renders cards and annotations as quotes with attribution', () => {
  const { markdown, stats } = compileReport(
    base({
      cards: [
        { text: 'Spaced repetition works.', comment: 'Key claim.', source: { title: 'Memory.pdf', page: 14 } },
        { text: 'Own thought', comment: '' },
      ],
      sourceBooks: [
        {
          title: 'Kandel.pdf',
          pages: [{ page: 3, items: [{ kind: 'highlight', label: 'Highlight', text: 'Long-term potentiation', comment: 'core mechanism' }] }],
        },
      ],
      options: { includeToc: false, includeHighlights: true, includeBibliography: false, style: 'apa' },
    }),
  );
  assert.match(markdown, /## Highlights\n/);
  assert.match(markdown, /### Kandel\.pdf\n/);
  assert.match(markdown, /> Long-term potentiation\n>\n> — \*Kandel\*, p\. 3\n\ncore mechanism/);
  assert.match(markdown, /— \*Memory\*, p\. 14/);
  assert.match(markdown, /Key claim\./);
  assert.equal(stats.highlights, 3);
});

test('compileReport numbers the annotated bibliography and skips missing citations', () => {
  const bibliography: ResolvedEntry[] = [
    resolved('Spaced learning', 'The canonical review'),
    { entry: { id: 'x' }, citation: null, label: 'Gone', missing: true } as unknown as ResolvedEntry,
    resolved('Memory consolidation'),
  ];
  const { markdown, stats } = compileReport(base({ bibliography }));
  assert.match(markdown, /## Bibliography\n\n1\. Author, A\. \(2020\)\. Spaced learning\..*\n\n    The canonical review\n\n2\. Author, A\. \(2020\)\. Memory consolidation/);
  assert.doesNotMatch(markdown, /Gone/);
  assert.equal(stats.citations, 2);
});

test('compileReport skips empty sections entirely', () => {
  const { markdown, stats } = compileReport(
    base({
      options: { includeToc: false, includeHighlights: true, includeBibliography: true, style: 'vancouver' },
    }),
  );
  assert.doesNotMatch(markdown, /## Highlights/);
  assert.doesNotMatch(markdown, /## Bibliography/);
  assert.doesNotMatch(markdown, /## Contents/);
  assert.deepEqual(
    { notes: stats.notes, highlights: stats.highlights, citations: stats.citations },
    { notes: 0, highlights: 0, citations: 0 },
  );
  assert.equal(stats.words, (markdown.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length);
});
