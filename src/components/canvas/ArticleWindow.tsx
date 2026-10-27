'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Readability } from '@mozilla/readability';
import { BookOpen, Copy, ExternalLink, Highlighter, LoaderCircle, Minus, NotebookPen, Plus, RefreshCw, RotateCcw, ScanText } from 'lucide-react';
import { useCanvas, type ArticleHighlight, type Resource } from '@/store/canvas';
import { fetchWebPage } from '@/lib/tauri-commands';
import { clipToNewNote, clipToNote } from '@/lib/note-clip-actions';
import NoteClipPicker from './NoteClipPicker';
import { toast, useToasts } from '@/store/toast';
import { copyText } from '@/lib/utils';

interface SelectionState {
  text: string;
  prefix: string;
  suffix: string;
  x: number;
  top: number;
}

function safeArticleHtml(html: string, baseUrl: string): string {
  const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
  const parsed = new DOMParser().parseFromString(safe, 'text/html');
  for (const link of parsed.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    try {
      const target = new URL(link.getAttribute('href') || '', baseUrl);
      if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.removeAttribute('href');
      }
    } catch {
      link.removeAttribute('href');
    }
  }
  for (const media of parsed.querySelectorAll('[src]')) {
    try {
      const target = new URL(media.getAttribute('src') || '', baseUrl);
      if (target.protocol === 'https:' || target.protocol === 'http:') media.setAttribute('src', target.href);
      else media.removeAttribute('src');
    } catch {
      media.removeAttribute('src');
    }
  }
  return parsed.body.innerHTML;
}

function makeTextRange(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let cursor = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && start >= cursor && start <= cursor + length) {
      startNode = node;
      startOffset = start - cursor;
    }
    if (end >= cursor && end <= cursor + length) {
      endNode = node;
      endOffset = end - cursor;
      break;
    }
    cursor += length;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function findAnchorRange(root: HTMLElement, anchor: Pick<ArticleHighlight, 'text' | 'prefix' | 'suffix'>): Range | null {
  const text = root.textContent ?? '';
  let index = -1;
  let from = 0;
  while ((from = text.indexOf(anchor.text, from)) >= 0) {
    const prefix = text.slice(Math.max(0, from - anchor.prefix.length), from);
    const suffix = text.slice(from + anchor.text.length, from + anchor.text.length + anchor.suffix.length);
    if ((!anchor.prefix || prefix.endsWith(anchor.prefix)) && (!anchor.suffix || suffix.startsWith(anchor.suffix))) {
      index = from;
      break;
    }
    from += Math.max(1, anchor.text.length);
  }
  return index < 0 ? null : makeTextRange(root, index, index + anchor.text.length);
}

function rangeOffset(root: HTMLElement, target: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === target) return total + offset;
    total += node.textContent?.length ?? 0;
  }
  return total;
}

function anchorForSelection(root: HTMLElement, range: Range, text: string): Pick<ArticleHighlight, 'text' | 'prefix' | 'suffix'> {
  const fullText = root.textContent ?? '';
  const rawSelection = range.toString();
  const start = rangeOffset(root, range.startContainer, range.startOffset) + (rawSelection.length - rawSelection.trimStart().length);
  const end = start + text.length;
  return { text, prefix: fullText.slice(Math.max(0, start - 48), start), suffix: fullText.slice(end, end + 48) };
}

function highlightNames(resourceId: string) {
  const suffix = resourceId.replace(/[^a-z0-9_-]/gi, '-');
  return { saved: `article-saved-${suffix}`, selection: `article-selection-${suffix}`, styleId: `article-highlight-style-${suffix}` };
}

function clearHighlights(resourceId: string) {
  const css = (window as Window & { CSS?: typeof CSS }).CSS as (typeof CSS & { highlights?: Map<string, unknown> }) | undefined;
  const names = highlightNames(resourceId);
  css?.highlights?.delete(names.saved);
  css?.highlights?.delete(names.selection);
  document.getElementById(names.styleId)?.remove();
}

