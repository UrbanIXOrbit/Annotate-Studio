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
import { toast } from '@/store/toast';
import {
  KIND_GROUPS,
  buildReport,
  compareBooks,
  countByGroup,
  filterEntries,
  groupByPage,
  kindLabel,
  sortEntries,
  type AnnotationEntry,
  type AnnotationKind,
  type BookAnnotations,
} from '@/lib/annotations';
import { FORMAT_META, type ExportFormat } from '@/lib/annotation-export';
import { exportReport } from '@/lib/export-file';
import { openPdfAtPage } from '@/lib/card-actions';
import { cn, copyText, stripExtension } from '@/lib/utils';

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
  const libraryLoaded = useLibrary((state) => state.loaded);
  const setView = useApp((state) => state.setView);
  const { books, selected, groups, query, hideEmpty, scanning, progress, select, setQuery, toggleGroup, setHideEmpty, scan } = useAnnotations();
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const pdfs = useMemo(() => files.filter((file) => file.file_type === 'Pdf'), [files]);

  useEffect(() => {
    void scan(pdfs);
  }, [pdfs, scan]);

  const rows = useMemo(
    () =>
      pdfs
        .map((file) => ({ file, title: stripExtension(file.name), state: books[file.path] }))
        .sort(compareBooks),
    [pdfs, books],
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

  const openPage = (book: BookAnnotations, page: number) => {
    if (openPdfAtPage(book.path, page, book.title)) setView('canvas');
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
    : pdfs.length === 0
      ? 'No PDFs in your library yet'
      : scanning
        ? `Reading annotations… ${progress.done} of ${progress.total} books`
        : `${totalAll} annotation${totalAll === 1 ? '' : 's'} across ${rows.filter((row) => (row.state?.data?.entries.length ?? 0) > 0).length} of ${pdfs.length} book${pdfs.length === 1 ? '' : 's'}`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Annotations</h1>
          <p>{subtitle}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void scan(pdfs, { force: true })} title="Re-read all PDFs" disabled={scanning}>
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

      {pdfs.length === 0 ? (
        <div className="anno-empty-state">
          <Highlighter size={30} />
          <h2>Nothing to show yet</h2>
          <p>Import a PDF, highlight or annotate it, and every annotation will be collected here, book by book and page by page.</p>
          <button type="button" className="btn btn-primary" onClick={() => setView('library')}>
            Go to Library
          </button>
        </div>
      ) : (
        <div className="annotations-layout">
          <aside className="annotations-books" aria-label="Books">
            <button type="button" className={cn('anno-book-row', active === 'all' && 'active')} onClick={() => select('all')}>
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
                  title={row.state?.status === 'error' ? `Could not read this PDF: ${row.state.error}` : row.file.name}
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
                    <h2>Reading your PDFs…</h2>
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
                    <p>Open a PDF on the canvas and highlight text or add a note. It will appear here automatically.</p>
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
                      <button type="button" className="anno-page-title" onClick={() => openPage(book, group.page)} title="Open this page">
                        Page {group.page} <ExternalLink size={12} />
                      </button>
                      <div className="anno-list">
                        {group.entries.map((entry) => (
                          <AnnotationRow key={entry.id} entry={entry} onOpen={() => openPage(book, entry.page)} />
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
