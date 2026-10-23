'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPluginRegistration } from '@embedpdf/core';
import { EmbedPDF, useDocumentState } from '@embedpdf/core/react';
import { DocumentManagerPluginPackage, useActiveDocument, useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/react';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { Scroller, ScrollPluginPackage, useScroll } from '@embedpdf/plugin-scroll/react';
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { InteractionManagerPluginPackage, PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from '@embedpdf/plugin-selection/react';
import { AnnotationLayer, AnnotationPluginPackage, useAnnotation, useAnnotationCapability } from '@embedpdf/plugin-annotation/react';
import { LockModeType } from '@embedpdf/plugin-annotation';
import { HistoryPluginPackage, useHistoryCapability } from '@embedpdf/plugin-history/react';
import { useZoom, ZoomPluginPackage } from '@embedpdf/plugin-zoom/react';
import { ZoomMode } from '@embedpdf/plugin-zoom';
import { ExportPluginPackage, useExport } from '@embedpdf/plugin-export/react';
import {
  PdfAnnotationSubtype,
  restorePosition,
  transformSize,
  type PdfAnnotationObject,
  type Position,
  type Rotation,
} from '@embedpdf/models';
import {
  AlertTriangle,
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  Eraser,
  Highlighter,
  Loader2,
  MessageSquareText,
  MousePointer2,
  MoveUpRight,
  Pen,
  PenLine,
  Redo2,
  Square,
  NotebookPen,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Popover from '@/components/ui/Popover';
import ColorSwatches from '@/components/ui/ColorSwatches';
import { getPdfEngine, type SharedPdfEngine } from '@/lib/pdf-engine';
import { isTauri, readFileBytes, writeFileBytes } from '@/lib/tauri-commands';
import { registerFlusher } from '@/lib/persist';
import { registerPdfSaver, trackPdfSave, waitForPdfSaves } from '@/lib/pdf-saves';
import { openExternal } from '@/lib/external';
import { registerWindowKeyHandler } from '@/lib/window-keys';
import { copyText, cn, isEditableTarget, stripExtension } from '@/lib/utils';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { useApp } from '@/store/app';
import { useLibrary } from '@/store/library';
import { toast, useToasts } from '@/store/toast';
import { usePdfNav } from '@/lib/pdf-nav';
import NoteClipPicker from './NoteClipPicker';
import { clipToNewNote, clipToNote } from '@/lib/note-clip-actions';
import { useSettings } from '@/store/settings';
import { clampPosition, DEFAULT_ZOOM, positionFromVisibility, sanitizeZoom, type PdfZoom } from '@/lib/pdf-view';
import { cardTitle, normalizeQuote } from '@/lib/cards';

type Tool = 'select' | 'highlight' | 'pen' | 'marker' | 'text' | 'rectangle' | 'circle' | 'arrow' | 'eraser';

const TOOL_IDS: Record<Tool, string | null> = {
  select: null,
  highlight: 'highlight',
  pen: 'ink',
  marker: 'inkHighlighter',
  text: 'freeText',
  rectangle: 'square',
  circle: 'circle',
  arrow: 'lineArrow',
  eraser: null,
};

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; key: string }[] = [
  { id: 'select', label: 'Select (V)', icon: <MousePointer2 size={14} />, key: 'v' },
  { id: 'highlight', label: 'Highlight text (H)', icon: <Highlighter size={14} />, key: 'h' },
  { id: 'pen', label: 'Pen (P)', icon: <Pen size={14} />, key: 'p' },
  { id: 'marker', label: 'Marker (M)', icon: <PenLine size={14} />, key: 'm' },
  { id: 'text', label: 'Text (T)', icon: <Type size={14} />, key: 't' },
  { id: 'rectangle', label: 'Rectangle (R)', icon: <Square size={14} />, key: 'r' },
  { id: 'circle', label: 'Ellipse (O)', icon: <Circle size={14} />, key: 'o' },
  { id: 'arrow', label: 'Arrow (A)', icon: <MoveUpRight size={14} />, key: 'a' },
  { id: 'eraser', label: 'Eraser (E)', icon: <Eraser size={14} />, key: 'e' },
];

const STROKE_WIDTHS = [1, 2, 3, 5, 8, 12];

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface PdfWindowProps {
  resourceId: string;
  path: string;
  title: string;
  active: boolean;
}

function usePdfPlugins() {
  return useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, { maxDocuments: 1 }),
      createPluginRegistration(ViewportPluginPackage, { viewportGap: 16 }),
      createPluginRegistration(ScrollPluginPackage, { defaultPageGap: 14 }),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage),
      createPluginRegistration(HistoryPluginPackage),
      createPluginRegistration(AnnotationPluginPackage, {
        annotationAuthor: 'Annotate Studio',
        selectAfterCreate: false,
        autoOpenLinks: false,
        locked: { type: LockModeType.Include, categories: ['link'] },
        tools: [
          { id: 'freeText', behavior: { editAfterCreate: true, selectAfterCreate: true } },
          { id: 'link', categories: ['link'] },
        ],
      }),
      createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth, minZoom: 0.2, maxZoom: 6 }),
      createPluginRegistration(ExportPluginPackage, { defaultFileName: 'annotated.pdf' }),
    ],
    [],
  );
}

