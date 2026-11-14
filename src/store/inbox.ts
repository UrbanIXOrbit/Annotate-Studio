import { create } from 'zustand';

/**
 * Which capture note the Inbox board is showing. A store rather than local
 * state so the sidebar, the Library button and the capture toast can all send
 * the board to a specific note before the view mounts.
 */
interface InboxStore {
  /** Selected note path; null means the default Inbox note. */
  selectedPath: string | null;
  select: (path: string | null) => void;
}

export const useInbox = create<InboxStore>((set) => ({
  selectedPath: null,
  select: (path) => set({ selectedPath: path }),
}));
