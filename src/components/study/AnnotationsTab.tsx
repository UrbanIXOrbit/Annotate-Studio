'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FileDown,
  FileText,
  Highlighter,
  MessageSquareText,
  PencilLine,
  RefreshCw,
  Search,
  Shapes,
  Stamp,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
} from 'lucide-react';
import { useLibrary } from '@/store/library';
import { useApp } from '@/store/app';
import { useAnnotations } from '@/store/annotations';
import { useWorkspaceScopes } from '@/store/workspace-scopes';
import type { AnnotationFile } from '@/store/annotations';
import { useCanvas } from '@/store/canvas';
import { toast } from '@/store/toast';
import { statExternalFile } from '@/lib/tauri-commands';
import {
  KIND_GROUPS,
  buildReport,
  compareBooks,
  countByGroup,
  filterEntries,
  ALL_GROUPS,
  groupByPage,
  kindLabel,
  sortEntries,
  type AnnotationEntry,
  type AnnotationKind,
  type KindGroup,
  type BookAnnotations,
} from '@/lib/annotations';
import { FORMAT_META, type ExportFormat } from '@/lib/annotation-export';
import { exportReport } from '@/lib/export-file';
import { openBookAtCfi, openPdfAtPage } from '@/lib/card-actions';
import { baseName, cn, copyText, stripExtension } from '@/lib/utils';
import { locationLabel } from '@/lib/annotations';

const KIND_ICON: Record<AnnotationKind, React.ReactNode> = {
  highlight: <Highlighter size={13} />,
  underline: <Underline size={13} />,
  strikeout: <Strikethrough size={13} />,
  squiggly: <Underline size={13} />,
  note: <StickyNote size={13} />,
  text: <Type size={13} />,
  drawing: <PencilLine size={13} />,
  shape: <Shapes size={13} />,
  line: <PencilLine size={13} />,
  stamp: <Stamp size={13} />,
};

const EXPORT_FORMATS: ExportFormat[] = ['md', 'docx', 'pdf'];

function AnnotationRow({ entry, onOpen }: { entry: AnnotationEntry; onOpen: () => void }) {
  const copy = async () => {
    const text = [entry.text, entry.comment && (entry.text ? `Comment: ${entry.comment}` : entry.comment)].filter(Boolean).join('\n');
    if (!text) return;
    if (await copyText(text)) toast.success('Copied');
  };
  const meta = [entry.author, entry.modified ? entry.modified.slice(0, 10) : ''].filter(Boolean).join(' · ');
  const isNote = !entry.text && entry.comment;

  return (
    <article className="anno-item" style={{ '--anno-color': entry.color ?? 'var(--border-strong)' } as React.CSSProperties}>
      <div className="anno-item-body">
        <div className="anno-item-head">
          <span className="anno-kind">
            {KIND_ICON[entry.kind]} {kindLabel(entry.kind)}
          </span>
          {meta && <span className="anno-meta">{meta}</span>}
        </div>
        {entry.text && (
          <blockquote className="anno-text" dir="auto">
            {entry.text}
          </blockquote>
        )}
        {entry.comment && (
          <p className={cn('anno-comment', isNote && 'anno-comment-note')} dir="auto">
            {!isNote && <MessageSquareText size={13} />}
            <span>{entry.comment}</span>
          </p>
        )}
        {!entry.text && !entry.comment && <p className="anno-empty">No text</p>}
      </div>
      <div className="anno-item-actions">
        {(entry.text || entry.comment) && (
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => void copy()} title="Copy text">
            <Copy size={14} />
          </button>
        )}
        <button type="button" className="icon-btn icon-btn-sm" onClick={onOpen} title="Open this page">
          <ExternalLink size={14} />
        </button>
      </div>
    </article>
  );
}

