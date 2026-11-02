'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useBooks, type BookFile } from '@/store/books';
import { RowMenu } from './RowMenu';
import {
  beginBooksDrag,
  booksClickSuppressed,
  isBooksDragBlockedTarget,
  isFolderInSubtree,
  useBooksDropTarget,
} from './dnd';
import {
  Upload,
  Plus,
  FileText,
  File,
  Image as ImageIcon,
  Trash2,
  Pencil,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  FileSearch,
  FileQuestion,
  Copy,
  Scissors,
  ClipboardPaste,
  BookMarked,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { openExternalFile, revealExternalFile, errorMessage } from '@/lib/tauri-commands';
import { appConfirm } from '@/lib/ui-dialogs';
import { isCitationCapable } from '@/lib/book-citations';
import { CitationsDialog } from './CitationsDialog';
import { AddCitationDialog } from './AddCitationDialog';
import { useCanvas } from '@/store/canvas';
import { useApp } from '@/store/app';
import { cn, formatBytes } from '@/lib/utils';
import { BOOK_EXTENSIONS, IMAGE_EXTENSIONS, NOTE_EXTENSIONS } from '@/lib/workspace-actions';

const DOC_EXTENSIONS = ['docx', 'doc', 'odt', 'epub', 'mobi', 'rtf'];

function toneForExtension(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === 'pdf') return 'tone-red';
  if (NOTE_EXTENSIONS.includes(ext)) return 'tone-blue';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'tone-green';
  if (DOC_EXTENSIONS.includes(ext)) return 'tone-violet';
  return 'tone-slate';
}

function FileIcon({ extension }: { extension: string }) {
  const ext = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return <ImageIcon size={16} />;
  if (ext === 'pdf' || NOTE_EXTENSIONS.includes(ext) || DOC_EXTENSIONS.includes(ext)) return <FileText size={16} />;
  return <File size={16} />;
}

