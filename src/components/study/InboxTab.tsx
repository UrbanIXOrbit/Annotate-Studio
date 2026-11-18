'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Inbox as InboxIcon,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  cardKey,
  endOfDayGroup,
  findCard,
  laneCounts,
  laneSections,
  moveCard,
  parseInbox,
  removeCard,
  setCardLane,
  setCardText,
  type InboxCard,
  type InboxLane,
} from '@/lib/inbox-board';
import {
  inboxPathFor,
  openCaptureNote,
  readCaptureFile,
  readCaptureNote,
  resolveInboxPath,
  writeCaptureNote,
} from '@/lib/scratch-actions';
import { confirmDialog } from '@/store/dialogs';
import { useInbox } from '@/store/inbox';
import { useNotes } from '@/store/notes';
import { useScratch } from '@/store/scratch';
import { useSettings } from '@/store/settings';
import { useToasts } from '@/store/toast';
import { baseName, cn, stripExtension } from '@/lib/utils';
import { beginInboxDrag, cancelInboxDrag, type InboxDragSnapshot, type InboxDropTarget } from './inbox-dnd';

const LANES: Array<{ id: InboxLane; label: string; hint: string }> = [
  { id: 'inbox', label: 'Inbox', hint: 'Fresh captures' },
  { id: 'todo', label: 'To do', hint: 'Committed work' },
  { id: 'done', label: 'Done', hint: 'Finished' },
];