function paintHighlights(root: HTMLElement, highlights: ArticleHighlight[], selection: SelectionState | null, resourceId: string) {
  const css = (window as Window & { CSS?: typeof CSS }).CSS as (typeof CSS & { highlights?: Map<string, unknown> }) | undefined;
  const HighlightCtor = (window as Window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !HighlightCtor) return;
  const names = highlightNames(resourceId);
  const ranges = highlights.flatMap((item) => {
    const range = findAnchorRange(root, item);
    if (!range) return [];
    return [range];
  });
  css.highlights.set(names.saved, new HighlightCtor(...ranges));
  let style = document.getElementById(names.styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = names.styleId;
    document.head.append(style);
  }
  style.textContent = `::highlight(${names.saved}){background-color:rgb(255 224 102 / 75%);color:inherit}::highlight(${names.selection}){background-color:rgb(99 167 255 / 45%);color:inherit}`;
  if (selection) {
    const active = window.getSelection();
    if (active?.rangeCount && root.contains(active.getRangeAt(0).commonAncestorContainer)) {
      css.highlights.set(names.selection, new HighlightCtor(active.getRangeAt(0).cloneRange()));
    } else {
      css.highlights.delete(names.selection);
    }
  } else {
    css.highlights.delete(names.selection);
  }
}