function FileRow({
  file,
  selected,
  cut,
  missing,
  searching,
  dropLocation,
  wantRename,
  onRenameOpened,
  onAddCitation,
  onSelectRow,
  onToggleCheck,
}: {
  file: BookFile;
  selected: boolean;
  cut: boolean;
  /** Path failed the last disk verification */
  missing?: boolean;
  /** True while a scoped search is displayed */
  searching: boolean;
  /** Where a drop onto this row lands (the file's own location while searching) */
  dropLocation: { projectId: string; folderId: string | null } | null;
  /** Keyboard rename request (F2) */
  wantRename?: boolean;
  onRenameOpened?: () => void;
  /** Open the Add citation dialog for this file — only set for citatable formats */
  onAddCitation?: () => void;
  onSelectRow: () => void;
  onToggleCheck: () => void;
}) {
  const {
    updateFile,
    removeFiles,
    selectedFileIds,
    setSelectedFiles,
    copyToClipboard,
    cutToClipboard,
    moveFiles,
    copyFiles,
    moveFolder,
    projects,
    folders,
  } = useBooks();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  /** What the row shows: the renamed display name, or the original import filename */
  const label = file.displayName || file.name;

  // F2 from the panel: jump straight into editing, then release the request
  useEffect(() => {
    if (!wantRename) return;
    setEditName(label);
    setEditing(true);
    onRenameOpened?.();
  }, [wantRename]); // eslint-disable-line react-hooks/exhaustive-deps

  // Row-scoped actions operate on the whole selection when this row is part of it
  const effectiveIds = selected && selectedFileIds.includes(file.id) ? selectedFileIds : [file.id];

  // The row itself is a drop target: dropping files moves (Alt/Option copies)
  // them into this row's own location — the viewed folder normally, or the row
  // file's home folder in search results, so results accept drops again.
  const dropRef = useBooksDropTarget<HTMLDivElement>({
    accepts: (payload) => {
      const loc = dropLocation;
      if (!loc) return false;
      if (payload.kind === 'files') {
        const targetIds = loc.folderId
          ? folders[loc.folderId]?.fileIds ?? []
          : projects.find((p) => p.id === loc.projectId)?.fileIds ?? [];
        // Nothing would change if every dragged file is already at the target
        return !payload.fileIds.every((id) => targetIds.includes(id));
      }
      // Folder drops make no sense across scattered search results
      if (searching) return false;
      if (payload.folderId === loc.folderId) return false;
      if (loc.folderId && isFolderInSubtree(folders, loc.folderId, payload.folderId)) return false;
      return true;
    },
    onDrop: (payload, mode) => {
      const loc = dropLocation;
      if (!loc) return;
      if (payload.kind === 'files') {
        if (mode === 'copy') {
          const copied = copyFiles(payload.fileIds, loc.projectId, loc.folderId);
          if (copied === 0) alert('Those files are already in this location.');
        } else {
          moveFiles(payload.fileIds, loc.projectId, loc.folderId);
        }
      } else {
        moveFolder(payload.folderId, loc.folderId, loc.projectId);
      }
    },
  });

  const handleDragStart = (event: React.PointerEvent<HTMLElement>) => {
    if (isBooksDragBlockedTarget(event.target as Element)) return;
    const ids = selected && selectedFileIds.length > 1 ? selectedFileIds : [file.id];
    if (!selected) setSelectedFiles([file.id]);
    beginBooksDrag(
      event,
      { kind: 'files', fileIds: ids },
      ids.length > 1 ? `${ids.length} files` : label,
    );
  };

  const handleRename = () => {
    if (editName.trim()) {
      // Only the display name moves; the original `name` and filePath never change.
      updateFile(file.id, { displayName: editName.trim() === file.name ? undefined : editName.trim() });
    }
    setEditing(false);
  };

  const handleOpen = async () => {
    try {
      await openExternalFile(file.filePath);
    } catch (error) {
      alert(`Failed to open file: ${error}`);
    }
  };

  const handleReveal = async () => {
    try {
      await revealExternalFile(file.filePath);
    } catch (error) {
      alert(`Failed to reveal file: ${error}`);
    }
  };

  const handleOpenOnCanvas = () => {
    const ext = file.extension.toLowerCase();
    let type: 'pdf' | 'image' | 'note' | 'book' | null = null;

    if (ext === 'pdf') {
      type = 'pdf';
    } else if (IMAGE_EXTENSIONS.includes(ext)) {
      type = 'image';
    } else if (NOTE_EXTENSIONS.includes(ext)) {
      type = 'note';
    } else if (BOOK_EXTENSIONS.includes(ext)) {
      type = 'book';
    }

    if (!type) {
      alert('This file type cannot be opened on the canvas. Only PDFs, e-books, images, and text notes are supported.');
      return;
    }

    try {
      const canvas = useCanvas.getState();
      canvas.openResource({ type, title: label, filePath: file.filePath }, { isExternal: true });
      useApp.getState().setView('canvas');
    } catch (error) {
      alert(`Failed to open file on canvas: ${error}`);
    }
  };

  const handleRemove = async () => {
    if (await appConfirm(`Remove "${label}" from the library? The actual file will not be deleted.`)) {
      removeFiles([file.id]);
    }
  };

  return (
    <div
      ref={dropRef}
      data-books-drop=""
      className={cn('book-file', selected && 'selected', cut && 'cut', missing && 'missing')}
      onPointerDown={editing ? undefined : handleDragStart}
      title={searching ? undefined : dropLocation ? `Drop files here to add them to this location` : undefined}
    >
      {editing ? (
        <input
          type="text"
          className="input input-sm book-file-edit"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={handleRename}
          autoFocus
          dir="auto"
        />
      ) : (
        <>
          <label className="book-file-checkbox" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={selected} onChange={onToggleCheck} />
          </label>

          <div className={cn('book-file-icon', toneForExtension(file.extension))}>
            <FileIcon extension={file.extension} />
          </div>

          <div className="book-file-main" onClick={onSelectRow} onDoubleClick={handleOpenOnCanvas} title={file.filePath}>
            <div className="book-file-name">{label}</div>
            <div className="book-file-meta">
              {missing && (
                <span className="book-file-missing-badge" title="Not found on disk — last check failed to locate this path">
                  <FileQuestion size={11} />
                  Missing
                </span>
              )}
              <span>{formatBytes(file.size)}</span>
              {file.extension && <span className="book-file-ext">{file.extension}</span>}
              {file.tags.map((tag) => (
                <span key={tag} className="book-file-tag">
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          <div className="book-file-actions">
            <button type="button" className="icon-btn icon-btn-sm" onClick={handleOpenOnCanvas} title="Open on canvas">
              <LayoutGrid size={15} />
            </button>
            <button type="button" className="icon-btn icon-btn-sm" onClick={handleOpen} title="Open file">
              <ExternalLink size={15} />
            </button>
            <RowMenu
              items={[
                {
                  label: 'Open on canvas',
                  icon: <LayoutGrid size={14} />,
                  onClick: handleOpenOnCanvas,
                },
                {
                  label: 'Open file',
                  icon: <ExternalLink size={14} />,
                  onClick: handleOpen,
                },
                {
                  label: 'Show in folder',
                  icon: <FolderOpen size={14} />,
                  onClick: handleReveal,
                },
                ...(onAddCitation
                  ? [
                      {
                        label: 'Add citation',
                        icon: <BookMarked size={14} />,
                        onClick: onAddCitation,
                      },
                    ]
                  : []),
                {
                  label: effectiveIds.length > 1 ? `Copy ${effectiveIds.length} files` : 'Copy',
                  icon: <Copy size={14} />,
                  dividerBefore: true,
                  onClick: () => copyToClipboard(effectiveIds),
                },
                {
                  label: effectiveIds.length > 1 ? `Cut ${effectiveIds.length} files` : 'Cut',
                  icon: <Scissors size={14} />,
                  onClick: () => cutToClipboard(effectiveIds),
                },
                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  dividerBefore: true,
                  onClick: () => {
                    setEditName(file.name);
                    setEditing(true);
                  },
                },
                {
                  label: 'Remove',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: handleRemove,
                },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface BookFileListProps {
  projectId: string;
  searchQuery: string;
  /** Project ids the search spans; null searches this list's project only. */
  searchProjectIds: string[] | null;
}

export function BookFileList({ projectId, searchQuery, searchProjectIds }: BookFileListProps) {
  const {
    projects,
    folders,
    files: libraryFiles,
    selectedFolderId,
    selectedFileIds,
    setSelectedFiles,
    toggleFileSelection,
    getProjectFiles,
    searchFiles,
    getFileLocation,
    importFiles,
    verifyLibrary,
    missingFileIds,
    removeFiles,
    moveFiles,
    copyFiles,
    moveFolder,
    clipboard,
    copyToClipboard,
    cutToClipboard,
    pasteFromClipboard,
  } = useBooks();

  const [importing, setImporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  /** Row id that a keyboard F2 requested to rename */
  const [renameId, setRenameId] = useState<string | null>(null);
  /** Batch citations dialog, with the file scope frozen at open time */
  const [citationsOpen, setCitationsOpen] = useState(false);
  const [citationScope, setCitationScope] = useState<string[]>([]);
  /** Per-book Add citation dialog, opened from a row's "…" menu */
  const [addCitationFileId, setAddCitationFileId] = useState<string | null>(null);
  const openCitations = (ids: string[]) => {
    setCitationScope(ids);
    setCitationsOpen(true);
  };

  const files = searchQuery
    ? searchFiles(searchQuery, searchProjectIds ?? projectId)
    : getProjectFiles(projectId, selectedFolderId);

  const activeFolder = selectedFolderId ? folders[selectedFolderId] : null;
  const activeProjectName = projects.find((p) => p.id === projectId)?.name ?? 'Search results';
  // The search header names its scope so it's obvious what results belong to.
  const scopeName = (scopeIds: string[] | null): string => {
    if (scopeIds === null) return activeProjectName;
    if (scopeIds.length === 1) {
      return projects.find((p) => p.id === scopeIds[0])?.name ?? 'Search results';
    }
    const isEveryProject = scopeIds.length > 0 && scopeIds.length === projects.length;
    if (isEveryProject) return 'All projects';
    return `${scopeIds.length} projects`;
  };
  const title = searchQuery
    ? searchProjectIds === null
      ? `Search · ${activeProjectName}`
      : `Search · ${scopeName(searchProjectIds)}`
    : activeFolder
      ? activeFolder.name
      : 'All files';
  const allSelected = files.length > 0 && selectedFileIds.length === files.length;
  const cutIds = clipboard?.mode === 'cut' ? new Set(clipboard.fileIds) : null;

  // The files panel is itself a drop target: dropping here moves (or, with
  // Alt/Option, copies) into the folder currently being viewed. Search
  // results span folders, so drops are disabled while searching.
  const bodyDropRef = useBooksDropTarget<HTMLDivElement>({
    accepts: () => !searchQuery,
    onDrop: (payload, mode) => {
      if (payload.kind === 'files') {
        if (mode === 'copy') {
          const copied = copyFiles(payload.fileIds, projectId, selectedFolderId);
          if (copied === 0) alert('Those files are already in this location.');
        } else {
          moveFiles(payload.fileIds, projectId, selectedFolderId);
        }
      } else {
        moveFolder(payload.folderId, selectedFolderId, projectId);
      }
    },
  });

  const handlePaste = () => {
    const count = pasteFromClipboard(projectId, selectedFolderId);
    if (count === 0) alert('Those files are already in this location.');
  };

  const handleImport = async () => {
    try {
      setImporting(true);
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Documents',
            extensions: ['pdf', 'md', 'txt', 'docx', 'doc', 'odt', 'epub', 'mobi'],
          },
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        const result = await importFiles(projectId, selectedFolderId, paths);

        // Successful adds are visible in the list immediately; only report
        // what the user couldn't get — skipped duplicates and hard failures
        const notices: string[] = [];
        if (result.duplicates.length > 0) {
          notices.push(`Already in this location (skipped): ${result.duplicates.join(', ')}`);
        }
        if (result.failures.length > 0) {
          notices.push(`Could not add:\n${result.failures.join('\n')}`);
        }
        if (notices.length > 0) {
          const lead = result.added.length > 0
            ? `Added ${result.added.length} file${result.added.length === 1 ? '' : 's'}.\n`
            : '';
          alert(lead + notices.join('\n'));
        }
      }
    } catch (error) {
      alert(`Failed to add files: ${errorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleVerify = async () => {
    try {
      setVerifying(true);
      const missing = await verifyLibrary();
      const totalFiles = Object.keys(libraryFiles).length;
      alert(
        missing.length === 0
          ? `All ${totalFiles} library files were found on disk.`
          : `${missing.length} of ${totalFiles} library files could not be found on disk — they are flagged “Missing” in the list. If a file moved, re-add it from its new location, or remove the stale reference.`
      );
    } catch (error) {
      alert(`Could not check files on disk: ${errorMessage(error)}`);
    } finally {
      setVerifying(false);
    }
  };

  // Panel keyboard shortcuts: ⌘A select all in view, ⌫/Delete remove, F2 rename.
  // Reads live state through getState()/refs so the listener never re-binds.
  const visibleRef = useRef<{ fileIds: string[]; hasVisible: boolean }>({ fileIds: [], hasVisible: false });
  useEffect(() => {
    visibleRef.current = { fileIds: files.map((f) => f.id), hasVisible: files.length > 0 };
  }, [files]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const store = useBooks.getState();
      if (!store.activeProjectId) return;

      // ⌘/Ctrl+A — select every file in the current view (native text-select
      // still works while typing: the guard above returns first)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const { fileIds, hasVisible } = visibleRef.current;
        if (!hasVisible) return;
        event.preventDefault();
        store.setSelectedFiles(fileIds);
        return;
      }

      // ⌫ / Delete — remove the selection (same confirm as the button)
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const ids = store.selectedFileIds;
        if (ids.length === 0) return;
        event.preventDefault();
        void (async () => {
          if (
            await appConfirm(
              `Remove ${ids.length} file(s) from the library? Actual files will not be deleted.`
            )
          ) {
            store.removeFiles(ids);
          }
        })();
        return;
      }

      // F2 — rename the single selected file, if it's in this view
      if (event.key === 'F2') {
        if (store.selectedFileIds.length !== 1) return;
        const [onlyId] = store.selectedFileIds;
        if (!visibleRef.current.fileIds.includes(onlyId)) return;
        event.preventDefault();
        setRenameId(onlyId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="book-file-list">
      <div className="books-panel-header">
        <div className="books-panel-title">
          <span>{title}</span>
          {files.length > 0 && <span className="folder-count">{files.length}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!searchQuery && clipboard && clipboard.fileIds.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handlePaste}
              title={`Paste ${clipboard.fileIds.length} file${clipboard.fileIds.length === 1 ? '' : 's'} into "${title}"`}
            >
              <ClipboardPaste size={14} />
              Paste {clipboard.fileIds.length}
            </button>
          )}
          {files.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSelectedFiles(allSelected ? [] : files.map((f) => f.id))}
              title={allSelected ? 'Clear selection' : 'Select all files (⌘A)'}
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              openCitations(
                (selectedFileIds.length > 0 ? selectedFileIds : files.map((f) => f.id)).filter((id) => {
                  const target = libraryFiles[id];
                  return !!target && isCitationCapable(target.extension);
                }),
              )
            }
            disabled={files.length === 0}
            title={
              selectedFileIds.length > 0
                ? 'Get citations for the selected books'
                : 'Get citations for every book in this view'
            }
          >
            <BookMarked size={14} />
            Citations
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleVerify}
            disabled={verifying || Object.keys(libraryFiles).length === 0}
            title="Check every referenced file against the disk and flag the missing ones"
          >
            <FileQuestion size={14} className={verifying ? 'btn-spin' : undefined} />
            {verifying ? 'Checking…' : 'Verify'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleImport}
            disabled={importing}
            title="Add files to this project — they are referenced in place, never copied"
          >
            {importing ? <Upload size={14} className="btn-spin" /> : <Plus size={14} />}
            {importing ? 'Adding…' : 'Add files'}
          </button>
        </div>
      </div>

      {selectedFileIds.length > 0 && (
        <div className="book-file-selection">
          <span>
            {selectedFileIds.length} selected
          </span>
          <span className="book-file-selection-spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => copyToClipboard(selectedFileIds)}
            title="Copy — then paste (⌘/Ctrl+V) or drop with Alt into any folder or project"
          >
            <Copy size={14} />
            Copy
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => cutToClipboard(selectedFileIds)}
            title="Cut — then paste (⌘/Ctrl+V) or drop into any folder or project"
          >
            <Scissors size={14} />
            Cut
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              openCitations(
                selectedFileIds.filter((id) => {
                  const target = libraryFiles[id];
                  return !!target && isCitationCapable(target.extension);
                }),
              )
            }
            title="Get and export citations for the selected books"
          >
            <BookMarked size={14} />
            Citations
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger-text"
            title="Remove selection (⌫)"
            onClick={async () => {
              if (
                await appConfirm(
                  `Remove ${selectedFileIds.length} file(s) from the library? Actual files will not be deleted.`
                )
              ) {
                removeFiles(selectedFileIds);
              }
            }}
          >
            <Trash2 size={14} />
            Remove
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelectedFiles([])}>
            Clear
          </button>
        </div>
      )}

      <div
        ref={bodyDropRef}
        data-books-drop=""
        className="book-file-body"
      >
        {files.length === 0 && !searchQuery && (
          <div className="books-panel-empty">
            <Plus size={36} strokeWidth={1.4} />
            <h4>{activeFolder ? 'This folder is empty' : 'No files yet'}</h4>
            <p>Add files to start building your library — they are referenced in place, never copied.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={handleImport}>
              <Plus size={14} />
              Add files
            </button>
          </div>
        )}

        {files.length === 0 && searchQuery && (
          <div className="books-panel-empty">
            <FileSearch size={36} strokeWidth={1.4} />
            <h4>No files found</h4>
            <p>
              Nothing matches “{searchQuery}” in{' '}
              {searchProjectIds === null ? 'this project' : 'the selected search scope'}.
            </p>
          </div>
        )}

        {files.map((file) => {
          const selected = selectedFileIds.includes(file.id);
          // The row's drop target: the viewed folder normally; in search
          // results, the file's own home so results accept drops again
          const dropLocation = searchQuery
            ? getFileLocation(file.id)
            : { projectId, folderId: selectedFolderId };
          return (
            <FileRow
              key={file.id}
              file={file}
              selected={selected}
              cut={!!cutIds && cutIds.has(file.id)}
              missing={missingFileIds.includes(file.id)}
              searching={!!searchQuery}
              dropLocation={dropLocation}
              wantRename={renameId === file.id}
              onRenameOpened={() => setRenameId(null)}
              onAddCitation={
                isCitationCapable(file.extension) ? () => setAddCitationFileId(file.id) : undefined
              }
              onSelectRow={() => {
                if (!booksClickSuppressed()) setSelectedFiles(selected && selectedFileIds.length === 1 ? [] : [file.id]);
              }}
              onToggleCheck={() => toggleFileSelection(file.id)}
            />
          );
        })}
      </div>

      <CitationsDialog open={citationsOpen} onClose={() => setCitationsOpen(false)} fileIds={citationScope} />

      <AddCitationDialog
        key={addCitationFileId ?? 'none'}
        open={addCitationFileId !== null}
        onClose={() => setAddCitationFileId(null)}
        fileId={addCitationFileId}
      />
    </div>
  );
}
