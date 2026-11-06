import { create } from 'zustand';
import type { Placement } from '@/lib/arrange';

interface ArrangePreviewStore {
  /** Ghost positions shown while the Arrange panel is open, keyed by resource id. Null when the panel is closed. */
  placement: Placement | null;
  /** The ids in the order they will be arranged — drives the numbered badges. */
  order: string[];
  set: (placement: Placement, order: string[]) => void;
  clear: () => void;
}

/** Transient preview for the Arrange panel: where each selected window would go
 * if the current options were applied. Pure visualization; nothing here is
 * persisted, and it is cleared the moment the panel closes. */
export const useArrangePreview = create<ArrangePreviewStore>((set) => ({
  placement: null,
  order: [],
  set: (placement, order) => set({ placement, order }),
  clear: () => set({ placement: null, order: [] }),
}));
