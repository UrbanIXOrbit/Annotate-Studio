'use client';

import React, { useRef } from 'react';
import NoteClipPicker from './NoteClipPicker';
import { useCardsClip } from '@/store/cards-clip';
import { cardClipsFor } from '@/lib/group-actions';
import { cardsToNewNote, cardsToNote } from '@/lib/note-clip-actions';

/** Shows the note picker for "send these cards to a note", wherever the request came from. */
export default function CardsNoteHost() {
  const request = useCardsClip((state) => state.request);
  const close = useCardsClip((state) => state.close);
  const anchor = useRef<HTMLDivElement>(null);
  if (!request) return null;

  return (
    <>
      <div ref={anchor} className="cards-note-anchor" style={{ position: 'fixed', left: request.x, top: request.y, width: 1, height: 1, pointerEvents: 'none' }} />
      <NoteClipPicker
        anchorRef={anchor}
        open
        onClose={close}
        showHighlight={false}
        title="Send cards to a note"
        onPickNote={(path) => {
          close();
          void cardsToNote(path, cardClipsFor(request.ids), request.heading);
        }}
        onPickNew={() => {
          close();
          void cardsToNewNote(cardClipsFor(request.ids), request.heading);
        }}
      />
    </>
  );
}
