import { useBooks } from '../src/store/books';

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

const now = '2026-01-01T00:00:00.000Z';

function file(id: string, path: string) {
  return {
    id, filePath: path, name: path.split('/').pop()!, extension: path.split('.').pop()!,
    size: 100, addedAt: now, modifiedAt: now, tags: [], notes: '',
  };
}

useBooks.setState({
  hydrated: true,
  projects: [
    { id: 'projA', name: 'Research', description: '', rootFolderIds: ['foldPapers'], fileIds: ['f1', 'f2'], color: '#3B82F6', collapsed: false, createdAt: now, updatedAt: now },
    { id: 'projB', name: 'Personal', description: '', rootFolderIds: [], fileIds: [], color: '#8B5CF6', collapsed: false, createdAt: now, updatedAt: now },
  ],
  folders: {
    foldPapers: { id: 'foldPapers', name: 'Papers', parentId: null, projectId: 'projA', fileIds: ['f3'], childIds: ['fold2026'], collapsed: false, createdAt: now },
    fold2026: { id: 'fold2026', name: '2026', parentId: 'foldPapers', projectId: 'projA', fileIds: [], childIds: [], collapsed: false, createdAt: now },
  },
  files: { f1: file('f1', '/mock/alpha.pdf'), f2: file('f2', '/mock/beta.md'), f3: file('f3', '/mock/gamma.png') },
  activeProjectId: 'projA',
  selectedFolderId: null,
  selectedFileIds: [],
  clipboard: null,
});

const store = useBooks.getState;

console.log('T1 — multi-file move into a folder (drag & drop handler path)');
store().moveFiles(['f1', 'f2'], 'projA', 'foldPapers');
{
  const s = store();
  check('folder received both files', s.folders.foldPapers.fileIds.includes('f1') && s.folders.foldPapers.fileIds.includes('f2'));
  check('project root no longer lists them', !s.projects[0].fileIds.includes('f1') && !s.projects[0].fileIds.includes('f2'));
  check('files still exist exactly once', !!s.files.f1 && !!s.files.f2 && Object.values(s.files).length === 3);
}

console.log('T2 — moveFiles is a no-op when already at target (no duplicates)');
store().moveFiles(['f1'], 'projA', 'foldPapers');
{
  const s = store();
  check('file appears once in folder', s.folders.foldPapers.fileIds.filter((id) => id === 'f1').length === 1);
}

console.log('T3 — copy files into another project (Alt-drop path)');
const copiedCount = store().copyFiles(['f3'], 'projB', null);
{
  const s = store();
  check('copyFiles reports 1 copy', copiedCount === 1);
  const projB = s.projects.find((p) => p.id === 'projB')!;
  check('projB root references the copy', projB.fileIds.length === 1);
  const copy = s.files[projB.fileIds[0]];
  check('copy has a new id but same path', !!copy && copy.id !== 'f3' && copy.filePath === '/mock/gamma.png');
  check('original untouched', s.folders.foldPapers.fileIds.includes('f3'));
  check('library now has 4 entries', Object.keys(s.files).length === 4);
}

console.log('T4 — copy into same location dedupes by path');
const dedupeCount = store().copyFiles(['f3'], 'projB', null);
check('second copy skipped', dedupeCount === 0 && store().projects.find((p) => p.id === 'projB')!.fileIds.length === 1);

console.log('T5 — clipboard copy → paste into project root (Cmd+C / Cmd+V path)');
store().copyToClipboard(['f1', 'f2']);
check(
  'clipboard holds copy mode',
  store().clipboard?.mode === 'copy' && store().clipboard?.fileIds.length === 2,
);
store().pasteFromClipboard('projB', null);
{
  const s = store();
  check('pasted 2 files into projB root', s.projects.find((p) => p.id === 'projB')!.fileIds.length === 3);
  check('copy clipboard survives paste (paste-again works)', s.clipboard?.mode === 'copy' && s.clipboard.fileIds.length === 2);
  check('originals stayed in folder', s.folders.foldPapers.fileIds.includes('f1') && s.folders.foldPapers.fileIds.includes('f2'));
}

console.log('T6 — clipboard cut → paste into a subfolder (move semantics)');
store().cutToClipboard(['f1']);
check('cut rows flagged', store().clipboard?.mode === 'cut');
store().pasteFromClipboard('projA', 'fold2026');
{
  const s = store();
  check('file moved into subfolder', s.folders.fold2026.fileIds.includes('f1'));
  check('removed from old folder', !s.folders.foldPapers.fileIds.includes('f1'));
  check('cut clipboard cleared after paste', s.clipboard === null);
}

console.log('T7 — moveFolder into its own descendant is rejected');
store().moveFolder('foldPapers', 'fold2026', 'projA');
check('folder unchanged', store().folders.foldPapers.parentId === null && store().folders.foldPapers.childIds.includes('fold2026'));

console.log('T8 — moveFolder across projects re-homes the whole subtree');
store().moveFolder('foldPapers', null, 'projB');
{
  const s = store();
  check('removed from projA roots', !s.projects[0].rootFolderIds.includes('foldPapers'));
  check('added to projB roots', s.projects.find((p) => p.id === 'projB')!.rootFolderIds.includes('foldPapers'));
  check('folder projectId updated', s.folders.foldPapers.projectId === 'projB');
  check('descendant projectId updated', s.folders.fold2026.projectId === 'projB');
  check('descendant still a child', s.folders.foldPapers.childIds.includes('fold2026'));
}

console.log('T9 — cross-project file move via drag onto a project item');
store().moveFiles(['f2'], 'projB', null);
{
  const s = store();
  check('file now in projB root', s.projects.find((p) => p.id === 'projB')!.fileIds.includes('f2'));
  check('gone from projA folder', !s.folders.foldPapers.fileIds.includes('f2'));
}

console.log('T10 — removeFiles prunes the clipboard');
store().cutToClipboard(['f2']);
store().removeFiles(['f2']);
check('removed file dropped from clipboard', store().clipboard?.fileIds.includes('f2') === false);
check('file gone from project', !store().projects.find((p) => p.id === 'projB')!.fileIds.includes('f2'));

console.log('');
if (failures === 0) {
  console.log('ALL STORE TESTS PASSED');
} else {
  console.log(`${failures} TEST(S) FAILED`);
  process.exitCode = 1;
}
