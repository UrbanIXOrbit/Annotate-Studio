import { create } from 'zustand';
import type { Guide, SpacingGuide } from '@/lib/layout';

interface GuidesStore {
  guides: Guide[];
  /** Equal-gap markers (with their sizes) shown while the gaps either side of a window match */
  spacing: SpacingGuide[];
  set: (guides: Guide[], spacing?: SpacingGuide[]) => void;
  clear: () => void;
}

let pendingFrame: number | null = null;
let pendingGuides: Guide[] = [];
let pendingSpacing: SpacingGuide[] = [];

function cancelPendingGuideFrame() {
  if (pendingFrame === null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingFrame);
  else clearTimeout(pendingFrame);
  pendingFrame = null;
}

/** Alignment guide lines and equal-spacing markers shown while windows are being
 * dragged or resized. Transient UI state; nothing here is persisted. */
export const useAlignmentGuides = create<GuidesStore>((set) => ({
  guides: [],
  spacing: [],
  // Pointer events can arrive faster than paint. Keep only the newest plan and
  // publish subsequent changes once per frame. The first plan is immediate so
  // the equal-gap measurement appears the instant a window reaches a snap.
  set: (guides, spacing = []) => {
    pendingGuides = guides;
    pendingSpacing = spacing;
    if (pendingFrame !== null) return;
    set({ guides, spacing });
    const publish = () => {
      pendingFrame = null;
      // Do not issue a second identical update when there was only one pointer
      // event in the frame.
      if (pendingGuides !== guides || pendingSpacing !== spacing) {
        set({ guides: pendingGuides, spacing: pendingSpacing });
      }
    };
    pendingFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(publish)
      : setTimeout(publish, 16) as unknown as number;
  },
  clear: () => {
    cancelPendingGuideFrame();
    pendingGuides = [];
    pendingSpacing = [];
    set({ guides: [], spacing: [] });
  },
}));
