'use client';

import React, { useState } from 'react';
import { useBooks } from '@/store/books';
import { X, Tag, FileText, FileQuestion, Calendar, HardDrive, Pencil, Save, Plus, FolderOpen } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { errorMessage, revealExternalFile } from '@/lib/tauri-commands';
import { BookCitationSection } from './BookCitationSection';

interface BookFileDetailsProps {
  fileId: string;
  onClose: () => void;
}

export function BookFileDetails({ fileId, onClose }: BookFileDetailsProps) {
  const { files, missingFileIds, updateFile } = useBooks();
  const file = files[fileId];
  const isMissing = missingFileIds.includes(fileId);

  const [tagInput, setTagInput] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState('');
  /** Display-name rename — never touches filePath (used for duplicates/verification) */
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');

  if (!file) return null;

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed) {
      // Writing the display name; matching the original filename reverts the rename.
      updateFile(fileId, { displayName: trimmed === file.name ? undefined : trimmed });
    } else {
      updateFile(fileId, { displayName: undefined });
    }
    setEditingName(false);
  };

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (!tag || file.tags.includes(tag)) {
      setTagInput('');
      return;
    }
    updateFile(fileId, { tags: [...file.tags, tag] });
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    updateFile(fileId, { tags: file.tags.filter((t) => t !== tag) });
  };

  const handleSaveNotes = () => {
    updateFile(fileId, { notes: notesInput });
    setEditingNotes(false);
  };

  // Opens the containing folder when the file is missing (the Tauri command
  // falls back to the parent), so the user can see where the file went
  const handleReveal = async () => {
    try {
      await revealExternalFile(file.filePath);
    } catch (error) {
      alert(`Failed to reveal file: ${errorMessage(error)}`);
    }
  };

  return (
    <div className="book-file-details">
      <div className="books-panel-header">
        <div className="books-panel-title">
          <span>Details</span>
        </div>
        <button type="button" className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close details">
          <X size={15} />
        </button>
      </div>

      <div className="file-details-body">
        <div className="file-details-section">
          <div className="file-details-label">
            <FileText size={12} />
            File
          </div>
          {editingName ? (
            <div className="file-details-rename">
              <input
                className="input input-sm"
                value={nameInput}
                autoFocus
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                dir="auto"
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveName}>
                  <Save size={14} />
                  Save
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingName(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="file-details-value">{file.displayName || file.name}</div>
              <div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setNameInput(file.displayName || file.name);
                    setEditingName(true);
                  }}
                >
                  <Pencil size={13} />
                  Rename
                </button>
              </div>
            </>
          )}
          <div className="file-details-path">{file.filePath}</div>
          {file.displayName && <p className="file-details-hint">Original file name: {file.name}</p>}
          <p className="file-details-hint">
            Renaming only changes the display name — the file on disk and its path are never touched, so duplicate
            detection and verification keep working.
          </p>
          {isMissing && (
            <div className="file-details-missing">
              <p className="file-details-warning">
                <FileQuestion size={12} />
                Not found on disk — it may have been moved or deleted. Re-add it from its new location, or remove the
                stale reference.
              </p>
              <button type="button" className="btn btn-sm btn-secondary" onClick={handleReveal}>
                <FolderOpen size={13} />
                Show folder
              </button>
              <p className="file-details-hint">Opens the folder the file was imported from, even when the file moved.</p>
            </div>
          )}
        </div>

        <div className="file-details-section">
          <div className="file-details-label">
            <Tag size={12} />
            Tags
          </div>
          <div className="file-details-tags">
            {file.tags.length === 0 && <span className="file-details-empty">No tags yet</span>}
            {file.tags.map((tag) => (
              <span key={tag} className="file-details-tag">
                #{tag}
                <button
                  type="button"
                  className="file-details-tag-remove"
                  onClick={() => handleRemoveTag(tag)}
                  aria-label={`Remove tag ${tag}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <div className="file-details-tag-input">
            <input
              type="text"
              className="input input-sm"
              placeholder="Add a tag…"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTag();
                if (e.key === 'Escape') setTagInput('');
              }}
              dir="auto"
            />
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleAddTag} disabled={!tagInput.trim()}>
              <Plus size={14} />
              Add
            </button>
          </div>
        </div>

        <div className="file-details-section">
          <div className="file-details-label">
            <FileText size={12} />
            Notes
          </div>
          {editingNotes ? (
            <div className="file-details-notes-edit">
              <textarea
                className="textarea"
                value={notesInput}
                onChange={(e) => setNotesInput(e.target.value)}
                placeholder="Add notes about this file…"
                rows={5}
                autoFocus
                dir="auto"
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveNotes}>
                  <Save size={14} />
                  Save
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingNotes(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={cn('file-details-notes', !file.notes && 'file-details-empty')}>
                {file.notes || 'No notes yet'}
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setNotesInput(file.notes);
                    setEditingNotes(true);
                  }}
                >
                  <Pencil size={13} />
                  {file.notes ? 'Edit notes' : 'Add notes'}
                </button>
              </div>
            </>
          )}
        </div>

        <BookCitationSection fileId={fileId} />

        <div className="file-details-section">
          <div className="file-details-label">
            <HardDrive size={12} />
            File info
          </div>
          <div className="file-details-row">
            <span className="label">Type</span>
            <span className="value">{file.extension ? file.extension.toUpperCase() : '—'}</span>
          </div>
          <div className="file-details-row">
            <span className="label">Size</span>
            <span className="value">{formatBytes(file.size)}</span>
          </div>
        </div>

        <div className="file-details-section">
          <div className="file-details-label">
            <Calendar size={12} />
            Dates
          </div>
          <div className="file-details-row">
            <span className="label">Added</span>
            <span className="value">{new Date(file.addedAt).toLocaleDateString()}</span>
          </div>
          <div className="file-details-row">
            <span className="label">Modified</span>
            <span className="value">{new Date(file.modifiedAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
