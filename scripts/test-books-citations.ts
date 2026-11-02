/**
 * Store-level verification for the citations feature (no browser needed):
 * bundles the real zustand store with a mocked Tauri IPC layer and drives
 * the actual updateFile → debounced saver → save_books_state → rehydrate →
 * migrateBookFile round trip. Run via the esbuild command in memory notes
 * (esbuild resolves the @/ aliases; Node's strip-types does not).
 */
import { useBooks, type BookCitation } from '../src/store/books';

/* eslint-disable no-console */
let failures = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock the Tauri IPC surface before anything calls it: capture saves, replay the
// last saved payload for loads — exactly what the Rust side does with books.json.
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let lastSaved: Record<string, unknown> | null = null;
const invokeMock: InvokeFn = async (cmd, args) => {
  if (cmd === 'save_books_state') {
    lastSaved = (args?.booksState as Record<string, unknown>) ?? null;
    return null;
  }
  if (cmd === 'load_books_state') return lastSaved;
  return null;
};
const globalScope = globalThis as unknown as Record<string, unknown>;
const fakeWindow: Record<string, unknown> = { __TAURI_INTERNALS__: { invoke: invokeMock } };
globalScope.window = fakeWindow;
globalScope.isSecureContext = true;

const now = '2026-01-01T00:00:00.000Z';
const citation: BookCitation = {
  title: 'War and Peace',
  authors: ['Tolstoy, Leo'],
  structuredAuthors: [{ family: 'Tolstoy', given: 'Leo' }],
  publisher: 'Penguin',
  city: 'London',
  year: '1869',
  edition: '2nd',
  isbn: '9780140449136',
  container: 'Penguin Classics',
  volume: '3',
  pages: '1-1024',
  confidence: 'high',
  source: 'enriched',
  retrievedAt: now,
  fieldSources: { publisher: 'openlibrary', year: 'google-books', pageCount: 'file', container: 'crossref', volume: 'crossref', pages: 'crossref' },
  conflicts: ['year'],
};

function baseFile(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    filePath: `/mock/${id}.pdf`,
    name: `${id}.pdf`,
    extension: 'pdf',
    size: 100,
    addedAt: now,
    modifiedAt: now,
    tags: [],
    notes: '',
    ...extra,
  };
}

async function main() {
  // 1. Fresh library with two files, no citations
  useBooks.setState({
    hydrated: true,
    projects: [{ id: 'proj', name: 'Research', description: '', rootFolderIds: [], fileIds: ['f1', 'f2'], color: '#3B82F6', collapsed: false, createdAt: now, updatedAt: now }],
    folders: {},
    files: { f1: baseFile('f1'), f2: baseFile('f2') },
    activeProjectId: 'proj',
    selectedFolderId: null,
    selectedFileIds: [],
    clipboard: null,
  });

  // 2. updateFile saves a citation — and a display name rename rides the same patch
  const { updateFile } = useBooks.getState();
  updateFile('f1', { citation });
  updateFile('f1', { displayName: 'War and Peace (Penguin Edition)' });
  const afterUpdate = useBooks.getState().files.f1;
  check('updateFile stores the citation', afterUpdate?.citation?.title === 'War and Peace', afterUpdate?.citation);
  check('updateFile stores the display name', afterUpdate?.displayName === 'War and Peace (Penguin Edition)', afterUpdate?.displayName);
  check('original import filename is untouched', afterUpdate?.name === 'f1.pdf', afterUpdate?.name);

  // 3. Clearing works
  updateFile('f1', { citation: null });
  check('updateFile clears the citation', useBooks.getState().files.f1?.citation === null);
  updateFile('f1', { citation });

  // 4. The debounced saver persists it through the IPC boundary
  lastSaved = null;
  await sleep(1200);
  // Narrowing sees `lastSaved = null` above; the mock assigned it asynchronously.
  const snapshot = lastSaved as Record<string, unknown> | null;
  const savedFiles = (snapshot?.files as Record<string, { citation?: BookCitation }> | undefined) ?? {};
  check('debounced saver wrote books state', snapshot !== null);
  check('saved payload carries the citation', savedFiles.f1?.citation?.isbn === '9780140449136', savedFiles.f1?.citation);

  // 5. Rehydrate from the saved payload — migrateBookFile must round-trip it
  useBooks.setState({ hydrated: false, projects: [], folders: {}, files: {} });
  await useBooks.getState().hydrate();
  const rehydrated = useBooks.getState().files.f1;
  check('rehydrated file kept the citation', rehydrated?.citation?.title === 'War and Peace' && rehydrated.citation.source === 'enriched', rehydrated?.citation);
  check('rehydrated citation kept field provenance', rehydrated?.citation?.fieldSources?.publisher === 'openlibrary' && rehydrated.citation.fieldSources?.pageCount === 'file', rehydrated?.citation?.fieldSources);
  check('rehydrated citation kept conflicts', JSON.stringify(rehydrated?.citation?.conflicts) === JSON.stringify(['year']), rehydrated?.citation?.conflicts);
  check('rehydrated citation kept the rich merged fields', rehydrated?.citation?.container === 'Penguin Classics' && rehydrated?.citation?.volume === '3' && rehydrated?.citation?.confidence === 'high', rehydrated?.citation);
  check('rehydrated citation kept structured authors', rehydrated?.citation?.structuredAuthors?.[0]?.family === 'Tolstoy', rehydrated?.citation?.structuredAuthors);
  check('rehydrated file kept the display name', rehydrated?.displayName === 'War and Peace (Penguin Edition)', rehydrated?.displayName);
  check('rehydrated file kept the original filename', rehydrated?.name === 'f1.pdf', rehydrated?.name);
  check('rehydrated file without citation gets undefined', useBooks.getState().files.f2?.citation === undefined);

  // 6. Corrupt citations are dropped by the migrator, not crashers;
  //    bogus provenance entries are filtered but valid fields survive.
  //    Keep hydrated: true here — the saver only runs between hydrated states.
  useBooks.setState({
    files: {
      bad: baseFile('bad', { citation: { title: 42, source: 'nope' } }),
      partial: baseFile('partial', {
        displayName: 42,
        citation: {
          title: 'Valid Record',
          authors: [],
          source: 'enriched',
          retrievedAt: now,
          type: 'nope',
          confidence: 9,
          fieldSources: { title: 'not-a-source', isbn: 'crossref' },
          conflicts: ['notAField', 'isbn'],
        },
      }),
    },
  });
  // Let the debounced saver flush the new payload before rehydrating it.
  await sleep(1200);
  useBooks.setState({ hydrated: false });
  await useBooks.getState().hydrate();
  check('migrator drops corrupt citation records', useBooks.getState().files.bad?.citation === undefined, useBooks.getState().files.bad?.citation);
  const partial = useBooks.getState().files.partial?.citation;
  check('migrator filters bogus provenance but keeps valid entries', partial?.fieldSources?.isbn === 'crossref' && partial.fieldSources?.title === undefined, partial?.fieldSources);
  check('migrator filters unknown conflict fields', JSON.stringify(partial?.conflicts) === JSON.stringify(['isbn']), partial?.conflicts);
  check('migrator drops bogus type and confidence', partial?.type === undefined && partial?.confidence === undefined, { type: partial?.type, confidence: partial?.confidence });

  console.log(failures === 0 ? '\nAll citation store checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
