import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SAVED_VIEWS,
  clampPosition,
  isDefaultView,
  mergePdfView,
  migratePdfViews,
  positionFromVisibility,
  pruneViews,
  removePdfView,
  renamePdfView,
  samePosition,
  sameZoom,
  sanitizePdfView,
  sanitizeZoom,
  type PdfViewState,
} from './pdf-view.ts';

const view = (over: Partial<PdfViewState> = {}): PdfViewState => ({ page: 12, y: 340.5, zoom: 'fit-width', updatedAt: 100, ...over });

test('zoom keeps modes, clamps numbers, and falls back to fit-width for junk', () => {
  assert.equal(sanitizeZoom('fit-page'), 'fit-page');
  assert.equal(sanitizeZoom('automatic'), 'automatic');
  assert.equal(sanitizeZoom(1.5), 1.5);
  assert.equal(sanitizeZoom(0.01), 0.2);
  assert.equal(sanitizeZoom(99), 6);
  assert.equal(sanitizeZoom('banana'), 'fit-width');
  assert.equal(sanitizeZoom(NaN), 'fit-width');
  assert.equal(sanitizeZoom(undefined), 'fit-width');
});

test('a saved view is accepted only when well formed', () => {
  assert.deepEqual(sanitizePdfView({ page: 5.9, y: 10.04, zoom: 2, color: '#E44234', highlightColor: '#ffcd45', width: 4, updatedAt: 7 }), {
    page: 5,
    y: 10,
    zoom: 2,
    color: '#E44234',
    highlightColor: '#ffcd45',
    width: 4,
    updatedAt: 7,
  });
  assert.equal(sanitizePdfView(null), null);
  assert.equal(sanitizePdfView('page 3'), null);
  assert.equal(sanitizePdfView({ page: 0 }), null);
  assert.equal(sanitizePdfView({ page: -4 }), null);
  assert.equal(sanitizePdfView({ page: Infinity }), null);
  assert.equal(sanitizePdfView({ y: 5 }), null);
});

test('invalid optional fields are dropped without discarding the position', () => {
  const clean = sanitizePdfView({ page: 3, y: -20, zoom: 'weird', color: 'red', highlightColor: 5, width: 500 })!;
  assert.equal(clean.page, 3);
  assert.equal(clean.y, 0);
  assert.equal(clean.zoom, 'fit-width');
  assert.equal(clean.color, undefined);
  assert.equal(clean.highlightColor, undefined);
  assert.equal(clean.width, undefined);
});

