/**
 * Minimal surface of foliate-js (https://github.com/johnfactotum/foliate-js) as used here.
 * The library ships as untyped ES modules, so the parts this app touches are declared by hand.
 * This file is a script (no top-level imports/exports) so the module declarations are ambient.
 */

declare module 'foliate-js/view.js' {
  /** A loaded book, as returned by `makeBook`. Only the members this app reads are declared. */
  export interface FoliateBook {
    metadata?: {
      title?: string;
      creator?: string | string[];
      language?: string | string[];
    };
    dir: 'ltr' | 'rtl';
    toc: FoliateTocItem[];
    pageList?: FoliateTocItem[];
    landmarks?: { label?: string; type: string[]; href: string }[];
    sections: FoliateBookSection[];
    isExternal?(href: string): boolean;
    resolveHref(href: string): { index: number; anchor: unknown };
    resolveCFI?(cfi: string): { index: number; anchor: unknown };
  }

  export interface FoliateTocItem {
    label: string;
    href: string;
    subitems: FoliateTocItem[] | null;
  }

  export interface FoliateBookSection {
    id: string;
    /** 'no' when the section is excluded from linear reading (cover pages and such). */
    linear?: string;
    /** Document for this section; only for formats that can build one (all of ours). */
    createDocument(): Promise<Document>;
  }

  /** Relocate detail: where the reader currently is. */
  export interface FoliateRelocateDetail {
    reason?: string;
    range?: Range;
    index: number;
    /** Overall progress 0..1 across the whole book. */
    fraction: number;
    /** Section and location numbers, when the book exposes them. */
    section?: { current: number; total: number };
    location?: { current: number; total: number };
    tocItem?: { label: string } | null;
    cfi: string;
  }

  /** A `<foliate-view>` custom element. Created with `document.createElement('foliate-view')`. */
  export interface FoliateView extends HTMLElement {
    book: FoliateBook;
    renderer: HTMLElement & {
      getContents(): Array<{ index: number; doc: Document }>;
      start?: number;
      end?: number;
      viewSize?: number;
    };
    history: { canGoBack: boolean; canGoForward: boolean };
    open(book: Blob | File | string | FoliateBook): Promise<void>;
    /** Navigate after open: restore `lastLocation`, or start at the beginning. */
    init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number | { fraction: number }): Promise<unknown>;
    goToFraction(fraction: number): Promise<void>;
    /** CFI for a position in the book; with a range, for that exact selection. */
    getCFI(index: number, range?: Range): string;
    resolveCFI?(cfi: string): { index: number; anchor: unknown };
    prev(distance?: number): Promise<void>;
    next(distance?: number): Promise<void>;
    /** Draw or remove a highlight. `annotation.value` is a CFI. */
    addAnnotation(annotation: { value: string }, remove?: boolean): Promise<unknown>;
    deleteAnnotation(annotation: { value: string }): Promise<unknown>;
    deselect(): void;
    close(): void;
    addEventListener(
      type: 'relocate',
      listener: (event: CustomEvent<FoliateRelocateDetail>) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: 'load',
      listener: (event: CustomEvent<{ doc: Document; index: number }>) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: 'draw-annotation',
      listener: (event: CustomEvent<{ draw: (func: unknown, opts?: unknown) => void; annotation: { value: string }; doc: Document; range: Range }>) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }

  /** Importing this module registers the <foliate-view> custom element. */
  export function makeBook(file: Blob | File | string): Promise<FoliateBook>;
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
}

declare module 'foliate-js/overlayer.js' {
  export class Overlayer {
    constructor(doc: Document);
    static highlight(range: Range, options?: { color?: string }): void;
    static outline(range: Range, options?: { color?: string }): void;
    static underline(range: Range, options?: { color?: string }): void;
  }
}
