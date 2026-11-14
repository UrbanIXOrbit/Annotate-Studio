'use client';

import React, { useEffect, useState } from 'react';
import { Inbox, Loader2 } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useScratch } from '@/store/scratch';
import { useSettings } from '@/store/settings';
import { captureTo } from '@/lib/scratch-actions';

/**
 * One-key capture. ⌘⌥I anywhere in the app opens this composer; the text is
 * appended to the Inbox note (or a named capture note) and the canvas is left
 * untouched. Enter files it, Esc discards.
 */
export default function ScratchCaptureDialog() {
  const composing = useScratch((state) => state.composing);
  const closeComposer = useScratch((state) => state.closeComposer);
  const captureNotes = useSettings((state) => state.captureNotes);
  const startWithNewNote = useScratch((state) => state.newNote);
  const startTarget = useScratch((state) => state.targetPath);
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh composer every time it opens; the last target is not sticky.
  useEffect(() => {
    if (!composing) return;
    setText('');
    setTarget(startWithNewNote ? '__new' : startTarget ?? '');
    setNewName('');
    setError(null);
  }, [composing, startWithNewNote, startTarget]);

  // ⌘⌥I (Ctrl+Alt+I) — the one key that starts a capture.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'i') return;
      if (useScratch.getState().composing) return;
      // Another dialog is already up; capturing can wait until it closes.
      if (typeof document !== 'undefined' && document.querySelector('.dialog-overlay')) return;
      event.preventDefault();
      useScratch.getState().openComposer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const creating = target === '__new';
  const canSave = text.trim().length > 0 && (!creating || newName.trim().length > 0) && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const written = await captureTo(
      {
        ...(target && !creating ? { path: target } : {}),
        ...(creating ? { newName } : {}),
      },
      text,
    );
    setSaving(false);
    if (written) {
      closeComposer();
      return;
    }
    // captureTo already surfaced the reason when it came from the filesystem.
    setError('Capture not saved — check that the notes folder is still available.');
  };

  const onComposerKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  return (
    <Dialog open={composing} onClose={closeComposer} title="Capture" width={560}>
      <div className="capture" onKeyDown={onComposerKeyDown}>
        <textarea
          className="textarea capture-input"
          data-autofocus
          dir="auto"
          rows={5}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          placeholder="What's on your mind? Markdown works — [[links]] and #tags too."
        />

        <div className="capture-target">
          <span className="capture-target-label">
            <Inbox size={13} /> To
          </span>
          <select
            className="select select-sm"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setError(null);
            }}
            aria-label="Capture note"
          >
            <option value="">Inbox</option>
            {captureNotes.map((note) => (
              <option key={note.path} value={note.path}>
                {note.name}
              </option>
            ))}
            <option value="__new">New capture note…</option>
          </select>
          {creating && (
            <input
              className="input input-sm capture-name"
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setError(null);
              }}
              placeholder="Note name"
              aria-label="New capture note name"
              dir="auto"
            />
          )}
          <span className="capture-hint">⌘Enter to save · Esc to close</span>
        </div>

        {error && <p className="capture-error">{error}</p>}

        <div className="capture-footer">
          <span className="capture-footer-spacer" />
          <button type="button" className="btn btn-ghost" onClick={closeComposer}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="btn-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}
