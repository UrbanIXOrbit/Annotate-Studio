import { create } from 'zustand';
import type { Point, Side } from '@/lib/connectors';

export interface ConnectDrag {
  fromId: string;
  fromSide: Side;
  pointer: Point;
  targetId: string | null;
  targetSide: Side | null;
}

interface ConnectUiStore {
  hoverId: string | null;
  drag: ConnectDrag | null;
  setHover: (id: string | null) => void;
  setDrag: (drag: ConnectDrag | null) => void;
}

/** Transient UI state for drawing connectors. Never persisted. */
export const useConnectUi = create<ConnectUiStore>((set, get) => ({
  hoverId: null,
  drag: null,
  setHover: (id) => {
    if (get().hoverId !== id && !get().drag) set({ hoverId: id });
  },
  setDrag: (drag) => set({ drag }),
}));
