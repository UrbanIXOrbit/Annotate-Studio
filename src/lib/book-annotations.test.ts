import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookAnnotationEntries, chapterFromCfi, createEpubAnnotation, parseEpubAnnotationSet } from './book-annotations.ts';

test('chapterFromCfi reads the spine step of an EPUB CFI', () => {
  assert.equal(chapterFromCfi('epubcfi(/6/2!/4/2/16)'), 0);
  assert.equal(chapterFromCfi('epubcfi(/6/4[chap01ref]!/4[body01]/10[/2])'), 1);
  assert.equal(chapterFromCfi('epubcfi(/6/14!/4/2)'), 6);
  // Whitespace before an item shifts the raw step, but ordering stays monotonic.
  assert.ok(chapterFromCfi('epubcfi(/6/6!/4/2)') < chapterFromCfi('epubcfi(/6/8!/4/2)'));
});

test('chapterFromCfi falls back to 0 for foreign or empty CFIs', () => {
  assert.equal(chapterFromCfi(''), 0);
  assert.equal(chapterFromCfi('not-a-cfi'), 0);
});

test('bookAnnotationEntries maps saved EPUB annotations to the shared entry model', () => {
  const first = createEpubAnnotation({ source: 'book.epub', cfi: 'epubcfi(/6/4!/4/2)', text: 'First thought', style: 'highlight' });
  const second = createEpubAnnotation({ source: 'book.epub', cfi: 'epubcfi(/6/4!/4/8)', text: 'Second thought', style: 'underline' });
  const set = parseEpubAnnotationSet({ type: 'AnnotationSet', items: [first, second] }, 'Book');

  const entries = bookAnnotationEntries(set.items);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    [entries[0].kind, entries[0].text, entries[0].cfi, entries[0].color],
    ['highlight', 'First thought', first.target.selector[0].value, '#FFCD45'],
  );
  assert.equal(entries[1].kind, 'underline');
  // Creation order is preserved within a chapter, and chapters group by their spine step.
  assert.ok(entries[0].y < entries[1].y);
  assert.equal(entries[0].page, entries[1].page);
});

test('bookAnnotationEntries survives an empty set', () => {
  assert.deepEqual(bookAnnotationEntries(parseEpubAnnotationSet(null, 'Book').items), []);
});