test('loading from disk tolerates garbage and normalises keys', () => {
  assert.deepEqual(migratePdfViews(null), {});
  assert.deepEqual(migratePdfViews([1, 2]), {});
  assert.deepEqual(migratePdfViews('x'), {});
  const loaded = migratePdfViews(
    { ' documents/a.pdf ': view(), 'b.pdf': { page: 'nope' }, '': view(), 'c.pdf': view({ page: 9 }) },
    (path) => path.replace(/^documents\//, ''),
  );
  assert.deepEqual(Object.keys(loaded).sort(), ['a.pdf', 'c.pdf']);
  assert.equal(loaded['c.pdf'].page, 9);
});

test('when two keys normalise to the same path the newer view wins', () => {
  const loaded = migratePdfViews({ 'x/a.pdf': view({ page: 2, updatedAt: 1 }), 'a.pdf': view({ page: 8, updatedAt: 5 }) }, (p) => p.replace(/^x\//, ''));
  assert.equal(loaded['a.pdf'].page, 8);
});

test('the saved map is capped, keeping the most recently used books', () => {
  const many: Record<string, PdfViewState> = {};
  for (let i = 0; i < MAX_SAVED_VIEWS + 25; i += 1) many[`book${i}.pdf`] = view({ updatedAt: i });
  const pruned = pruneViews(many);
  assert.equal(Object.keys(pruned).length, MAX_SAVED_VIEWS);
  assert.ok(pruned[`book${MAX_SAVED_VIEWS + 24}.pdf`], 'newest kept');
  assert.ok(!pruned['book0.pdf'], 'oldest dropped');
  const small = { a: view() };
  assert.equal(pruneViews(small), small, 'untouched below the cap');
});

test('merging returns the same object when nothing meaningful changed', () => {
  const saved = view();
  assert.equal(mergePdfView(saved, { page: 12, y: 341.2 }, 999), saved, 'sub-tolerance scroll jitter is ignored');
  assert.equal(mergePdfView(saved, { zoom: 'fit-width' }, 999), saved);
  assert.equal(mergePdfView(saved, {}, 999), saved);
});

test('merging records real changes and stamps the time', () => {
  const saved = view();
  const scrolled = mergePdfView(saved, { page: 13, y: 0 }, 555);
  assert.deepEqual({ page: scrolled.page, y: scrolled.y, updatedAt: scrolled.updatedAt }, { page: 13, y: 0, updatedAt: 555 });
  assert.equal(mergePdfView(saved, { zoom: 1.25 }, 1).zoom, 1.25);
  assert.equal(mergePdfView(saved, { color: '#3B82F6' }, 1).color, '#3B82F6');
  assert.equal(mergePdfView(saved, { color: 'blue' }, 1), saved, 'invalid colour is ignored');
  assert.equal(mergePdfView(saved, { width: 9999 }, 1), saved, 'invalid width is ignored');
  const first = mergePdfView(undefined, { page: 4, y: 20 }, 42);
  assert.deepEqual(first, { page: 4, y: 20, zoom: 'fit-width', updatedAt: 42 });
});

test('position and zoom comparisons', () => {
  assert.equal(samePosition({ page: 3, y: 10 }, { page: 3, y: 11.9 }), true);
  assert.equal(samePosition({ page: 3, y: 10 }, { page: 3, y: 13 }), false);
  assert.equal(samePosition({ page: 3, y: 10 }, { page: 4, y: 10 }), false);
  assert.equal(sameZoom(1.5, 1.502), true);
  assert.equal(sameZoom(1.5, 1.6), false);
  assert.equal(sameZoom('fit-page', 'fit-page'), true);
  assert.equal(sameZoom('fit-page', 1), false);
});

test('the reading position is the topmost visible page', () => {
  assert.equal(positionFromVisibility([]), null);
  assert.equal(positionFromVisibility([{ pageNumber: 4, visiblePercentage: 0, original: { pageY: 9 } }]), null);
  const position = positionFromVisibility([
    { pageNumber: 6, visiblePercentage: 80, original: { pageY: 0 } },
    { pageNumber: 5, visiblePercentage: 20, original: { pageY: 612.4 } },
  ]);
  assert.deepEqual(position, { page: 5, y: 612.4 });
  assert.equal(positionFromVisibility([{ pageNumber: 2, visiblePercentage: 100, original: { pageY: -3 } }])!.y, 0);
});

test('a saved position stays valid if the document got shorter', () => {
  assert.deepEqual(clampPosition({ page: 12, y: 100 }, 30), { page: 12, y: 100 });
  assert.deepEqual(clampPosition({ page: 99, y: 100 }, 30), { page: 30, y: 0 });
  assert.deepEqual(clampPosition({ page: 3, y: 5000 }, 30, () => 792), { page: 3, y: 792 });
  assert.deepEqual(clampPosition({ page: 3, y: -5 }, 30), { page: 3, y: 0 });
  assert.deepEqual(clampPosition({ page: 1, y: 10 }, 0), { page: 1, y: 10 });
});

test('default views are recognised so they are not stored', () => {
  assert.equal(isDefaultView({ page: 1, y: 0, zoom: 'fit-width', updatedAt: 1 }), true);
  assert.equal(isDefaultView({ page: 1, y: 1.5, zoom: 'fit-width', updatedAt: 1 }), true);
  assert.equal(isDefaultView({ page: 2, y: 0, zoom: 'fit-width', updatedAt: 1 }), false);
  assert.equal(isDefaultView({ page: 1, y: 0, zoom: 1.5, updatedAt: 1 }), false);
  assert.equal(isDefaultView({ page: 1, y: 0, zoom: 'fit-width', color: '#112233', updatedAt: 1 }), false);
});

test('renaming moves the saved view and removing deletes it', () => {
  const views = { 'a.pdf': view({ updatedAt: 5 }), 'b.pdf': view({ page: 2, updatedAt: 9 }) };
  const renamed = renamePdfView(views, 'a.pdf', 'z.pdf');
  assert.deepEqual(Object.keys(renamed).sort(), ['b.pdf', 'z.pdf']);
  assert.equal(renamed['z.pdf'].page, 12);
  assert.equal(renamePdfView(views, 'missing.pdf', 'q.pdf'), views);
  assert.equal(renamePdfView(views, 'a.pdf', 'a.pdf'), views);
  // Renaming onto a path that already has a newer view keeps the newer one.
  assert.equal(renamePdfView(views, 'a.pdf', 'b.pdf')['b.pdf'].page, 2);
  const removed = removePdfView(views, 'a.pdf');
  assert.deepEqual(Object.keys(removed), ['b.pdf']);
  assert.equal(removePdfView(views, 'nope.pdf'), views);
});
