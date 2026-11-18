'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { CARD_COLORS } from '@/lib/cards';
import { openCardSource } from '@/lib/card-actions';
import { cn } from '@/lib/utils';

function CardWindow({ id }: { id: string }) {
  const card = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === id));
  // Keep the draft local so each editing session becomes one undo step instead
  // of a patch per keystroke (which record=false would leave out of history).
  const [note, setNote] = useState(card?.note ?? '');
  const noteRef = useRef(note);
  const savedRef = useRef(card?.note ?? '');
  useEffect(() => {
    setNote(card?.note ?? '');
    savedRef.current = card?.note ?? '';
  }, [card?.note]);
  const commitNote = useCallback(() => {
    if (noteRef.current === savedRef.current) return;
    savedRef.current = noteRef.current;
    useCanvas.getState().updateResource(id, { note: noteRef.current }, true);
  }, [id]);
  const commitRef = useRef(commitNote);
  commitRef.current = commitNote;
  useEffect(() => () => commitRef.current(), []);
  const changeNote = (value: string) => {
    noteRef.current = value;
    setNote(value);
  };
  if (!card) return null;
  const color = card.color ?? CARD_COLORS[0];
  const quote = card.content?.trim() ?? '';
  const source = card.source;

  return (
    <div className="card-body" style={{ '--card-accent': color } as React.CSSProperties}>
      {quote && (
        <blockquote className="card-quote" dir="auto">
          {quote}
        </blockquote>
      )}
      <textarea
        className="card-note"
        dir="auto"
        placeholder={quote ? 'Add a comment…' : 'Write a thought…'}
        value={note}
        onChange={(event) => changeNote(event.target.value)}
        onBlur={commitNote}
      />
      <div className="card-footer" data-no-drag>
        <div className="card-colors">
          {CARD_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={cn('card-swatch', swatch === color && 'card-swatch-active')}
              style={{ background: swatch }}
              onClick={() => useCanvas.getState().updateResource(id, { color: swatch }, true)}
              title="Card colour"
              aria-label={`Colour ${swatch}`}
            />
          ))}
        </div>
        {source && (
          <button type="button" className="card-source" onClick={() => openCardSource(source)} title={`Open ${source.title} at page ${source.page}`}>
            <ArrowUpRight size={12} /> Page {source.page}
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(CardWindow);