export default function AnnotationsTab() {
  const files = useLibrary((state) => state.files);
  const allFiles = useLibrary((state) => state.allFiles);
  const allWorkspaces = useWorkspaceScopes((state) => state.allWorkspaces);
  const libraryLoaded = useLibrary((state) => state.loaded);
  const canvasWorkspaces = useCanvas((state) => state.workspaces);
  const activeWorkspaceId = useCanvas((state) => state.activeWorkspaceId);
  const externalDocs = useMemo(() =>
    canvasWorkspaces
      .filter((workspace) => allWorkspaces || workspace.id === activeWorkspaceId)
      .flatMap((workspace) => workspace.resources
        .filter((resource) => (resource.type === 'pdf' || resource.type === 'book') && resource.isExternal && !!resource.filePath)
        .map((resource) => ({ path: resource.filePath!, type: resource.type }))),
  [canvasWorkspaces, allWorkspaces, activeWorkspaceId]);
  // External documents are not in the library scan, so stat them for a real
  // cache key — a constant key would never notice edits to the file on disk.
  const [externalMeta, setExternalMeta] = useState<Record<string, { size: number; modified_at: string }>>({});
  const externalKey = externalDocs.map((doc) => doc.path).join('|');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      externalDocs.map(async ({ path }) => {
        try {
          const file = await statExternalFile(path);
          return [path, file ? { size: file.size, modified_at: file.modified_at } : null] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const found = entries.filter((entry): entry is readonly [string, { size: number; modified_at: string }] => !!entry[1]);
      setExternalMeta(Object.fromEntries(found.map(([path, meta]) => [path, meta])));
    });
    return () => { cancelled = true; };
  }, [externalKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setView = useApp((state) => state.setView);
  const workspaceId = useCanvas((state) => state.activeWorkspaceId);
  const scope = useWorkspaceScopes((state) => state.scopes[workspaceId]);
  const setAnnotationView = useWorkspaceScopes((state) => state.setAnnotations);
  const { books: activeBooks, scanning, progress, revision, scan } = useAnnotations();
  const allScopes = useWorkspaceScopes((state) => state.scopes);
  const books = allWorkspaces
    ? Object.assign({}, ...Object.values(allScopes).map((entry) => entry.books))
    : activeBooks;
  // View state is per workspace; the annotation data itself stays global.
  const selected = scope?.annotations.selected ?? 'all';
  const groups = scope?.annotations.groups ?? ALL_GROUPS;
  const query = scope?.annotations.query ?? '';
  const hideEmpty = scope?.annotations.hideEmpty ?? true;
  const select = (value: string) => setAnnotationView(workspaceId, { selected: value });
  const setQuery = (value: string) => setAnnotationView(workspaceId, { query: value });
  const toggleGroup = (id: KindGroup) => setAnnotationView(workspaceId, {
    groups: { ...groups, [id]: !groups[id] },
  });
  const setHideEmpty = (value: boolean) => setAnnotationView(workspaceId, { hideEmpty: value });
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const scannable = useMemo<AnnotationFile[]>(() => {
    const sourceFiles = allWorkspaces ? allFiles : files;
    const inLibrary: AnnotationFile[] = sourceFiles.filter((file) => file.file_type === 'Pdf' || file.file_type === 'Book');
    const outsideWorkspace: AnnotationFile[] = externalDocs.map(({ path, type }) => ({
      id: `external:${path}`,
      name: baseName(path),
      path,
      file_type: type === 'book' ? 'Book' : 'Pdf',
      size: externalMeta[path]?.size ?? 0,
      created_at: '',
      modified_at: externalMeta[path]?.modified_at ?? '',
      isExternal: true,
    }));
    return [...new Map([...inLibrary, ...outsideWorkspace].map((file) => [file.path, file])).values()];
  }, [externalDocs, files, externalMeta]);

  useEffect(() => {
    // The global view is read-only: don't scan other workspaces' files into
    // the active workspace's annotation store.
    if (allWorkspaces) return;
    void scan(scannable);
  }, [scannable, revision, scan, allWorkspaces]);

  const rows = useMemo(
    () =>
      scannable
        .map((file) => ({ file, title: stripExtension(file.name), state: books[file.path] }))
        .sort(compareBooks),
    [scannable, books],
  );

  const active = selected === 'all' || rows.some((row) => row.file.path === selected) ? selected : 'all';
  const listed = hideEmpty ? rows.filter((row) => row.state?.status !== 'done' || (row.state.data?.entries.length ?? 0) > 0) : rows;

  const scoped: BookAnnotations[] = useMemo(
    () => rows.filter((row) => active === 'all' || row.file.path === active).flatMap((row) => (row.state?.data ? [row.state.data] : [])),
    [rows, active],
  );

  const filter = useMemo(() => ({ groups, query }), [groups, query]);
  const sections = useMemo(
    () =>
      scoped
        .map((book) => ({ book, pages: groupByPage(sortEntries(filterEntries(book.entries, filter))) }))
        .filter((section) => section.pages.length > 0),
    [scoped, filter],
  );

  const totalAll = rows.reduce((sum, row) => sum + (row.state?.data?.entries.length ?? 0), 0);
  const scopeEntries = useMemo(() => scoped.flatMap((book) => book.entries), [scoped]);
  const groupCounts = useMemo(() => countByGroup(scopeEntries), [scopeEntries]);
  const shown = sections.reduce((sum, section) => sum + section.pages.reduce((n, page) => n + page.entries.length, 0), 0);
  const filtering = query.trim() !== '' || Object.values(groups).some((on) => !on);
  const waiting = rows.some((row) => row.state?.status === 'scanning' || !row.state);
  const activeTitle = active === 'all' ? 'All books' : (rows.find((row) => row.file.path === active)?.title ?? 'Annotations');

  /** Jump to an annotation: e-books by their saved CFI location, PDFs by page. */
  const openAnnotation = (book: BookAnnotations, entry: AnnotationEntry) => {
    const isExternal = rows.find((row) => row.file.path === book.path)?.file.isExternal === true;
    const opened = entry.cfi
      ? openBookAtCfi(book.path, entry.cfi, book.title, isExternal)
      : openPdfAtPage(book.path, entry.page, book.title, isExternal);
    if (opened) setView('canvas');
  };

  const openGroup = (book: BookAnnotations, entries: AnnotationEntry[]) => {
    const isExternal = rows.find((row) => row.file.path === book.path)?.file.isExternal === true;
    const withCfi = entries.find((entry) => entry.cfi);
    if (withCfi?.cfi) {
      if (openBookAtCfi(book.path, withCfi.cfi, book.title, isExternal)) setView('canvas');
      return;
    }
    if (openPdfAtPage(book.path, entries[0]?.page ?? 1, book.title, isExternal)) setView('canvas');
  };

  const exportAs = async (format: ExportFormat) => {
    const report = buildReport(scoped, filter, activeTitle);
    if (report.totalCount === 0) {
      toast.warning('Nothing to export', 'No annotations match the current view.');
      return;
    }
    setExporting(format);
    try {
      const result = await exportReport(report, format);
      if (result.status === 'cancelled') return;
      toast.success(`${FORMAT_META[format].label} exported`, result.path ?? `${report.totalCount} annotations`);
      if (result.replacedChars > 0) {
        toast.warning(
          'Some characters are missing in the PDF',
          `${result.replacedChars} character${result.replacedChars === 1 ? '' : 's'} the PDF fonts cannot draw (for example Arabic or Chinese) became “?”. Export to Word or Markdown to keep them.`,
        );
      }
    } catch (error) {
      toast.error('Export failed', error);
    } finally {
      setExporting(null);
    }
  };

  const subtitle = !libraryLoaded
    ? 'Loading your library…'
    : scannable.length === 0
      ? 'No PDFs or e-books in your library yet'
      : scanning
        ? `Reading annotations… ${progress.done} of ${progress.total} books`
        : `${totalAll} annotation${totalAll === 1 ? '' : 's'} across ${rows.filter((row) => (row.state?.data?.entries.length ?? 0) > 0).length} of ${scannable.length} book${scannable.length === 1 ? '' : 's'}`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Annotations</h1>
          <p>{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void scan(scannable, { force: true })} title="Re-read all PDFs and e-books" disabled={scanning}>
            <RefreshCw size={15} className={scanning ? 'spin' : undefined} />
          </button>
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              className="btn btn-secondary"
              onClick={() => void exportAs(format)}
              disabled={exporting !== null || shown === 0}
              title={`Export ${active === 'all' ? 'all books' : 'this book'}${filtering ? ' (with current filters)' : ''} as ${FORMAT_META[format].label}`}
            >
              <FileDown size={15} className={exporting === format ? 'spin' : undefined} /> {FORMAT_META[format].label}
            </button>
          ))}
        </div>
      </header>

      {scannable.length === 0 ? (
        <div className="anno-empty-state">
          <Highlighter size={30} />
          <h2>Nothing to show yet</h2>
          <p>Open a PDF or e-book, highlight or annotate it, and every annotation will be collected here, book by book and page by page.</p>
          <button type="button" className="btn btn-primary" onClick={() => setView('library')}>
            Go to Library
          </button>
        </div>
      ) : (
        <div className="annotations-layout">
          <aside className="annotations-books" aria-label="Books">
            <button type="button" aria-pressed={active === 'all'} className={cn('anno-book-row', active === 'all' && 'active')} onClick={() => select('all')}>
              <Highlighter size={15} />
              <span className="anno-book-name">All books</span>
              <span className="anno-count">{totalAll}</span>
            </button>
            <div className="anno-book-divider" />
            {listed.map((row) => {
              const count = row.state?.data?.entries.length ?? 0;
              return (
                <button
                  key={row.file.path}
                  type="button"
                  className={cn('anno-book-row', active === row.file.path && 'active', row.state?.status === 'done' && count === 0 && 'dim')}
                  onClick={() => select(row.file.path)}
                  title={row.state?.status === 'error' ? `Could not read this file: ${row.state.error}` : row.file.name}
                >
                  <FileText size={15} />
                  <span className="anno-book-name">{row.title}</span>
                  {row.state?.status === 'error' ? (
                    <AlertTriangle size={14} className="anno-error-icon" />
                  ) : row.state?.status === 'scanning' || !row.state ? (
                    <RefreshCw size={12} className="spin anno-spinner" />
                  ) : (
                    <span className="anno-count">{count}</span>
                  )}
                </button>
              );
            })}
            <label className="anno-hide-empty">
              <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} /> Hide books without annotations
            </label>
          </aside>

          <section className="annotations-main">
            <div className="annotations-toolbar">
              <div className="search-field">
                <Search size={15} />
                <input
                  className="input"
                  value={query}
                  placeholder="Search highlights, notes and comments…"
                  onChange={(event) => setQuery(event.target.value)}
                  dir="auto"
                />
              </div>
              <div className="chip-row">
                {KIND_GROUPS.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={cn('chip', groups[group.id] && 'chip-active')}
                    onClick={() => toggleGroup(group.id)}
                    aria-pressed={groups[group.id]}
                  >
                    {group.label} <span className="anno-chip-count">{groupCounts[group.id]}</span>
                  </button>
                ))}
              </div>
            </div>

            {sections.length === 0 ? (
              <div className="anno-empty-state">
                {waiting && scoped.length === 0 ? (
                  <>
                    <RefreshCw size={26} className="spin" />
                    <h2>Reading your books…</h2>
                  </>
                ) : filtering && scopeEntries.length > 0 ? (
                  <>
                    <Search size={28} />
                    <h2>No annotations match</h2>
                    <p>Try a different search, or switch the filters back on.</p>
                  </>
                ) : (
                  <>
                    <Highlighter size={30} />
                    <h2>{active === 'all' ? 'No annotations yet' : 'No annotations in this book'}</h2>
                    <p>Open a PDF or e-book on the canvas and highlight text. It will appear here automatically.</p>
                  </>
                )}
              </div>
            ) : (
              sections.map(({ book, pages }) => (
                <section key={book.path} className="anno-book">
                  <header className="anno-book-header">
                    <FileText size={16} />
                    <h2 dir="auto">{book.title}</h2>
                    <span className="anno-count">{pages.reduce((sum, page) => sum + page.entries.length, 0)}</span>
                  </header>
                  {pages.map((group) => (
                    <div key={group.page} className="anno-page">
                      <button type="button" className="anno-page-title" onClick={() => openGroup(book, group.entries)} title="Open this location">
                        {locationLabel(book, group.page)} <ExternalLink size={12} />
                      </button>
                      <div className="anno-list">
                        {group.entries.map((entry) => (
                          <AnnotationRow key={entry.id} entry={entry} onOpen={() => openAnnotation(book, entry)} />
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
