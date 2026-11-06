import { create } from 'zustand';
import type { Guide, SpacingGuide } from '@/lib/layout';

interface GuidesStore {
  guides: Guide[];
  /** Equal-gap markers (with their sizes) shown while the gaps either side of a window match */
  spacing: SpacingGuide[];
  set: (guides: Guide[], spacing?: SpacingGuide[]) => void;
  clear: () => void;
}

/** Alignment guide lines and equal-spacing markers shown while windows are being
 * dragged or resized. Transient UI state; nothing here is persisted. */
export const useAlignmentGuides = create<GuidesStore>((set) => ({
  guides: [],
  spacing: [],
  set: (guides, spacing = []) => set({ guides, spacing }),
  clear: () => set({ guides: [], spacing: [] }),
}));
