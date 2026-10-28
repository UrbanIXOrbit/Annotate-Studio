import { create } from 'zustand';
import type { Guide } from '@/lib/layout';

interface GuidesStore {
  guides: Guide[];
  set: (guides: Guide[]) => void;
}

/** Alignment guide lines shown while windows are being dragged. Transient UI
 * state; nothing here is persisted. */
export const useAlignmentGuides = create<GuidesStore>((set) => ({
  guides: [],
  set: (guides) => set({ guides }),
}));
