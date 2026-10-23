import { create } from 'zustand';

interface PdfJump {
  page: number;
  nonce: number;
}

interface PdfNavStore {
  pending: Record<string, PdfJump>;
  request: (path: string, page: number) => void;
  clear: (path: string, nonce: number) => void;
}

let counter = 0;

/** Lets other parts of the app ask an open PDF window to scroll to a page. */
export const usePdfNav = create<PdfNavStore>((set) => ({
  pending: {},
  request: (path, page) => set((state) => ({ pending: { ...state.pending, [path]: { page, nonce: ++counter } } })),
  clear: (path, nonce) =>
    set((state) => {
      if (state.pending[path]?.nonce !== nonce) return state;
      const next = { ...state.pending };
      delete next[path];
      return { pending: next };
    }),
}));