function PdfWindow({ resourceId, path, title, active }: PdfWindowProps) {
  const [engine, setEngine] = useState<SharedPdfEngine | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plugins = usePdfPlugins();

  useEffect(() => {
    let cancelled = false;
    getPdfEngine()
      .then((instance) => !cancelled && setEngine(instance))
      .catch((err) => !cancelled && setError(`The PDF engine could not start: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    waitForPdfSaves(path)
      .then(() => readFileBytes(path))
      .then((data) => {
        if (cancelled) return;
        setBytes(data.slice().buffer as ArrayBuffer);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="cw-state cw-state-error">
        <AlertTriangle size={22} />
        <div>{error}</div>
      </div>
    );
  }
  if (!engine || !bytes) {
    return (
      <div className="cw-state">
        <Loader2 size={20} className="spin" />
        <div>Opening {title}…</div>
      </div>
    );
  }
  return (
    <EmbedPDF engine={engine} plugins={plugins} autoMountDomElements={false}>
      <PdfDocument resourceId={resourceId} path={path} title={title} active={active} bytes={bytes} />
    </EmbedPDF>
  );
}

function PdfDocument({ resourceId, path, title, active, bytes }: PdfWindowProps & { bytes: ArrayBuffer }) {
  const { provides: manager } = useDocumentManagerCapability();
  const { activeDocumentId } = useActiveDocument();
  const [loadError, setLoadError] = useState<string | null>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (!manager || openedRef.current) return;
    openedRef.current = true;
    const task = manager.openDocumentBuffer({ buffer: bytes, name: stripExtension(title), autoActivate: true });
    task.wait(
      (result) =>
        result.task.wait(
          () => undefined,
          (failure) => setLoadError(failure.reason?.message ?? 'This PDF could not be opened. It may be damaged or password protected.'),
        ),
      (failure) => setLoadError(failure.reason?.message ?? 'This PDF could not be opened.'),
    );
  }, [manager, bytes, title]);

  if (loadError) {
    return (
      <div className="cw-state cw-state-error">
        <AlertTriangle size={22} />
        <div>{loadError}</div>
      </div>
    );
  }
  if (!activeDocumentId) {
    return (
      <div className="cw-state">
        <Loader2 size={20} className="spin" />
        <div>Loading pages…</div>
      </div>
    );
  }
  return <PdfWorkspace documentId={activeDocumentId} resourceId={resourceId} path={path} title={title} active={active} />;
}

function useAutosave(documentId: string, path: string) {
  const { provides: exporter } = useExport(documentId);
  const { provides: annotations } = useAnnotation(documentId);
  const [state, setState] = useState<SaveState>('idle');
  const dirty = useRef(false);
  const discarded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const exporterRef = useRef(exporter);
  exporterRef.current = exporter;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (saving.current) await saving.current.catch(() => undefined);
    if (discarded.current || !dirty.current || !exporterRef.current) return;
    dirty.current = false;
    setState('saving');
    const job = (async () => {
      try {
        await annotationsRef.current?.commit().toPromise();
        const buffer = await exporterRef.current!.saveAsCopy().toPromise();
        if (discarded.current) return;
        const file = await writeFileBytes({ path }, buffer);
        useLibrary.getState().upsert(file);
        setState('saved');
      } catch (error) {
        dirty.current = true;
        setState('error');
        toast.error('Could not save annotations', error);
      }
    })();
    saving.current = job;
    trackPdfSave(path, job);
    await job;
    saving.current = null;
  }, [path]);

  const markDirty = useCallback(() => {
    dirty.current = true;
    setState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1500);
  }, [save]);

  useEffect(() => {
    if (!annotations) return;
    return annotations.onAnnotationEvent((event) => {
      if (event.type !== 'loaded' && event.committed) markDirty();
    });
  }, [annotations, markDirty]);

  useEffect(() => registerFlusher(save), [save]);
  useEffect(
    () =>
      registerPdfSaver(path, {
        flush: save,
        discard: () => {
          discarded.current = true;
          dirty.current = false;
          if (timer.current) clearTimeout(timer.current);
          timer.current = undefined;
        },
      }),
    [path, save],
  );
  useEffect(
    () => () => {
      if (dirty.current) void save();
    },
    [save],
  );

  return { state, save };
}

function useCanvasZoom(): number {
  const zoom = useCanvas((state) => activeWorkspace(state).view.zoom);
  const [settled, setSettled] = useState(zoom);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(zoom), 350);
    return () => clearTimeout(timer);
  }, [zoom]);
  return settled;
}

function ScaledPage({
  documentId,
  pageIndex,
  children,
  dpr,
}: {
  documentId: string;
  pageIndex: number;
  children: React.ReactNode;
  dpr: number;
}) {
  const documentState = useDocumentState(documentId);
  const page = documentState?.document?.pages?.[pageIndex];
  const scale = documentState?.scale ?? 1;
  const rotation = (((page?.rotation ?? 0) + (documentState?.rotation ?? 0)) % 4) as Rotation;
  const natural = page?.size ?? { width: 0, height: 0 };

  const convert = useCallback(
    (event: PointerEvent, element: HTMLElement): Position => {
      const rect = element.getBoundingClientRect();
      const cssScaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
      const cssScaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
      const point = {
        x: (event.clientX - rect.left) / (cssScaleX || 1),
        y: (event.clientY - rect.top) / (cssScaleY || 1),
      };
      const display = transformSize(natural, 0, scale);
      return restorePosition(transformSize(display, rotation, 1), point, rotation, scale);
    },
    [natural, rotation, scale],
  );

  return (
    <PagePointerProvider documentId={documentId} pageIndex={pageIndex} convertEventToPoint={convert} className="pdf-page">
      <RenderLayer documentId={documentId} pageIndex={pageIndex} dpr={dpr} style={{ pointerEvents: 'none' }} />
      {children}
    </PagePointerProvider>
  );
}

type FormattedSelection = ReturnType<NonNullable<ReturnType<typeof useSelectionCapability>['provides']>['getFormattedSelection']>;

const DEFAULT_COLOR = '#E44234';
const DEFAULT_HIGHLIGHT_COLOR = '#FFCD45';
const DEFAULT_WIDTH = 3;
const SAVED_TO_ENGINE_ZOOM = { 'fit-width': ZoomMode.FitWidth, 'fit-page': ZoomMode.FitPage, automatic: ZoomMode.Automatic } as const;

const toEngineZoom = (zoom: PdfZoom): ZoomMode | number => (typeof zoom === 'number' ? zoom : SAVED_TO_ENGINE_ZOOM[zoom]);
const toSavedZoom = (level: unknown): PdfZoom => sanitizeZoom(level);

function PdfWorkspace({ documentId, resourceId, path, title, active }: Omit<PdfWindowProps, 'bytes'> & { documentId: string }) {
  // Where you were in this book last time. Read once: it only matters while the window opens.
  const savedViewRef = useRef(useCanvas.getState().pdfViews[path]);
  const restoredRef = useRef(false);
  /** True once it is safe to write the position: the saved spot was restored, or you moved the page yourself. */
  const trackRef = useRef(false);
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(savedViewRef.current?.color ?? DEFAULT_COLOR);
  const [highlightColor, setHighlightColor] = useState(savedViewRef.current?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR);
  const [width, setWidth] = useState(savedViewRef.current?.width ?? DEFAULT_WIDTH);
  const [colorOpen, setColorOpen] = useState(false);
  const colorAnchor = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const { provides: annotationScope, state: annotationState } = useAnnotation(documentId);
  const { provides: annotationCapability } = useAnnotationCapability();
  const { provides: selection } = useSelectionCapability();
  const { provides: history } = useHistoryCapability();
  const { provides: zoom, state: zoomState } = useZoom(documentId);
  const { provides: scroll, state: scrollState } = useScroll(documentId);
  const documentState = useDocumentState(documentId);
  const { provides: exporter } = useExport(documentId);
  const { state: saveState, save } = useAutosave(documentId, path);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const maximized = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === resourceId)?.maximized ?? false);
  const canvasZoom = useCanvasZoom();
  const [pageInput, setPageInput] = useState('');

  const baseDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const dpr = maximized ? baseDpr : Math.min(4, Math.round(baseDpr * Math.max(1, canvasZoom) * 2) / 2);

  const selectedUids = useMemo(() => annotationState?.selectedUids ?? [], [annotationState?.selectedUids]);
  const layerZoom = maximized ? 1 : canvasZoom;
  const layerScale = (documentState?.scale ?? 1) * layerZoom;

  useEffect(() => {
    annotationScope?.setActiveTool(TOOL_IDS[tool]);
  }, [annotationScope, tool]);

  useEffect(() => {
    if (!annotationCapability) return;
    for (const id of ['ink', 'square', 'circle', 'lineArrow', 'line']) {
      annotationCapability.setToolDefaults(id, { strokeColor: color, color: id === 'ink' ? color : 'transparent', strokeWidth: width } as never);
    }
    annotationCapability.setToolDefaults('inkHighlighter', { strokeColor: highlightColor, color: highlightColor, strokeWidth: Math.max(8, width * 4) } as never);
    annotationCapability.setToolDefaults('highlight', { strokeColor: highlightColor, color: highlightColor } as never);
    annotationCapability.setToolDefaults('freeText', { fontColor: color, fontSize: Math.max(10, Math.round(8 + width * 2)) } as never);
  }, [annotationCapability, color, highlightColor, width]);

  useEffect(() => {
    if (tool !== 'eraser' || !annotationScope || selectedUids.length === 0) return;
    const targets = selectedUids
      .map((uid) => annotationScope.getAnnotationById(uid))
      .filter((tracked): tracked is NonNullable<typeof tracked> => tracked !== null)
      .map((tracked) => ({ pageIndex: tracked.object.pageIndex, id: tracked.object.id }));
    if (targets.length) annotationScope.deleteAnnotations(targets);
  }, [tool, selectedUids, annotationScope]);

  useEffect(() => {
    if (!annotationCapability) return;
    return annotationCapability.onNavigate((event) => {
      if (event.documentId === documentId && event.result.outcome === 'uri') void openExternal(event.result.uri);
    });
  }, [annotationCapability, documentId]);

  useEffect(() => {
    if (!history) return;
    const scope = history.forDocument(documentId);
    const refresh = () => setHistoryState({ canUndo: scope.canUndo(), canRedo: scope.canRedo() });
    refresh();
    return scope.onHistoryChange(refresh);
  }, [history, documentId]);

  const applyToSelection = useCallback(
    (patch: (annotation: PdfAnnotationObject) => Partial<PdfAnnotationObject> | null) => {
      if (!annotationScope || selectedUids.length === 0) return;
      const patches = selectedUids
        .map((uid) => annotationScope.getAnnotationById(uid))
        .filter((tracked): tracked is NonNullable<typeof tracked> => tracked !== null)
        .map((tracked) => ({ pageIndex: tracked.object.pageIndex, id: tracked.object.id, patch: patch(tracked.object) }))
        .filter((entry): entry is { pageIndex: number; id: string; patch: Partial<PdfAnnotationObject> } => entry.patch !== null);
      if (patches.length) annotationScope.updateAnnotations(patches);
    },
    [annotationScope, selectedUids],
  );

  const changeColor = (next: string) => {
    const isHighlightTool = tool === 'highlight' || tool === 'marker';
    if (isHighlightTool) setHighlightColor(next);
    else setColor(next);
    applyToSelection((annotation) => {
      switch (annotation.type) {
        case PdfAnnotationSubtype.HIGHLIGHT:
        case PdfAnnotationSubtype.UNDERLINE:
        case PdfAnnotationSubtype.STRIKEOUT:
        case PdfAnnotationSubtype.SQUIGGLY:
          return { strokeColor: next, color: next } as Partial<PdfAnnotationObject>;
        case PdfAnnotationSubtype.FREETEXT:
          return { fontColor: next } as Partial<PdfAnnotationObject>;
        case PdfAnnotationSubtype.INK:
          return { strokeColor: next, color: next } as Partial<PdfAnnotationObject>;
        default:
          return { strokeColor: next } as Partial<PdfAnnotationObject>;
      }
    });
  };

  const changeWidth = (next: number) => {
    setWidth(next);
    applyToSelection((annotation) =>
      annotation.type === PdfAnnotationSubtype.INK ||
      annotation.type === PdfAnnotationSubtype.SQUARE ||
      annotation.type === PdfAnnotationSubtype.CIRCLE ||
      annotation.type === PdfAnnotationSubtype.LINE
        ? ({ strokeWidth: next } as Partial<PdfAnnotationObject>)
        : null,
    );
  };

  const deleteSelected = useCallback(() => {
    if (!annotationScope || selectedUids.length === 0) return false;
    const targets = selectedUids
      .map((uid) => annotationScope.getAnnotationById(uid))
      .filter((tracked): tracked is NonNullable<typeof tracked> => tracked !== null)
      .map((tracked) => ({ pageIndex: tracked.object.pageIndex, id: tracked.object.id }));
    annotationScope.deleteAnnotations(targets);
    return true;
  }, [annotationScope, selectedUids]);

  const undo = useCallback(() => history?.forDocument(documentId).undo(), [history, documentId]);
  const redo = useCallback(() => history?.forDocument(documentId).redo(), [history, documentId]);

  const selectedText = useCallback(async () => {
    if (!selection) return '';
    const parts = await selection.getSelectedText(documentId).toPromise();
    return parts.join('\n').trim();
  }, [selection, documentId]);

  const clearSelection = useCallback(() => selection?.clear(documentId), [selection, documentId]);

  /** Create markup annotations for regions that were captured earlier (they may no longer be selected). */
  const markupItems = useCallback(
    (items: FormattedSelection, subtype: PdfAnnotationSubtype.HIGHLIGHT | PdfAnnotationSubtype.UNDERLINE) => {
      if (!annotationScope) return;
      for (const item of items) {
        annotationScope.createAnnotation(item.pageIndex, {
          id: crypto.randomUUID(),
          type: subtype,
          pageIndex: item.pageIndex,
          rect: item.rect,
          segmentRects: item.segmentRects,
          strokeColor: subtype === PdfAnnotationSubtype.HIGHLIGHT ? highlightColor : color,
          color: subtype === PdfAnnotationSubtype.HIGHLIGHT ? highlightColor : color,
          opacity: 1,
          author: 'Annotate Studio',
        } as never);
      }
    },
    [annotationScope, highlightColor, color],
  );

  const markupSelection = useCallback(
    (subtype: PdfAnnotationSubtype.HIGHLIGHT | PdfAnnotationSubtype.UNDERLINE) => {
      if (!selection || !annotationScope) return;
      markupItems(selection.getFormattedSelection(documentId), subtype);
      clearSelection();
    },
    [selection, annotationScope, documentId, markupItems, clearSelection],
  );

  // ───────── copy the selection to a note ─────────
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const noteAnchor = useRef<HTMLButtonElement>(null);
  /** What was selected when "To note" was clicked. Kept so a picker or name prompt cannot lose it. */
  const clipRef = useRef<{ text: string; page: number; items: FormattedSelection } | null>(null);

  const openNotePicker = useCallback(async () => {
    if (notePickerOpen) {
      setNotePickerOpen(false);
      return;
    }
    if (!selection) return;
    const items = selection.getFormattedSelection(documentId);
    const text = normalizeQuote(await selectedText());
    if (!text) return;
    const page = (items[0]?.pageIndex ?? Math.max(0, (scrollState?.currentPage ?? 1) - 1)) + 1;
    clipRef.current = { text, page, items };
    setNotePickerOpen(true);
  }, [notePickerOpen, selection, documentId, selectedText, scrollState?.currentPage]);

  const copyToNote = useCallback(
    async (target: { path: string } | 'new') => {
      const captured = clipRef.current;
      setNotePickerOpen(false);
      if (!captured) return;
      const clip = { text: captured.text, title, page: captured.page };
      const done = target === 'new' ? await clipToNewNote(clip, resourceId) : await clipToNote(target.path, clip);
      if (!done) return;
      if (useSettings.getState().noteClip.highlight) markupItems(captured.items, PdfAnnotationSubtype.HIGHLIGHT);
      clearSelection();
      clipRef.current = null;
    },
    [title, resourceId, markupItems, clearSelection],
  );

  const sendToAi = useCallback(
    async (mode: 'ask' | 'explain' | 'flashcards') => {
      const text = await selectedText();
      if (!text) return;
      clearSelection();
      const app = useApp.getState();
      if (mode === 'ask') app.requestChat({ kind: 'draft', text: `> ${text.replace(/\n+/g, ' ')}\n\n` });
      else if (mode === 'explain') app.requestChat({ kind: 'explain', topic: text.length > 120 ? `${text.slice(0, 120)}…` : text, context: text });
      else app.requestChat({ kind: 'flashcards', title, text });
    },
    [selectedText, clearSelection, title],
  );

  const sendToCanvas = useCallback(async () => {
    const text = normalizeQuote(await selectedText());
    if (!text) return;
    // Read the page before markupSelection clears the selection.
    const firstItem = selection?.getFormattedSelection(documentId)[0];
    const page = (firstItem?.pageIndex ?? Math.max(0, (scrollState?.currentPage ?? 1) - 1)) + 1;
    markupSelection(PdfAnnotationSubtype.HIGHLIGHT);
    const canvas = useCanvas.getState();
    const cardId = canvas.addCard({
      title: cardTitle(title, page),
      content: text,
      color: highlightColor,
      source: { filePath: path, title, page },
      near: resourceId,
    });
    useToasts.getState().push({
      kind: 'success',
      title: 'Added to canvas',
      description: `Page ${page}`,
      action: { label: 'Show', run: () => useCanvas.getState().focusResource(cardId) },
    });
  }, [selectedText, selection, documentId, scrollState?.currentPage, markupSelection, title, path, resourceId, highlightColor]);

  const exportCopy = useCallback(async () => {
    if (!exporter) return;
    try {
      await annotationScope?.commit().toPromise();
      const buffer = await exporter.saveAsCopy().toPromise();
      if (!isTauri()) return;
      const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
      const target = await saveDialog({
        defaultPath: `${stripExtension(title)} (annotated).pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!target) return;
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      await writeFile(target, new Uint8Array(buffer));
      toast.success('PDF exported', target);
    } catch (error) {
      toast.error('Export failed', error);
    }
  }, [exporter, annotationScope, title]);

  useEffect(() => {
    return registerWindowKeyHandler(resourceId, (event, inContent) => {
      if (isEditableTarget(event.target)) return false;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !inContent) return false;
      if (mod && key === 'z' && !event.shiftKey) {
        undo();
        return true;
      }
      if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
        redo();
        return true;
      }
      if (mod && (key === '=' || key === '+')) {
        zoom?.zoomIn();
        return true;
      }
      if (mod && key === '-') {
        zoom?.zoomOut();
        return true;
      }
      if (mod && key === '0') {
        zoom?.requestZoom(ZoomMode.FitWidth);
        return true;
      }
      if (mod && key === 's') {
        void save();
        return true;
      }
      if (mod && key === 'c') {
        void selectedText().then((text) => {
          if (text) void copyText(text);
        });
        return false;
      }
      if ((key === 'delete' || key === 'backspace') && !mod) return deleteSelected();
      if (key === 'escape' && selectedUids.length > 0) {
        annotationScope?.deselectAnnotation();
        return true;
      }
      if (key === 'escape' && tool !== 'select') {
        setTool('select');
        return true;
      }
      if (!mod && !event.altKey) {
        if (key === 'pagedown' || key === 'arrowright') {
          if (key === 'arrowright' && selectedUids.length) return false;
          scroll?.scrollToNextPage();
          return true;
        }
        if (key === 'pageup' || key === 'arrowleft') {
          if (key === 'arrowleft' && selectedUids.length) return false;
          scroll?.scrollToPreviousPage();
          return true;
        }
        const match = TOOLS.find((entry) => entry.key === key);
        if (match && !event.shiftKey) {
          setTool(match.id);
          return true;
        }
      }
      return false;
    });
  }, [resourceId, undo, redo, zoom, save, selectedText, deleteSelected, tool, scroll, selectedUids.length, annotationScope]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const windowElement = element.closest('[data-window-id]');
      if (!maximized && windowElement?.getAttribute('data-active') !== 'true') return;
      event.preventDefault();
      event.stopPropagation();
      if (!zoom) return;
      const rect = element.getBoundingClientRect();
      const cssScale = element.offsetWidth ? rect.width / element.offsetWidth : 1;
      const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025);
      zoom.requestZoomBy(Math.max(-0.5, Math.min(0.5, delta)), {
        vx: (event.clientX - rect.left) / cssScale,
        vy: (event.clientY - rect.top) / cssScale,
      } as never);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom, maximized]);

  const renderSelectionMenu = useCallback(
    ({ menuWrapperProps, placement }: { menuWrapperProps: React.HTMLAttributes<HTMLDivElement>; placement: { suggestTop?: boolean } }) => (
      <div {...menuWrapperProps}>
        <div className={cn('pdf-float-menu', placement.suggestTop ? 'pdf-float-menu-top' : 'pdf-float-menu-bottom')}>
          <button type="button" onClick={() =>
              void selectedText().then(async (text) => {
                if (!text) return;
                await copyText(text);
                clearSelection();
              })
            } title="Copy">
            <Copy size={13} /> Copy
          </button>
          <button type="button" onClick={() => markupSelection(PdfAnnotationSubtype.HIGHLIGHT)} title="Highlight">
            <Highlighter size={13} /> Highlight
          </button>
          <button type="button" onClick={() => markupSelection(PdfAnnotationSubtype.UNDERLINE)} title="Underline">
            <PenLine size={13} /> Underline
          </button>
          <button type="button" className="pdf-float-primary" onClick={() => void sendToCanvas()} title="Highlight and add as a card on the canvas">
            <StickyNote size={13} /> To canvas
          </button>
          <button ref={noteAnchor} type="button" className="pdf-float-primary" onClick={() => void openNotePicker()} title="Copy the selection to a note" aria-haspopup="listbox" aria-expanded={notePickerOpen}>
            <NotebookPen size={13} /> To note
          </button>
          <span className="pdf-float-divider" />
          <button type="button" onClick={() => void sendToAi('ask')} title="Ask the AI about this text">
            <MessageSquareText size={13} /> Ask AI
          </button>
          <button type="button" onClick={() => void sendToAi('explain')} title="Explain step by step">
            <BookOpenCheck size={13} /> Explain
          </button>
          <button type="button" onClick={() => void sendToAi('flashcards')} title="Create flashcards from the selection">
            Flashcards
          </button>
        </div>
      </div>
    ),
    [selectedText, clearSelection, markupSelection, sendToAi, sendToCanvas, openNotePicker, notePickerOpen],
  );

  const renderAnnotationMenu = useCallback(
    ({
      menuWrapperProps,
      placement,
      selected,
      context,
    }: {
      menuWrapperProps: React.HTMLAttributes<HTMLDivElement>;
      placement: { suggestTop?: boolean };
      selected: boolean;
      context?: { type: string; pageIndex?: number; annotation?: { object: { id: string; pageIndex: number } }; structurallyLocked?: boolean };
    }) => {
      const target = context?.type === 'annotation' ? context.annotation?.object : undefined;
      if (!selected || !target || context?.structurallyLocked) return null;
      return (
        <div {...menuWrapperProps}>
          <div className={cn('pdf-float-menu', placement.suggestTop ? 'pdf-float-menu-top' : 'pdf-float-menu-bottom')}>
            <button type="button" onClick={() => annotationScope?.deleteAnnotation(target.pageIndex, target.id)} className="danger" title="Delete (Del)">
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
      );
    },
    [annotationScope],
  );

  const drawingTool = tool !== 'select' && tool !== 'eraser' && tool !== 'highlight' && tool !== 'text';

  const renderPage = useCallback(
    (page: { pageIndex: number; width: number; height: number }) => (
      <ScaledPage key={page.pageIndex} documentId={documentId} pageIndex={page.pageIndex} dpr={dpr}>
        <div
          className={cn('pdf-layers', drawingTool && 'pdf-layers-locked')}
          style={
            layerZoom === 1
              ? undefined
              : {
                  right: 'auto',
                  bottom: 'auto',
                  width: `${layerZoom * 100}%`,
                  height: `${layerZoom * 100}%`,
                  transform: `scale(${1 / layerZoom})`,
                  transformOrigin: '0 0',
                }
          }
        >
          <SelectionLayer documentId={documentId} pageIndex={page.pageIndex} scale={layerScale} selectionMenu={renderSelectionMenu as never} />
          <AnnotationLayer
            documentId={documentId}
            pageIndex={page.pageIndex}
            scale={layerScale}
            selectionOutline={{ color: 'var(--primary)' } as never}
            selectionMenu={renderAnnotationMenu as never}
          />
        </div>
      </ScaledPage>
    ),
    [documentId, dpr, drawingTool, renderSelectionMenu, renderAnnotationMenu, layerZoom, layerScale],
  );

  const currentPage = scrollState?.currentPage ?? 1;
  const totalPages = documentState?.document?.pageCount ?? scrollState?.totalPages ?? 0;
  const pendingJump = usePdfNav((state) => state.pending[path]);

  // Honour "go to source" requests from highlight cards once the document is laid out.
  useEffect(() => {
    if (!pendingJump || !scroll || totalPages === 0) return;
    const timer = window.setTimeout(() => {
      scroll.scrollToPage({ pageNumber: Math.min(Math.max(1, pendingJump.page), totalPages), behavior: 'smooth' });
      usePdfNav.getState().clear(path, pendingJump.nonce);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pendingJump, scroll, totalPages, path]);

  // The scroll/zoom helpers get a new identity on every render, so the effects below read them through
  // refs and depend only on "is the viewer ready". Otherwise each render would cancel the work in progress.
  const scrollRef = useRef(scroll);
  const zoomRef = useRef(zoom);
  scrollRef.current = scroll;
  zoomRef.current = zoom;
  // The viewer reports a placeholder page count of 1 while the document is still loading, so use the
  // document's own page count: it only exists once the file has really been opened.
  const documentPages = documentState?.document?.pageCount ?? 0;
  const ready = Boolean(scroll && zoom && documentPages > 0);

  // Put the book back where it was: zoom first, then the exact spot on the page. The layout settles
  // asynchronously, so check where we landed and correct until it is right.
  useEffect(() => {
    if (!ready || restoredRef.current) return;
    const saved = savedViewRef.current;
    // Nothing saved, or a card / the Annotations tab asked for a specific page: that wins.
    if (!saved || usePdfNav.getState().pending[path]) {
      restoredRef.current = true;
      trackRef.current = true;
      return;
    }
    const target = clampPosition({ page: saved.page, y: saved.y }, documentPages);
    let attempts = 0;
    let requestedY = target.y;
    let timer: number | undefined;
    const giveUp = () => {
      // The position never took. Leave what was saved alone: tracking starts when you scroll yourself.
      restoredRef.current = true;
    };
    const settle = () => {
      restoredRef.current = true;
      trackRef.current = true;
      // After a programmatic jump the viewer keeps "the page I jumped to" as the current page. A one-pixel
      // nudge makes it work out the page that actually fills most of the window, as it does when you scroll.
      const scroller = viewportRef.current?.querySelector<HTMLElement>('.pdf-viewport-inner');
      if (scroller) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + 1;
        window.requestAnimationFrame(() => {
          scroller.scrollTop = before;
        });
      }
    };
    const attempt = () => {
      attempts += 1;
      const scrollNow = scrollRef.current;
      const zoomNow = zoomRef.current;
      try {
        if (attempts === 1 && saved.zoom !== DEFAULT_ZOOM) zoomNow?.requestZoom(toEngineZoom(saved.zoom));
        scrollNow?.scrollToPage({ pageNumber: target.page, pageCoordinates: { x: 0, y: requestedY }, behavior: 'instant', alignY: 0 });
      } catch {
        // The viewport is not ready yet; the next attempt will try again.
      }
      timer = window.setTimeout(() => {
        let landed: { page: number; y: number } | null = null;
        try {
          landed = positionFromVisibility(scrollRef.current?.getMetrics().pageVisibilityMetrics ?? []);
        } catch {
          // Metrics are not available yet.
        }
        if (landed && landed.page === target.page) {
          // The viewer places targets with a small fixed offset, so measure where we landed and correct for it.
          const error = landed.y - target.y;
          if (Math.abs(error) <= 1.5) return settle();
          requestedY = Math.max(0, requestedY - error);
        }
        if (attempts >= 14) giveUp();
        else attempt();
      }, attempts === 1 ? 200 : 150);
    };
    timer = window.setTimeout(attempt, 60);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [ready, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the reading position as you scroll. Skipped until the saved position has been applied,
  // so the initial "page 1" can never overwrite it. The store saves to disk shortly after (and on exit).
  useEffect(() => {
    const scrollNow = scrollRef.current;
    if (!ready || !scrollNow) return;
    return scrollNow.onScroll((metrics) => {
      if (!trackRef.current) return;
      const position = positionFromVisibility(metrics.pageVisibilityMetrics);
      if (!position) return;
      let level: unknown;
      try {
        level = zoomRef.current?.getState().zoomLevel;
      } catch {
        return;
      }
      useCanvas.getState().setPdfView(path, { page: position.page, y: position.y, zoom: toSavedZoom(level) });
    });
  }, [ready, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // If a restore ever fails, scrolling or clicking in the book yourself switches tracking on.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const start = () => {
      if (restoredRef.current) trackRef.current = true;
    };
    const events = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    events.forEach((name) => element.addEventListener(name, start, { passive: true, capture: true }));
    return () => events.forEach((name) => element.removeEventListener(name, start, { capture: true }));
  }, []);

  // A zoom change that leaves the scroll position where it was does not fire a scroll event, so track it directly.
  const savedZoomLevel = zoomState?.zoomLevel;
  useEffect(() => {
    if (!trackRef.current || savedZoomLevel === undefined) return;
    useCanvas.getState().setPdfView(path, { zoom: toSavedZoom(savedZoomLevel) });
  }, [savedZoomLevel, path]);

  // Remember pen colours and width for this book. Only written once they differ from the defaults.
  useEffect(() => {
    const saved = useCanvas.getState().pdfViews[path];
    const patch: { color?: string; highlightColor?: string; width?: number } = {};
    if (color !== DEFAULT_COLOR || saved?.color !== undefined) patch.color = color;
    if (highlightColor !== DEFAULT_HIGHLIGHT_COLOR || saved?.highlightColor !== undefined) patch.highlightColor = highlightColor;
    if (width !== DEFAULT_WIDTH || saved?.width !== undefined) patch.width = width;
    if (Object.keys(patch).length > 0) useCanvas.getState().setPdfView(path, patch);
  }, [color, highlightColor, width, path]);

  const zoomPercent = Math.round((zoomState?.currentZoomLevel ?? 1) * 100);
  const showColor = tool !== 'select' && tool !== 'eraser';
  const activeColor = tool === 'highlight' || tool === 'marker' ? highlightColor : color;

  return (
    <div className="pdf-window">
      <div className="pdf-toolbar" data-no-drag>
        <div className="pdf-tool-group">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn('tool-btn', tool === entry.id && 'tool-btn-active')}
              onClick={() => setTool(entry.id)}
              title={entry.label}
            >
              {entry.icon}
            </button>
          ))}
        </div>
        {showColor && (
          <div className="pdf-tool-group">
            <button
              ref={colorAnchor}
              type="button"
              className="color-dot"
              style={{ background: activeColor }}
              onClick={() => setColorOpen((v) => !v)}
              title="Color"
            />
            <Popover anchorRef={colorAnchor} open={colorOpen} onClose={() => setColorOpen(false)} width={236}>
              <ColorSwatches
                value={activeColor}
                onChange={(next) => {
                  changeColor(next);
                  setColorOpen(false);
                }}
              />
            </Popover>
            {tool !== 'highlight' && (
              <select
                className="select select-sm"
                value={width}
                onChange={(event) => changeWidth(Number(event.target.value))}
                title="Stroke width"
              >
                {STROKE_WIDTHS.map((value) => (
                  <option key={value} value={value}>
                    {value}px
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        <div className="pdf-tool-group">
          <button type="button" className="tool-btn" onClick={undo} disabled={!historyState.canUndo} title="Undo (Ctrl+Z)">
            <Undo2 size={14} />
          </button>
          <button type="button" className="tool-btn" onClick={redo} disabled={!historyState.canRedo} title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={14} />
          </button>
        </div>
        <div className="pdf-tool-group">
          <button type="button" className="tool-btn" onClick={() => scroll?.scrollToPreviousPage()} disabled={currentPage <= 1} title="Previous page">
            <ChevronLeft size={14} />
          </button>
          <input
            className="page-input"
            value={pageInput || String(currentPage)}
            onFocus={(event) => {
              setPageInput(String(currentPage));
              event.currentTarget.select();
            }}
            onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => setPageInput('')}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const target = Math.min(Math.max(1, parseInt(pageInput || '1', 10)), totalPages || 1);
              scroll?.scrollToPage({ pageNumber: target });
              setPageInput('');
              event.currentTarget.blur();
            }}
            aria-label="Page number"
          />
          <span className="page-total">/ {totalPages || '–'}</span>
          <button
            type="button"
            className="tool-btn"
            onClick={() => scroll?.scrollToNextPage()}
            disabled={totalPages === 0 || currentPage >= totalPages}
            title="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="pdf-tool-group">
          <button type="button" className="tool-btn" onClick={() => zoom?.zoomOut()} title="Zoom out (Ctrl+-)">
            <ZoomOut size={14} />
          </button>
          <button type="button" className="zoom-label" onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)} title="Fit width (Ctrl+0)">
            {zoomPercent}%
          </button>
          <button type="button" className="tool-btn" onClick={() => zoom?.zoomIn()} title="Zoom in (Ctrl+=)">
            <ZoomIn size={14} />
          </button>
        </div>
        <div className="pdf-toolbar-spacer" />
        <span className={cn('save-state', `save-state-${saveState}`)}>
          {saveState === 'pending' || saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
        </span>
        <button type="button" className="tool-btn" onClick={() => void exportCopy()} title="Export a copy">
          <Download size={14} />
        </button>
      </div>
      <NoteClipPicker
        anchorRef={noteAnchor}
        open={notePickerOpen}
        onClose={() => setNotePickerOpen(false)}
        onPickNote={(notePath) => void copyToNote({ path: notePath })}
        onPickNew={() => void copyToNote('new')}
      />
      <div ref={viewportRef} className={cn('pdf-viewport', `pdf-tool-${tool}`)}>
        <Viewport documentId={documentId} className="pdf-viewport-inner">
          <Scroller documentId={documentId} renderPage={renderPage} />
        </Viewport>
      </div>
    </div>
  );
}

export default memo(PdfWindow);
