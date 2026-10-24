'use client';

import React, { useState } from 'react';
import { useBooks, type BookFile } from '@/store/books';
import { RowMenu } from './RowMenu';
import {
  beginBooksDrag,
  createDragBadge,
  endBooksDrag,
  useBooksDropTarget,
} from './dnd';
import {
  Upload,
  FileText,
  File,
  Image as ImageIcon,
  Trash2,
  Pencil,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  FileSearch,
  Copy,
  Scissors,
  ClipboardPaste,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { openExternalFile, revealExternalFile } from '@/lib/tauri-commands';
import { useCanvas } from '@/store/canvas';
import { useApp } from '@/store/app';
import { cn, formatBytes } from '@/lib/utils';
import { IMAGE_EXTENSIONS, NOTE_EXTENSIONS } from '@/lib/workspace-actions';

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
  onSelectRow,
  onToggleCheck,
}: {
  file: BookFile;
  selected: boolean;
  cut: boolean;
  onSelectRow: () => void;
  onToggleCheck: () => void;
}) {
  const { updateFile, removeFiles, selectedFileIds, setSelectedFiles, copyToClipboard, cutToClipboard } = useBooks();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [dragging, setDragging] = useState(false);

  // Row-scoped actions operate on the whole selection when this row is part of it
  const effectiveIds = selected && selectedFileIds.includes(file.id) ? selectedFileIds : [file.id];

  const handleDragStart = (event: React.DragEvent) => {
    const ids = selected && selectedFileIds.length > 1 ? selectedFileIds : [file.id];
    if (!selected) setSelectedFiles([file.id]);
    const badge = ids.length > 1 ? createDragBadge(`${ids.length} files`) : undefined;
    beginBooksDrag(event.dataTransfer, { kind: 'files', fileIds: ids }, badge);
    setDragging(true);
  };

  const handleDragEnd = () => {
    endBooksDrag();
    setDragging(false);
  };

  const handleRename = () => {
    if (editName.trim()) updateFile(file.id, { name: editName.trim() });
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
    let type: 'pdf' | 'image' | 'note' | null = null;

    if (ext === 'pdf') {
      type = 'pdf';
    } else if (IMAGE_EXTENSIONS.includes(ext)) {
      type = 'image';
    } else if (NOTE_EXTENSIONS.includes(ext)) {
      type = 'note';
    }

    if (!type) {
      alert('This file type cannot be opened on the canvas. Only PDFs, images, and text notes are supported.');
      return;
    }

    try {
      const canvas = useCanvas.getState();
      canvas.openResource({ type, title: file.name, filePath: file.filePath }, { isExternal: true });
      useApp.getState().setView('canvas');
    } catch (error) {
      alert(`Failed to open file on canvas: ${error}`);
    }
  };

  const handleRemove = () => {
    if (confirm(`Remove "${file.name}" from the library? The actual file will not be deleted.`)) {
      removeFiles([file.id]);
    }
  };

  return (
    <div
      className={cn('book-file', selected && 'selected', dragging && 'dragging', cut && 'cut')}
      draggable={!editing}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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
            <div className="book-file-name">{file.name}</div>
            <div className="book-file-meta">
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
}

export function BookFileList({ projectId, searchQuery }: BookFileListProps) {
  const {
    folders,
    selectedFolderId,
    selectedFileIds,
    setSelectedFiles,
    toggleFileSelection,
    getProjectFiles,
    searchFiles,
    importFiles,
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

  const files = searchQuery
    ? searchFiles(searchQuery, projectId)
    : getProjectFiles(projectId, selectedFolderId);

  const activeFolder = selectedFolderId ? folders[selectedFolderId] : null;
  const title = searchQuery ? 'Search results' : activeFolder ? activeFolder.name : 'All files';
  const allSelected = files.length > 0 && selectedFileIds.length === files.length;
  const cutIds = clipboard?.mode === 'cut' ? new Set(clipboard.fileIds) : null;

  // The files panel is itself a drop target: dropping here moves (or, with
  // Alt/Option, copies) into the folder currently being viewed. Search
  // results span folders, so drops are disabled while searching.
  const bodyDrop = useBooksDropTarget({
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
        await importFiles(projectId, selectedFolderId, paths);
      }
    } catch (error) {
      alert(`Failed to import files: ${error}`);
    } finally {
      setImporting(false);
    }
  };

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
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" onClick={handleImport} disabled={importing}>
            <Upload size={14} />
            {importing ? 'Importing…' : 'Import'}
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
            className="btn btn-sm btn-danger-text"
            onClick={() => {
              if (
                confirm(
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
        className={cn(
          'book-file-body',
          bodyDrop.isActive && 'drop-target',
          bodyDrop.isActive && bodyDrop.mode === 'copy' && 'drop-copy',
        )}
        {...bodyDrop.handlers}
      >
        {files.length === 0 && !searchQuery && (
          <div className="books-panel-empty">
            <Upload size={36} strokeWidth={1.4} />
            <h4>{activeFolder ? 'This folder is empty' : 'No files yet'}</h4>
            <p>Import files to start building your library — they are referenced in place, never copied.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={handleImport}>
              <Upload size={14} />
              Import files
            </button>
          </div>
        )}

        {files.length === 0 && searchQuery && (
          <div className="books-panel-empty">
            <FileSearch size={36} strokeWidth={1.4} />
            <h4>No files found</h4>
            <p>Nothing matches “{searchQuery}” in this project.</p>
          </div>
        )}

        {files.map((file) => {
          const selected = selectedFileIds.includes(file.id);
          return (
            <FileRow
              key={file.id}
              file={file}
              selected={selected}
              cut={!!cutIds && cutIds.has(file.id)}
              onSelectRow={() => setSelectedFiles(selected && selectedFileIds.length === 1 ? [] : [file.id])}
              onToggleCheck={() => toggleFileSelection(file.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