export default function ArticleWindow({ resourceId }: { resourceId: string }) {
  const resource = useCanvas((state) => state.workspaces.flatMap((workspace) => workspace.resources).find((item) => item.id === resourceId)) as Resource | undefined;
  const articleUrl = resource?.articleUrl;
  const articleContent = resource?.content;
  const articleHighlights = resource?.articleHighlights ?? [];
  const containerRef = useRef<HTMLDivElement>(null);
  const noteAnchor = useRef<HTMLButtonElement>(null);
  const clipRef = useRef<{ text: string; title: string; page: number } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(articleContent ? 'ready' : 'loading');
  const [error, setError] = useState('');
  const [articleTitle, setArticleTitle] = useState(resource?.title ?? 'Web article');
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectText, setSelectText] = useState(true);
  const [fontScale, setFontScale] = useState(1);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  const loadArticle = useCallback(async () => {
    if (!articleUrl) return;
    setStatus('loading');
    setError('');
    try {
      const result = await fetchWebPage(articleUrl);
      const doc = new DOMParser().parseFromString(result.html, 'text/html');
      const parsedUrl = new URL(result.url);
      const base = doc.createElement('base');
      base.href = parsedUrl.href;
      doc.head.prepend(base);
      const article = new Readability(doc).parse();
      if (!article?.content?.trim()) throw new Error('No readable article content was found on this page.');
      const html = safeArticleHtml(article.content, parsedUrl.href);
      const title = article.title?.trim() || resource?.title || parsedUrl.hostname;
      useCanvas.getState().updateResource(resourceId, { content: html, articleUrl: result.url, title });
      setArticleTitle(title);
      setStatus('ready');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setStatus('error');
    }
  }, [articleUrl, resource?.title, resourceId]);

  useEffect(() => {
    if (articleContent) {
      setStatus('ready');
      if (resource?.title) setArticleTitle(resource.title);
    } else if (articleUrl) {
      void loadArticle();
    }
  }, [articleContent, articleUrl, loadArticle, resource?.title]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || status !== 'ready') return;
    root.innerHTML = safeArticleHtml(articleContent ?? '', articleUrl ?? 'https://example.com');
    return () => {
      clearHighlights(resourceId);
    };
  }, [articleContent, articleUrl, resourceId, status]);

  const onSelectionChange = useCallback(() => {
    const root = containerRef.current;
    const selected = window.getSelection();
    if (!root || !selected || selected.isCollapsed || !selectText || !selected.rangeCount) {
      setSelection(null);
      setMenuPosition(null);
      return;
    }
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setSelection(null);
      setMenuPosition(null);
      return;
    }
    const text = selected.toString().trim();
    if (!text || text.length > 8000) return;
    const bounds = range.getBoundingClientRect();
    const rootBounds = root.getBoundingClientRect();
    const anchor = anchorForSelection(root, range, text);
    setSelection({ ...anchor, x: bounds.left + bounds.width / 2, top: bounds.top });
    setMenuPosition({ left: Math.max(8, Math.min(bounds.left - rootBounds.left + bounds.width / 2, rootBounds.width - 220)), top: Math.max(8, bounds.top - rootBounds.top - 50) });
  }, [selectText]);

  useEffect(() => {
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [onSelectionChange]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    paintHighlights(root, articleHighlights, selection, resourceId);
  }, [articleHighlights, resourceId, selection]);

  const makeHighlight = useCallback(() => {
    if (!selection) return;
    const item: ArticleHighlight = {
      id: crypto.randomUUID(),
      text: selection.text,
      prefix: selection.prefix,
      suffix: selection.suffix,
      color: '#ffe066',
      createdAt: new Date().toISOString(),
    };
    useCanvas.getState().updateResource(resourceId, { articleHighlights: [...articleHighlights, item] });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    toast.success('Highlight saved');
  }, [articleHighlights, resourceId, selection]);

  const sendToCanvas = useCallback(() => {
    if (!selection) return;
    const cardId = useCanvas.getState().addCard({
      title: articleTitle,
      content: selection.text,
      note: articleUrl ?? undefined,
      color: '#fff4b8',
      near: resourceId,
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    useToasts.getState().push({ kind: 'success', title: 'Added to canvas', description: articleTitle, action: { label: 'Show', run: () => useCanvas.getState().focusResource(cardId) } });
  }, [articleTitle, articleUrl, resourceId, selection]);

  const openNotePicker = useCallback(() => {
    if (!selection) return;
    clipRef.current = { text: selection.text, title: articleTitle, page: 1 };
    setNotePickerOpen((open) => !open);
  }, [articleTitle, selection]);

  const copyToNote = useCallback(async (target: { path: string } | 'new') => {
    const clip = clipRef.current;
    setNotePickerOpen(false);
    if (!clip) return;
    const added = target === 'new' ? await clipToNewNote(clip, resourceId) : await clipToNote(target.path, clip);
    if (added) {
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      clipRef.current = null;
    }
  }, [resourceId]);

  const copySelection = useCallback(async () => {
    if (!selection) return;
    const copied = await copyText(selection.text);
    if (copied) toast.success('Copied selection');
  }, [selection]);

  if (!resource) return null;
  return (
    <div className="article-window">
      <div className="pdf-toolbar article-toolbar" data-no-drag>
        <div className="pdf-tool-group">
          <button type="button" className={`tool-btn ${selectText ? 'tool-btn-active' : ''}`} onClick={() => setSelectText((value) => !value)} title="Select text"><ScanText size={14} /><span>Select</span></button>
          <button type="button" className="tool-btn" onClick={() => setFontScale((value) => Math.max(0.7, Math.round((value - 0.1) * 10) / 10))} title="Zoom out"><Minus size={14} /></button>
          <span className="article-zoom-label">{Math.round(fontScale * 100)}%</span>
          <button type="button" className="tool-btn" onClick={() => setFontScale((value) => Math.min(1.8, Math.round((value + 0.1) * 10) / 10))} title="Zoom in"><Plus size={14} /></button>
          <button type="button" className="tool-btn" onClick={() => setFontScale(1)} title="Reset zoom"><RotateCcw size={13} /></button>
        </div>
        <div className="pdf-toolbar-spacer" />
        <button type="button" className="tool-btn" onClick={() => articleUrl && window.open(articleUrl, '_blank', 'noopener,noreferrer')} title="Open original page"><ExternalLink size={14} /></button>
        <button type="button" className="tool-btn" onClick={() => void loadArticle()} title="Refresh article"><RefreshCw size={14} /></button>
      </div>
      <div className="article-reader-scroll">
        {status === 'loading' && <div className="article-state"><LoaderCircle size={22} className="article-spinner" /><span>Fetching and preparing article…</span></div>}
        {status === 'error' && <div className="article-state article-state-error"><BookOpen size={24} /><strong>Couldn’t load this article</strong><span>{error}</span><button type="button" onClick={() => void loadArticle()}><RefreshCw size={13} /> Try again</button></div>}
        {status === 'ready' && (
          <div className="article-reading-column" style={{ fontSize: `${fontScale}em` }}>
            <div className="article-meta"><span>WEB ARTICLE</span><a href={articleUrl} target="_blank" rel="noreferrer">{articleUrl}</a></div>
            <h1>{articleTitle}</h1>
            <div ref={containerRef} className={`article-content ${selectText ? '' : 'article-no-select'}`} onMouseUp={onSelectionChange} onKeyUp={onSelectionChange} />
            {selection && menuPosition && (
              <div className="article-selection-menu" style={{ left: menuPosition.left, top: menuPosition.top }} data-no-drag>
                <button type="button" onClick={() => void copySelection()} title="Copy selection"><Copy size={13} /> Copy</button>
                <button type="button" onClick={makeHighlight} title="Save highlight"><Highlighter size={13} /> Highlight</button>
                <button type="button" className="pdf-float-primary" onClick={sendToCanvas} title="Add quote to canvas"><BookOpen size={13} /> To canvas</button>
                <button ref={noteAnchor} type="button" className="pdf-float-primary" onClick={openNotePicker} title="Add quote to note"><NotebookPen size={13} /> To note</button>
              </div>
            )}
          </div>
        )}
      </div>
      <NoteClipPicker anchorRef={noteAnchor} open={notePickerOpen} onClose={() => setNotePickerOpen(false)} onPickNote={(path) => void copyToNote({ path })} onPickNew={() => void copyToNote('new')} />
    </div>
  );
}
