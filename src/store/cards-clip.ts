import { create } from 'zustand';

export interface CardsClipRequest {
  /** The cards to send, as resource ids. */
  ids: string[];
  /** A heading for the section in the note (a group's name, for instance). */
  heading?: string;
  /** Where to show the picker (screen coordinates). */
  x: number;
  y: number;
}

interface CardsClipStore {
  request: CardsClipRequest | null;
  open: (request: CardsClipRequest) => void;
  close: () => void;
}

/** Asks the canvas to show the "send these cards to a note" picker. */
export const useCardsClip = create<CardsClipStore>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
