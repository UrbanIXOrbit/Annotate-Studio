'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { List, Loader2, AlertTriangle, ChevronLeft, ChevronRight, Copy, MessageSquareText, BookOpenCheck, NotebookPen, StickyNote, Highlighter, PenLine } from 'lucide-react';
import Popover from '@/components/ui/Popover';
import { Overlayer } from 'foliate-js/overlayer.js';
import type { FoliateRelocateDetail, FoliateTocItem, FoliateView } from 'foliate-js/view.js';
import { createBookView, ensureFoliateModule, openBook } from '@/lib/book-engine';
import { readFileBytes, readExternalFileBytes } from '@/lib/tauri-commands';
import { registerWindowKeyHandler } from '@/lib/window-keys';
import { copyText, stripExtension } from '@/lib/utils';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { useApp } from '@/store/app';
import { usePdfNav } from '@/lib/pdf-nav';
import { cardTitle, normalizeQuote } from '@/lib/cards';
import { toast, useToasts } from '@/store/toast';
import NoteClipPicker from './NoteClipPicker';
import { clipToNewNote, clipToNote } from '@/lib/note-clip-actions';
import { useSettings } from '@/store/settings';
import {
  annotationCfi,
  createEpubAnnotation,
  createEpubAnnotationSet,
  readBookAnnotationSet,
  writeBookAnnotationSet,
  type EpubAnnotationSet,
} from '@/lib/book-annotations';

interface BookWindowProps {
  resourceId: string;
  path: string;
  title: string;
}

interface Progress {
  fraction: number;
  section?: { current: number; total: number };
  location?: { current: number; total: number };
  chapter?: string;
}

interface TocEntry {
  label: string;
  href: string;
  depth: number;
}

/** Selection captured while it lasts: text, CFI anchor and where the menu should appear. */
interface Selection {
  text: string;
  cfi: string;
  source: string;
  /** Screen coordinates of the selection box. */
  x: number;
  top: number;
  bottom: number;
}

type AnnotationStyle = 'highlight' | 'underline';

function notifyAnnotationSaved(path: string) {
  if (/\.epub$/i.test(path)) {
    toast.success('Saved in EPUB', 'This annotation stays with the book file when it is shared.');
  } else {
    toast.success('Saved with book', 'Stored in Annotate Studio on this device and restored when you reopen this file.');
  }
}

function flattenToc(items: FoliateTocItem[], depth = 0): TocEntry[] {
  return items.flatMap((item) => [
    { label: item.label?.trim() || 'Untitled', href: item.href, depth },
    ...(item.subitems?.length ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}

function BookWindow({ resourceId, path, title }: BookWindowProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isExternal = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === resourceId)?.isExternal ?? false);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    const readFile = isExternal ? readExternalFileBytes : readFileBytes;
    readFile(path)
      .then((data) => !cancelled && setBytes(data))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, isExternal]);

  if (error) {
    return (
      <div className="cw-state cw-state-error">
        <AlertTriangle size={22} />
        <div>{error}</div>
      </div>
    );
  }
  if (!bytes) {
    return (
      <div className="cw-state">
        <Loader2 size={20} className="spin" />
        <div>Opening {title}…</div>
      </div>
    );
  }
  return <BookReader resourceId={resourceId} path={path} title={title} bytes={bytes} isExternal={isExternal} />;
}

