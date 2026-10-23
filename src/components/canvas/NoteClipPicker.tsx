'use client';

import React, { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { FilePlus2, NotebookPen, Search } from 'lucide-react';
import Popover from '@/components/ui/Popover';
import { useLibrary } from '@/store/library';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { useSettings } from '@/store/settings';
import { clipKindFor, noteLabel, orderNotes } from '@/lib/note-clip';
import { cn } from '@/lib/utils';

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onPickNote: (path: string) => void;
  onPickNew: () => void;
}

function PickerBody({ onPickNote, onPickNew }: Pick<Props, 'onPickNote' | 'onPickNew'>) {
  const files = useLibrary((state) => state.files);
  const resources = useCanvas((state) => activeWorkspace(state).resources);
  const lastNote = useSettings((state) => state.noteClip.lastNote);
  const highlight = useSettings((state) => state.noteClip.highlight);
  const updateNoteClip = useSettings((state) => state.updateNoteClip);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const openPaths = useMemo(() => new Set(resources.flatMap((r) => (r.type === 'note' && r.filePath ? [r.filePath] : []))), [resources]);
  const notes = useMemo(() => orderNotes(files, { lastPath: lastNote, openPaths, query }), [files, lastNote, openPaths, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.note-pick-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, notes]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(notes.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = notes[active];
      if (chosen) onPickNote(chosen.path);
      else if (notes.length === 0) onPickNew();
    }
  };

  return (
    <div className="note-picker" onKeyDown={onKeyDown}>
      <div className="note-pick-head">Copy to note</div>
      <div className="note-pick-search">
        <Search size={14} />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes…" aria-label="Search notes" dir="auto" />
      </div>
      <div className="note-pick-list" ref={listRef} role="listbox" aria-label="Notes">
        {notes.length === 0 ? (
          <div className="note-pick-empty">{query.trim() ? `No notes match “${query.trim()}”` : 'You have no notes yet.'}</div>
        ) : (
          notes.map((file, index) => (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={index === active}
              className={cn('note-pick-row', index === active && 'active')}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPickNote(file.path)}
              title={file.path}
            >
              <NotebookPen size={14} />
              <span className="note-pick-name">{noteLabel(file.name)}</span>
              {file.path === lastNote && <span className="note-pick-tag">Last used</span>}
              {openPaths.has(file.path) && <span className="note-pick-tag note-pick-tag-open">Open</span>}
              {clipKindFor(file) === 'text' && <span className="note-pick-tag">.txt</span>}
            </button>
          ))
        )}
      </div>
      <button type="button" className="note-pick-new" onClick={onPickNew}>
        <FilePlus2 size={14} /> New note…
      </button>
      <label className="note-pick-toggle">
        <input type="checkbox" checked={highlight} onChange={(event) => updateNoteClip({ highlight: event.target.checked })} /> Also highlight it in the PDF
      </label>
    </div>
  );
}

/** Chooser shown from the PDF selection menu: pick the note the selected text is copied into. */
export default function NoteClipPicker({ anchorRef, open, onClose, onPickNote, onPickNew }: Props) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={320} className="note-picker-popover">
      <PickerBody onPickNote={onPickNote} onPickNew={onPickNew} />
    </Popover>
  );
}
