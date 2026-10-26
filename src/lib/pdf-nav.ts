import { create } from 'zustand';

interface PdfJump {
  page: number;
  /** Books only: CFI anchor to jump to instead of (or on top of) the page. */
  cfi?: string;
  nonce: number;
}

interface PdfNavStore {
  pending: Record<string, PdfJump>;
  request: (path: string, page: number, cfi?: string) => void;
  clear: (path: string, nonce: number) => void;
}

let counter = 0;

/** Lets other parts of the app ask an open PDF or e-book window to scroll to a spot. */
export const usePdfNav = create<PdfNavStore>((set) => ({
  pending: {},
  request: (path, page, cfi) =>
    set((state) => ({ pending: { ...state.pending, [path]: cfi ? { page, cfi, nonce: ++counter } : { page, nonce: ++counter } } })),
  clear: (path, nonce) =>
    set((state) => {
      if (state.pending[path]?.nonce !== nonce) return state;
      const next = { ...state.pending };
      delete next[path];
      return { pending: next };
    }),
}));
