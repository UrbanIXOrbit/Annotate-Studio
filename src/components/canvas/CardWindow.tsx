'use client';

import React, { memo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { CARD_COLORS } from '@/lib/cards';
import { openCardSource } from '@/lib/card-actions';
import { cn } from '@/lib/utils';

function CardWindow({ id }: { id: string }) {
  const card = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === id));
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
        value={card.note ?? ''}
        onChange={(event) => useCanvas.getState().updateResource(id, { note: event.target.value })}
      />
      <div className="card-footer" data-no-drag>
        <div className="card-colors">
          {CARD_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={cn('card-swatch', swatch === color && 'card-swatch-active')}
              style={{ background: swatch }}
              onClick={() => useCanvas.getState().updateResource(id, { color: swatch })}
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
