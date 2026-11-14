import { create } from 'zustand';

/**
 * Open state of the capture composer. A store rather than local state so the
 * Inbox section, the keyboard shortcut and the dialog can all reach it
 * without prop threading.
 */
interface ScratchStore {
  composing: boolean;
  /** Open with the "New capture note…" target preselected. */
  newNote: boolean;
  /** Preselect a named capture note (ignored for the default Inbox). */
  targetPath: string | null;
  openComposer: (options?: { newNote?: boolean; targetPath?: string }) => void;
  closeComposer: () => void;
}

export const useScratch = create<ScratchStore>((set) => ({
  composing: false,
  newNote: false,
  targetPath: null,
  openComposer: (options) =>
    set({ composing: true, newNote: options?.newNote === true, targetPath: options?.targetPath ?? null }),
  closeComposer: () => set({ composing: false }),
}));