function dayLabel(heading: string): string {
  return heading.replace(/^##\s+/, '').trim() || 'Unsorted';
}

interface BoardCardProps {
  card: InboxCard;
  editing: boolean;
  draft: string;
  hint: 'before' | 'after' | null;
  onDraft: (value: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onLane: (lane: InboxLane) => void;
  onCopy: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

/** One capture. Double-click (or the pencil) edits the markdown line in place. */
function BoardCard({
  card,
  editing,
  draft,
  hint,
  onDraft,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onLane,
  onCopy,
  onPointerDown,
}: BoardCardProps) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <article
      className={cn(
        'inbox-card',
        hint === 'before' && 'inbox-card-before',
        hint === 'after' && 'inbox-card-after',
        editing && 'inbox-card-editing',
      )}
      data-inbox-card={card.start}
      data-inbox-key={cardKey(card)}
      data-inbox-lane={card.lane}
      onPointerDown={editing ? undefined : onPointerDown}
    >
      <div className="inbox-card-head">
        <span className="inbox-card-time">{card.time ?? '—'}</span>
        <div className="inbox-card-actions" onDoubleClick={(event) => event.stopPropagation()}>
          {card.lane !== 'todo' && (
            <button type="button" className="icon-btn icon-btn-sm" title="Move to To do" onClick={() => onLane('todo')}>
              <ArrowRight size={12} />
            </button>
          )}
          {card.lane !== 'done' && (
            <button type="button" className="icon-btn icon-btn-sm" title="Mark done" onClick={() => onLane('done')}>
              <Check size={12} />
            </button>
          )}
          {card.lane !== 'inbox' && (
            <button type="button" className="icon-btn icon-btn-sm" title="Move back to Inbox" onClick={() => onLane('inbox')}>
              <RotateCcw size={12} />
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-sm" title="Edit capture" onClick={onEdit}>
            <Pencil size={12} />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" title="Copy capture text" onClick={onCopy}>
            <Copy size={12} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm icon-btn-danger"
            title="Delete capture"
            onClick={onDelete}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="inbox-editor">
          <textarea
            autoFocus
            dir="auto"
            rows={Math.min(7, Math.max(2, draft.split('\n').length + 1))}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Capture text"
          />
          <div className="inbox-editor-actions">
            <span className="inbox-editor-hint">Enter saves · Esc cancels</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={onSave}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="inbox-card-text" dir="auto">
          {card.text}
        </p>
      )}
    </article>
  );
}

/**
 * The Inbox section: a canvas-style triage board over a plain markdown note.
 * Three lanes, free vertical arrangement within a day, and every move or edit
 * rewrites only the affected bullet so the note stays portable.
 */
export default function InboxTab() {
  const selectedPath = useInbox((state) => state.selectedPath);
  const select = useInbox((state) => state.select);
  const captureNotes = useSettings((state) => state.captureNotes);
  const configuredInbox = useSettings((state) => state.inboxNotePath);
  const noteFolder = useSettings((state) => state.noteFolder);
  const composing = useScratch((state) => state.composing);

  const defaultPath = useMemo(
    () => configuredInbox || (noteFolder ? inboxPathFor(noteFolder) : null),
    [configuredInbox, noteFolder],
  );
  const path = selectedPath ?? defaultPath;

  const [content, setContent] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [lineEnding, setLineEnding] = useState<'\n' | '\r\n'>('\n');
  const [loading, setLoading] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<InboxDragSnapshot>({ dragging: null, target: null });

  // Board edits are queued and re-read at execution time, so two quick actions
  // (or a background refresh) can never overwrite each other with stale text.
  const pendingRef = useRef<Promise<void>>(Promise.resolve());
  const busyRef = useRef(0);

  // While the note is open in a window its buffer is the source of truth, so
  // the board never shows an older copy than the editor.
  const live = useNotes((state) => {
    if (!path) return undefined;
    const buffer = state.buffers[path];
    return buffer && buffer.status === 'ready' && buffer.editable ? buffer.content : undefined;
  });

  const loaded = loadedPath === path ? content : null;
  const hasContent = live !== undefined || loaded !== null;
  const text = live ?? loaded ?? '';
  const cards = useMemo(() => parseInbox(text), [text]);
  const counts = useMemo(() => laneCounts(cards), [cards]);
  const total = counts.inbox + counts.todo + counts.done;

  const load = useCallback(async () => {
    if (!path) {
      setContent(null);
      setLoadedPath(null);
      return;
    }
    setLoading(true);
    try {
      const read = await readCaptureNote(path);
      setContent(read);
      setLoadedPath(path);
      if (read !== null) setLineEnding(read.includes('\r\n') ? '\r\n' : '\n');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    if (busyRef.current === 0) void load();
  }, [load]);

  // Captures are written while the composer is open; refresh as it closes.
  const wasComposing = useRef(false);
  useEffect(() => {
    if (wasComposing.current && !composing) reload();
    wasComposing.current = composing;
  }, [composing, reload]);

  // External edits (or a sync client) land while the window is elsewhere.
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  // Switching notes should not carry an open editor or drag state across.
  useEffect(() => {
    cancelInboxDrag();
    setEditingKey(null);
    setDraft('');
    setDrag({ dragging: null, target: null });
  }, [path]);

  // A pointer drag lives on window listeners; drop them if the board unmounts.
  useEffect(() => cancelInboxDrag, []);

  /**
   * Queue a board edit. The change runs against the note as it exists when its
   * turn comes — not the text captured by an older render — and a failed write
   * rolls back to the file on disk rather than the optimistic editor buffer.
   */
  const applyChange = useCallback(
    (change: (current: string) => string | null) => {
      busyRef.current += 1;
      const task = pendingRef.current.then(async () => {
        if (!path) return;
        const current = await readCaptureNote(path);
        if (current === null) return;
        const next = change(current);
        if (!next || next === current) return;
        setContent(next);
        setLoadedPath(path);
        const written = await writeCaptureNote(path, next, lineEnding);
        if (!written) {
          const disk = await readCaptureFile(path);
          // An open note's buffer still holds the optimistic edit; put the
          // disk copy back there too, or the live buffer would show it again.
          const notes = useNotes.getState();
          const buffer = notes.buffers[path];
          if (disk !== null && buffer && buffer.status === 'ready' && buffer.editable) {
            notes.edit(path, disk.replace(/\r\n?/g, '\n'));
          }
          setContent(disk);
          setLoadedPath(path);
        }
      });
      const settled = task
        .catch(() => undefined)
        .finally(() => {
          busyRef.current -= 1;
        });
      pendingRef.current = settled;
      return settled;
    },
    [path, lineEnding],
  );

  const capture = () => {
    const target = selectedPath && selectedPath !== defaultPath ? selectedPath : undefined;
    useScratch.getState().openComposer(target ? { targetPath: target } : undefined);
  };

  const beginEdit = (card: InboxCard) => {
    setEditingKey(cardKey(card));
    setDraft(card.text);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft('');
  };

  const saveEdit = (key: string, value: string) => {
    if (!value.trim()) return;
    void applyChange((current) => {
      const card = findCard(parseInbox(current), key);
      return card ? setCardText(current, card, value) : null;
    });
    cancelEdit();
  };

  const copyCard = async (card: InboxCard) => {
    try {
      await navigator.clipboard.writeText(card.text);
      useToasts.getState().push({ kind: 'success', title: 'Capture copied' });
    } catch {
      useToasts.getState().push({ kind: 'error', title: 'Could not copy capture' });
    }
  };

  const moveLane = (key: string, lane: InboxLane) => {
    void applyChange((current) => {
      const card = findCard(parseInbox(current), key);
      return card && card.lane !== lane ? setCardLane(current, card, lane) : null;
    });
  };

  const deleteCard = async (card: InboxCard) => {
    const key = cardKey(card);
    const preview = card.text.split('\n')[0];
    const confirmed = await confirmDialog({
      title: 'Delete this capture?',
      message: preview.length > 140 ? `${preview.slice(0, 140)}…` : preview,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    await applyChange((current) => {
      const found = findCard(parseInbox(current), key);
      return found ? removeCard(current, found) : null;
    });
  };

  const handleDrop = (sourceKey: string, target: InboxDropTarget) => {
    void applyChange((current) => {
      const cardsNow = parseInbox(current);
      const card = findCard(cardsNow, sourceKey);
      if (!card) return null;
      if (target.key === null) {
        if (card.lane === target.lane) return null;
        return moveCard(current, card, target.lane, endOfDayGroup(current, cardsNow, card));
      }
      const targetCard = findCard(cardsNow, target.key);
      if (!targetCard || targetCard.start === card.start) return null;
      // Visual order is newest-first inside a day, so "above the card" is the
      // line after its block. Dropping onto another day keeps the capture under
      // its own date heading and only changes the lane.
      const insertAt =
        targetCard.heading === card.heading
          ? target.where === 'before'
            ? targetCard.end + 1
            : targetCard.start
          : endOfDayGroup(current, cardsNow, card);
      return moveCard(current, card, target.lane, insertAt);
    });
  };

  const startCardDrag = (event: React.PointerEvent<HTMLElement>, card: InboxCard) => {
    const key = cardKey(card);
    if (editingKey === key) return;
    beginInboxDrag(event, {
      key,
      label: card.text.split('\n')[0],
      onDrop: handleDrop,
      onDoubleClick: (sourceKey) => {
        const tapped = findCard(cards, sourceKey);
        if (tapped) beginEdit(tapped);
      },
      onState: setDrag,
    });
  };

  if (!path) {
    return (
      <div className="page page-narrow">
        <header className="page-header">
          <div>
            <h1>Inbox</h1>
            <p>Quick captures, triaged on a board.</p>
          </div>
        </header>
        <div className="empty-state">
          <InboxIcon size={28} />
          <h2>Choose where captures live</h2>
          <p>
            Captures are appended to a plain <code>Inbox.md</code> in a folder you pick. Nothing is copied into the
            app, so the note stays yours and syncs with whatever you already use.
          </p>
          <div className="empty-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const resolved = await resolveInboxPath();
                if (resolved) select(resolved);
              }}
            >
              Choose notes folder
            </button>
          </div>
        </div>
      </div>
    );
  }

  const noteTitle = stripExtension(baseName(path));

  return (
    <div className="page inbox-page">
      <header className="page-header">
        <div>
          <h1>{noteTitle}</h1>
          <p>
            {total === 0
              ? 'Captures land here, then move across the board.'
              : `${total} capture${total === 1 ? '' : 's'} · ${counts.todo} to do · ${counts.done} done`}
          </p>
        </div>
        <div className="page-actions">
          <select
            className="select select-sm inbox-note-picker"
            value={selectedPath ?? defaultPath ?? ''}
            onChange={(event) => select(event.target.value || null)}
            aria-label="Capture note"
            title="Choose the note the board reads"
          >
            <option value={defaultPath ?? ''}>{defaultPath ? stripExtension(baseName(defaultPath)) : 'Inbox'}</option>
            {captureNotes
              .filter((note) => note.path !== defaultPath)
              .map((note) => (
                <option key={note.path} value={note.path}>
                  {stripExtension(baseName(note.path)) || note.name}
                </option>
              ))}
          </select>
          <button type="button" className="btn btn-ghost" onClick={() => void load()} title="Reload the note">
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!hasContent}
            onClick={() => openCaptureNote(path)}
            title="Edit the raw markdown on the canvas"
          >
            <ExternalLink size={15} /> Open note
          </button>
          <button type="button" className="btn btn-primary" onClick={capture} title="Capture (Ctrl+Alt+I)">
            <InboxIcon size={15} /> Capture
          </button>
        </div>
      </header>

      {!hasContent && !loading ? (
        <div className="empty-state inbox-empty">
          <InboxIcon size={28} />
          <h2>No captures yet</h2>
          <p>
            Press <kbd>⌘⌥I</kbd> anywhere, or use Capture above. Captures append to this note under today's date.
          </p>
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={capture}>
              Capture something
            </button>
          </div>
        </div>
      ) : (
        <div className={cn('inbox-board', drag.dragging !== null && 'is-dragging')}>
          {LANES.map((lane) => {
            const sections = laneSections(cards, lane.id);
            const laneTarget = drag.target?.lane === lane.id;
            return (
              <section
                key={lane.id}
                className={cn('inbox-lane', laneTarget && 'inbox-lane-drop')}
                data-inbox-lane={lane.id}
              >
                <header className="inbox-lane-head">
                  <h2>{lane.label}</h2>
                  <span className="inbox-count">{counts[lane.id]}</span>
                  <span className="inbox-lane-hint">{lane.hint}</span>
                </header>
                <div className="inbox-lane-body">
                  {sections.length === 0 ? (
                    <p className="inbox-lane-empty">
                      {lane.id === 'inbox' ? 'Drop captures here' : 'Drag cards here'}
                    </p>
                  ) : (
                    sections.map((section) => (
                      <div className="inbox-day" key={section.heading || 'unsorted'}>
                        <div className="inbox-day-head">{dayLabel(section.heading)}</div>
                        {[...section.cards].reverse().map((card) => (
                          <BoardCard
                            key={card.start}
                            card={card}
                            editing={editingKey === cardKey(card)}
                            draft={draft}
                            hint={drag.target && drag.target.key === cardKey(card) ? drag.target.where : null}
                            onDraft={setDraft}
                            onEdit={() => beginEdit(card)}
                            onSave={() => saveEdit(cardKey(card), draft)}
                            onCancel={cancelEdit}
                            onDelete={() => void deleteCard(card)}
                            onLane={(next) => moveLane(cardKey(card), next)}
                            onCopy={() => void copyCard(card)}
                            onPointerDown={(event) => startCardDrag(event, card)}
                          />
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
