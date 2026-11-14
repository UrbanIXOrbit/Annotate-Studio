'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ExternalLink,
  Inbox as InboxIcon,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  endOfDayGroup,
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
  readCaptureNote,
  resolveInboxPath,
  writeCaptureNote,
} from '@/lib/scratch-actions';
import { confirmDialog } from '@/store/dialogs';
import { useInbox } from '@/store/inbox';
import { useNotes } from '@/store/notes';
import { useScratch } from '@/store/scratch';
import { useSettings } from '@/store/settings';
import { cn } from '@/lib/utils';

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
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
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
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
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
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onEdit}
    >
      <div className="inbox-card-head">
        <span className="inbox-card-time">{card.time ?? '—'}</span>
        <div className="inbox-card-actions">
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
  const [lineEnding, setLineEnding] = useState<'\n' | '\r\n'>('\n');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [hint, setHint] = useState<{ start: number; where: 'before' | 'after' } | null>(null);

  // While the note is open in a window its buffer is the source of truth, so
  // the board never shows an older copy than the editor.
  const live = useNotes((state) => {
    if (!path) return undefined;
    const buffer = state.buffers[path];
    return buffer && buffer.status === 'ready' && buffer.editable ? buffer.content : undefined;
  });

  const text = live ?? content ?? '';
  const cards = useMemo(() => parseInbox(text), [text]);
  const counts = useMemo(() => laneCounts(cards), [cards]);
  const total = counts.inbox + counts.todo + counts.done;

  const load = useCallback(async () => {
    if (!path) {
      setContent(null);
      return;
    }
    setLoading(true);
    try {
      const read = await readCaptureNote(path);
      setContent(read);
      if (read !== null) setLineEnding(read.includes('\r\n') ? '\r\n' : '\n');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  // Captures are written while the composer is open; refresh as it closes.
  const wasComposing = useRef(false);
  useEffect(() => {
    if (wasComposing.current && !composing) void load();
    wasComposing.current = composing;
  }, [composing, load]);

  // External edits (or a sync client) land while the window is elsewhere.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Switching notes should not carry an open editor or drag state across.
  useEffect(() => {
    setEditing(null);
    setDraft('');
    setDragging(null);
    setHint(null);
  }, [path]);

  const apply = useCallback(
    async (next: string) => {
      if (!path) return;
      setContent(next);
      await writeCaptureNote(path, next, lineEnding);
    },
    [path, lineEnding],
  );

  const cardAt = (start: number | null) => (start === null ? undefined : cards.find((card) => card.start === start));

  const capture = () => {
    const target = selectedPath && selectedPath !== defaultPath ? selectedPath : undefined;
    useScratch.getState().openComposer(target ? { targetPath: target } : undefined);
  };

  const beginEdit = (card: InboxCard) => {
    setEditing(card.start);
    setDraft(card.text);
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };

  const saveEdit = async (card: InboxCard) => {
    if (!draft.trim()) return;
    const next = setCardText(text, card, draft);
    setEditing(null);
    setDraft('');
    if (next !== text) await apply(next);
  };

  const moveLane = async (card: InboxCard, lane: InboxLane) => {
    if (card.lane === lane) return;
    await apply(setCardLane(text, card, lane));
  };

  const deleteCard = async (card: InboxCard) => {
    const preview = card.text.split('\n')[0];
    const confirmed = await confirmDialog({
      title: 'Delete this capture?',
      message: preview.length > 140 ? `${preview.slice(0, 140)}…` : preview,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (confirmed) await apply(removeCard(text, card));
  };

  const dropOnCard = async (target: InboxCard, where: 'before' | 'after') => {
    const card = cardAt(dragging);
    setDragging(null);
    setHint(null);
    if (!card || card.start === target.start) return;
    // Visual order is newest-first inside a day, so "above the card" is the
    // line after its block. Dropping onto another day keeps the capture under
    // its own date heading and only changes the lane.
    const insertAt =
      target.heading === card.heading
        ? where === 'before'
          ? target.end + 1
          : target.start
        : endOfDayGroup(text, cards, card);
    const next = moveCard(text, card, target.lane, insertAt);
    if (next !== text) await apply(next);
  };

  const dropOnLane = async (lane: InboxLane) => {
    const card = cardAt(dragging);
    setDragging(null);
    setHint(null);
    if (!card || card.lane === lane) return;
    const next = moveCard(text, card, lane, endOfDayGroup(text, cards, card));
    if (next !== text) await apply(next);
  };

  const dragOverCard = (event: React.DragEvent, card: InboxCard) => {
    const dragged = cardAt(dragging);
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dragged.start === card.start || dragged.heading !== card.heading) {
      setHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const where = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setHint((current) =>
      current && current.start === card.start && current.where === where ? current : { start: card.start, where },
    );
  };

  const dragOverLane = (event: React.DragEvent) => {
    if (dragging === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setHint(null);
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

  return (
    <div className="page inbox-page">
      <header className="page-header">
        <div>
          <h1>Inbox</h1>
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
            <option value={defaultPath ?? ''}>Inbox</option>
            {captureNotes.map((note) => (
              <option key={note.path} value={note.path}>
                {note.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost" onClick={() => void load()} title="Reload the note">
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={content === null}
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

      {content === null && !loading ? (
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
        <div className={cn('inbox-board', dragging !== null && 'is-dragging')}>
          {LANES.map((lane) => {
            const sections = laneSections(cards, lane.id);
            return (
              <section
                key={lane.id}
                className="inbox-lane"
                onDragOver={dragOverLane}
                onDrop={(event) => {
                  event.preventDefault();
                  void dropOnLane(lane.id);
                }}
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
                            editing={editing === card.start}
                            draft={draft}
                            hint={hint && hint.start === card.start ? hint.where : null}
                            onDraft={setDraft}
                            onEdit={() => beginEdit(card)}
                            onSave={() => void saveEdit(card)}
                            onCancel={cancelEdit}
                            onDelete={() => void deleteCard(card)}
                            onLane={(next) => void moveLane(card, next)}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('text/plain', String(card.start));
                              setDragging(card.start);
                              setHint(null);
                            }}
                            onDragEnd={() => {
                              setDragging(null);
                              setHint(null);
                            }}
                            onDragOver={(event) => dragOverCard(event, card)}
                            onDrop={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              const where = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                              void dropOnCard(card, where);
                            }}
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