function BookReader({ resourceId, path, title, bytes, isExternal }: BookWindowProps & { bytes: Uint8Array; isExternal: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const highlightColorRef = useRef('#FFCD45');
  const annotationStyleRef = useRef<AnnotationStyle>('highlight');
  const annotationStylesRef = useRef(new Map<string, AnnotationStyle>());
  const annotationSetRef = useRef<EpubAnnotationSet>(createEpubAnnotationSet(title));
  const annotationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const tocAnchor = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const noteAnchor = useRef<HTMLButtonElement>(null);
  const clipRef = useRef<{ text: string; section: number; cfi: string; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Where you were in this book last time. Read once: it only matters while the window opens.
  const savedViewRef = useRef(useCanvas.getState().bookViews[path]);

  const handleRelocate = useCallback(
    (event: CustomEvent<FoliateRelocateDetail>) => {
      const detail = event.detail;
      setProgress({
        fraction: detail.fraction,
        section: detail.section,
        location: detail.location,
        chapter: detail.tocItem?.label,
      });
      const contents = viewRef.current?.renderer.getContents?.() ?? [];
      const active = detail.reason === 'scroll'
        ? contents.find(({ doc }) => {
            const current = doc.getSelection();
            return current && !current.isCollapsed && !!current.toString().trim();
          })
        : undefined;
      const current = active?.doc.getSelection();
      const range = current?.rangeCount ? current.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (active && range && rect && (rect.width || rect.height)) {
        const frameRect = (active.doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
        setSelection({
          text: current!.toString().trim(),
          cfi: viewRef.current!.getCFI(active.index, range),
          source: viewRef.current!.book.sections[active.index]?.id ?? '',
          x: (frameRect?.left ?? 0) + rect.left + rect.width / 2,
          top: (frameRect?.top ?? 0) + rect.top,
          bottom: (frameRect?.top ?? 0) + rect.bottom,
        });
      } else {
        setSelection(null);
      }
      useCanvas.getState().setBookView(path, { cfi: detail.cfi });
    },
    [path],
  );

  // Where the selection menu points. Rebound to every section document foliate loads.
  const captureSelection = useCallback((doc: Document, index: number) => {
    const view = viewRef.current;
    const domSelection = doc.getSelection();
    const text = domSelection?.toString().trim() ?? '';
    if (!domSelection || domSelection.isCollapsed || !text || !view) {
      setSelection(null);
      return;
    }
    const range = domSelection.getRangeAt(0);
    const frameRect = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelection(null);
      return;
    }
    setSelection({
      text,
      cfi: view.getCFI(index, range),
      source: view.book.sections[index]?.id ?? '',
      x: (frameRect?.left ?? 0) + rect.left + rect.width / 2,
      top: (frameRect?.top ?? 0) + rect.top,
      bottom: (frameRect?.top ?? 0) + rect.bottom,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let view: FoliateView | null = null;
    (async () => {
      try {
        // The custom element must be registered before it is created, so the module
        // import has to settle first (the same reason getPdfEngine is async).
        await ensureFoliateModule();
        if (cancelled || !hostRef.current) return;
        try {
          const stored = await readBookAnnotationSet(path, isExternal, title);
          annotationSetRef.current = stored;
          annotationStylesRef.current.clear();
          for (const annotation of stored.items) {
            annotationStylesRef.current.set(annotationCfi(annotation), annotation.body.highlight === 'underline' ? 'underline' : 'highlight');
          }
        } catch (err) {
          toast.error('Could not read annotations for this book', err);
          annotationSetRef.current = createEpubAnnotationSet(title);
          annotationStylesRef.current.clear();
        }
        const opened = createBookView();
        view = opened;
        viewRef.current = opened;
        hostRef.current.append(opened);
        // Listeners go on before open: foliate fires load/relocate during open and init.
        opened.addEventListener('relocate', handleRelocate);
        opened.addEventListener('load', async (event) => {
          const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail;
          doc.addEventListener('pointerup', () => captureSelection(doc, index));
          doc.addEventListener('keydown', (keyEvent) => {
            if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
            if (keyEvent.key === 'ArrowRight' || keyEvent.key === 'PageDown') void opened.next();
            else if (keyEvent.key === 'ArrowLeft' || keyEvent.key === 'PageUp') void opened.prev();
            else if (keyEvent.key === 'Escape') {
              opened.deselect();
              setSelection(null);
            }
          });
          doc.addEventListener('wheel', (wheelEvent) => {
            const renderer = opened.renderer;
            const start = renderer.start;
            const end = renderer.end;
            const viewSize = renderer.viewSize;
            if (start === undefined || end === undefined || viewSize === undefined || wheelEvent.deltaY === 0) return;
            const atStart = start <= 1;
            const atEnd = viewSize - end <= 2;
            if ((wheelEvent.deltaY < 0 && atStart) || (wheelEvent.deltaY > 0 && atEnd)) {
              wheelEvent.preventDefault();
              void (wheelEvent.deltaY > 0 ? opened.next() : opened.prev());
            }
          }, { passive: false });
          for (const annotation of annotationSetRef.current.items) {
            const cfi = annotationCfi(annotation);
            try {
              const targetIndex = opened.resolveCFI?.(cfi)?.index;
              const targetSource = opened.book.sections[index]?.id;
              if (targetIndex === index || (targetIndex === undefined && annotation.target.source === targetSource)) {
                await opened.addAnnotation({ value: cfi });
              }
            } catch (err) {
              console.warn('Could not restore a book annotation', err);
            }
          }
        });
        opened.addEventListener('draw-annotation', (event) => {
          const detail = (event as CustomEvent<{ draw: (func: unknown, opts?: unknown) => void; annotation: { value: string } }>).detail;
          const style = annotationStylesRef.current.get(detail.annotation.value) ?? annotationStyleRef.current;
          const draw = style === 'underline' ? Overlayer.underline : Overlayer.highlight;
          detail.draw(draw, {
            color: highlightColorRef.current,
          });
        });
        await openBook(bytes, title, opened);
        setToc(flattenToc(opened.book.toc ?? []));
        await opened.init({ lastLocation: savedViewRef.current?.cfi || undefined });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      try {
        view?.close();
      } catch {
        // The view may never have been fully opened.
      }
      view?.remove();
      viewRef.current = null;
    };
    // The book must not reopen when only the position store changes; bytes and path define it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, path]);

  useEffect(() => {
    return registerWindowKeyHandler(resourceId, (event) => {
      const view = viewRef.current;
      if (!view) return false;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        view.deselect();
        setSelection(null);
        setTocOpen(false);
        return true;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      if (key === 'arrowright' || key === 'pagedown') {
        void view.next();
        return true;
      }
      if (key === 'arrowleft' || key === 'pageup') {
        void view.prev();
        return true;
      }
      return false;
    });
  }, [resourceId]);

  // Honour "go to source" requests from cards once the reader is laid out (it has relocated at least once).
  const pendingJump = usePdfNav((state) => state.pending[path]);
  const handledJumpRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingJump?.cfi || !progress || !viewRef.current || handledJumpRef.current === pendingJump.nonce) return;
    handledJumpRef.current = pendingJump.nonce;
    void viewRef.current.goTo(pendingJump.cfi).then((resolved) => {
      // goTo resolves undefined when the target could not be resolved; keep the request to retry.
      if (resolved !== undefined) usePdfNav.getState().clear(path, pendingJump.nonce);
      else handledJumpRef.current = null;
    }).catch(() => {
      handledJumpRef.current = null;
    });
  }, [pendingJump, progress, path]);

  const clearSelection = useCallback(() => {
    viewRef.current?.deselect();
    setSelection(null);
  }, []);

  const persistAnnotation = useCallback(
    async (captured: Pick<Selection, 'text' | 'cfi' | 'source'>, style: AnnotationStyle) => {
      if (!captured.source) throw new Error('The selected book section could not be identified.');
      const annotation = createEpubAnnotation({
        source: captured.source,
        cfi: captured.cfi,
        text: captured.text,
        style,
      });
      const next: EpubAnnotationSet = {
        ...annotationSetRef.current,
        generated: new Date().toISOString(),
        items: [
          ...annotationSetRef.current.items.filter(
            (item) => item.target.source !== captured.source || annotationCfi(item) !== captured.cfi,
          ),
          annotation,
        ],
      };
      annotationSetRef.current = next;
      const save = annotationSaveQueueRef.current.then(() => writeBookAnnotationSet(path, isExternal, next));
      annotationSaveQueueRef.current = save.then(() => undefined, () => undefined);
      await save;
      annotationStylesRef.current.set(annotationCfi(annotation), style);
      return annotation;
    },
    [path, isExternal],
  );

  const sendToCanvas = useCallback(async () => {
    const captured = selection;
    if (!captured) return;
    try {
      await persistAnnotation(captured, 'highlight');
      notifyAnnotationSaved(path);
    } catch (err) {
      toast.error('Could not save annotation for this book', err);
      return;
    }
    clearSelection();
    const canvas = useCanvas.getState();
    const section = (progress?.section?.current ?? 0) + 1;
    const cardId = canvas.addCard({
      title: cardTitle(stripExtension(title), section),
      content: normalizeQuote(captured.text),
      color: highlightColorRef.current,
      source: { filePath: path, title, page: section, cfi: captured.cfi, isExternal },
      near: resourceId,
    });
    void viewRef.current?.addAnnotation({ value: captured.cfi });
    useToasts.getState().push({
      kind: 'success',
      title: 'Added to canvas',
      description: progress?.chapter ?? `Section ${section}`,
      action: { label: 'Show', run: () => useCanvas.getState().focusResource(cardId) },
    });
  }, [selection, clearSelection, progress, title, path, resourceId, isExternal, persistAnnotation]);

  const copySelection = useCallback(async () => {
    const text = selection?.text;
    if (!text) return;
    await copyText(text);
    clearSelection();
  }, [selection, clearSelection]);

  const annotateSelection = useCallback(
    async (style: AnnotationStyle) => {
      const captured = selection;
      const view = viewRef.current;
      if (!captured || !view) return;
      try {
        await persistAnnotation(captured, style);
        notifyAnnotationSaved(path);
      } catch (err) {
        toast.error('Could not save annotation for this book', err);
        return;
      }
      annotationStyleRef.current = style;
      void view.addAnnotation({ value: captured.cfi });
      clearSelection();
    },
    [selection, clearSelection, persistAnnotation],
  );

  const openNotePicker = useCallback(() => {
    if (notePickerOpen) {
      setNotePickerOpen(false);
      return;
    }
    if (!selection) return;
    clipRef.current = {
      text: normalizeQuote(selection.text),
      section: (progress?.section?.current ?? 0) + 1,
      cfi: selection.cfi,
      source: selection.source,
    };
    setNotePickerOpen(true);
  }, [notePickerOpen, selection, progress]);

  const copyToNote = useCallback(
    async (target: { path: string } | 'new') => {
      const captured = clipRef.current;
      setNotePickerOpen(false);
      if (!captured) return;
      const clip = { text: captured.text, title, page: captured.section };
      const done = target === 'new' ? await clipToNewNote(clip, resourceId) : await clipToNote(target.path, clip);
      if (!done) return;
      if (useSettings.getState().noteClip.highlight) {
        try {
          await persistAnnotation(captured, 'highlight');
          notifyAnnotationSaved(path);
          annotationStyleRef.current = 'highlight';
          void viewRef.current?.addAnnotation({ value: captured.cfi });
        } catch (err) {
          toast.error('Could not save annotation for this book', err);
        }
      }
      clearSelection();
      clipRef.current = null;
    },
    [title, resourceId, clearSelection, persistAnnotation],
  );

  const sendToAi = useCallback(
    (mode: 'ask' | 'explain' | 'flashcards') => {
      const text = selection?.text;
      if (!text) return;
      clearSelection();
      const app = useApp.getState();
      if (mode === 'ask') app.requestChat({ kind: 'draft', text: `> ${text.replace(/\n+/g, ' ')}\n\n` });
      else if (mode === 'explain')
        app.requestChat({ kind: 'explain', topic: text.length > 120 ? `${text.slice(0, 120)}…` : text, context: text });
      else app.requestChat({ kind: 'flashcards', title, text });
    },
    [selection, clearSelection, title],
  );

  if (error) {
    return (
      <div className="cw-state cw-state-error">
        <AlertTriangle size={22} />
        <div>{error}</div>
      </div>
    );
  }

  const view = viewRef.current;
  const atStart = progress !== null && progress.fraction <= 0.001;
  const atEnd = progress !== null && progress.fraction >= 0.999;
  const menuBelow = selection ? selection.bottom + 8 : 0;
  const menuTop = selection ? Math.max(8, selection.top - 48) : 0;
  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  return (
    <div className="book-window">
      <div className="pdf-toolbar" data-no-drag>
        <div className="pdf-tool-group">
          <button ref={tocAnchor} type="button" className="tool-btn" onClick={() => setTocOpen((v) => !v)} title="Contents" disabled={toc.length === 0}>
            <List size={14} />
          </button>
        </div>
        <div className="pdf-tool-group">
          <button type="button" className="tool-btn" onClick={() => void view?.prev()} disabled={!view || atStart} title="Previous page">
            <ChevronLeft size={14} />
          </button>
          <span className="book-progress" dir="auto">
            {percent}%
            {progress?.location ? <span className="book-progress-loc"> · loc {progress.location.current + 1}/{progress.location.total}</span> : null}
          </span>
          <button type="button" className="tool-btn" onClick={() => void view?.next()} disabled={!view || atEnd} title="Next page">
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="pdf-toolbar-spacer" />
        {progress?.chapter && <span className="book-chapter">{progress.chapter}</span>}
      </div>
      <Popover anchorRef={tocAnchor} open={tocOpen} onClose={() => setTocOpen(false)} width={260} align="start">
        <div className="book-toc">
          {toc.map((entry, i) => (
            <button
              key={`${entry.href}-${i}`}
              type="button"
              className="book-toc-entry"
              style={{ paddingLeft: 8 + entry.depth * 14 }}
              onClick={() => {
                void view?.goTo(entry.href);
                setTocOpen(false);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </Popover>
      <NoteClipPicker
        anchorRef={noteAnchor}
        open={notePickerOpen}
        onClose={() => setNotePickerOpen(false)}
        onPickNote={(notePath) => void copyToNote({ path: notePath })}
        onPickNew={() => void copyToNote('new')}
      />
      <div ref={hostRef} className="book-viewport" />
      {selection && typeof document !== 'undefined' && createPortal(
        <div
          className="book-float-menu-holder"
          style={{ left: Math.min(Math.max(selection.x, Math.min(360, window.innerWidth / 2)), window.innerWidth - Math.min(360, window.innerWidth / 2)), top: menuBelow + 48 < window.innerHeight ? menuBelow : menuTop }}
        >
          <div className="pdf-float-menu">
            <button type="button" onClick={() => void copySelection()} title="Copy">
              <Copy size={13} /> Copy
            </button>
            <button type="button" onClick={() => annotateSelection('highlight')} title="Highlight">
              <Highlighter size={13} /> Highlight
            </button>
            <button type="button" onClick={() => annotateSelection('underline')} title="Underline">
              <PenLine size={13} /> Underline
            </button>
            <button type="button" className="pdf-float-primary" onClick={sendToCanvas} title="Highlight and add as a card on the canvas">
              <StickyNote size={13} /> To canvas
            </button>
            <button ref={noteAnchor} type="button" className="pdf-float-primary" onClick={openNotePicker} title="Copy the selection to a note" aria-haspopup="listbox" aria-expanded={notePickerOpen}>
              <NotebookPen size={13} /> To note
            </button>
            <span className="pdf-float-divider" />
            <button type="button" onClick={() => sendToAi('ask')} title="Ask the AI about this text">
              <MessageSquareText size={13} /> Ask AI
            </button>
            <button type="button" onClick={() => sendToAi('explain')} title="Explain step by step">
              <BookOpenCheck size={13} /> Explain
            </button>
            <button type="button" onClick={() => sendToAi('flashcards')} title="Create flashcards from the selection">
              Flashcards
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default memo(BookWindow);
