'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookMarked, Check, Copy, Download, Eye, Loader2, RotateCw, X } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation, type BookFile } from '@/store/books';
import { citationReview, extractCitationFromFile, findDuplicates, isCitationCapable, lookupByIsbn } from '@/lib/book-citations';
import {
  CITATION_STYLES,
  EXPORT_FORMATS,
  renderBibliographyRich,
  renderExport,
  type CitationStyle,
  type ExportFormat,
} from '@/lib/citation-formats';
import { saveExportedFile } from '@/lib/export-file';
import { errorMessage } from '@/lib/tauri-commands';
import { copyRichText, copyText } from '@/lib/utils';
import Dialog from '@/components/ui/Dialog';
import { AddCitationDialog } from './AddCitationDialog';

interface CitationsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Files in scope, fixed when the dialog was opened. Filtered down to citatable books here. */
  fileIds: string[];
}

type RowStatus = 'missing' | 'working' | 'matched' | 'review' | 'error';
type RowFilter = 'all' | 'review' | 'error' | 'missing';

const STATUS_LABEL: Record<RowStatus, string> = {
  missing: 'No citation',
  working: 'Working…',
  matched: 'Verified',
  review: 'Needs review',
  error: 'Failed',
};

/**
 * Batch citation tool: pick the books, preview their citations in the chosen
 * style, and copy/export them for reference managers. Books without a saved
 * citation can be generated here or refined via the Add citation dialog.
 */
export function CitationsDialog({ open, onClose, fileIds }: CitationsDialogProps) {
  const { files, updateFile } = useBooks();

  const citatable = useMemo(
    () =>
      fileIds
        .map((id) => files[id])
        .filter((f): f is BookFile => !!f && isCitationCapable(f.extension)),
    // The scope is frozen per open; recompute when it or the library changes.
    [fileIds, files],
  );
  const scopeKey = citatable.map((f) => f.id).join(',');

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Books whose online check could not complete (offline, rate-limited): they kept their file metadata */
  const [lookupFailed, setLookupFailed] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<RowFilter>('all');
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [style, setStyle] = useState<CitationStyle>('apa');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt');
  const [exporting, setExporting] = useState(false);
  const [addCitationFileId, setAddCitationFileId] = useState<string | null>(null);

  // Fresh selection each time the dialog opens (or the scope changes).
  useEffect(() => {
    if (open) setChecked(new Set(scopeKey ? scopeKey.split(',') : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeKey]);

  const withCitations = useMemo(() => citatable.filter((f) => checked.has(f.id) && f.citation), [citatable, checked]);
  const missingCheckedCount = citatable.filter((f) => checked.has(f.id) && !f.citation).length;
  const checkedCount = citatable.filter((f) => checked.has(f.id)).length;

  const previewText = useMemo(
    () => renderExport(withCitations.map((f) => f.citation as BookCitation), exportFormat, style),
    [withCitations, exportFormat, style],
  );

  const duplicates = useMemo(() => findDuplicates(citatable), [citatable]);
  const duplicateName = (id: string): string | null => {
    const original = duplicates.of.get(id);
    const file = original ? citatable.find((f) => f.id === original) : null;
    return file ? file.displayName || file.name : null;
  };
  /** Duplicates among the books currently ticked — the ones that would be listed twice. */
  const checkedRepeats = useMemo(
    () => [...duplicates.of.keys()].filter((id) => checked.has(id) && checked.has(duplicates.of.get(id) as string)),
    [duplicates, checked],
  );

  if (!open) return null;

  const statusOf = (file: BookFile): RowStatus => {
    if (working.has(file.id)) return 'working';
    if (errors[file.id] || (lookupFailed[file.id] && !file.citation)) return 'error';
    if (!file.citation) return 'missing';
    if (lookupFailed[file.id]) return 'review';
    return citationReview(file.citation).state === 'review' ? 'review' : 'matched';
  };
  const reasonsOf = (file: BookFile): string[] => {
    const reasons: string[] = [];
    if (errors[file.id]) reasons.push(errors[file.id]);
    if (lookupFailed[file.id]) reasons.push(lookupFailed[file.id]);
    reasons.push(...citationReview(file.citation).reasons);
    return [...new Set(reasons)];
  };
  const statusCounts = citatable.reduce(
    (acc, f) => {
      const st = statusOf(f);
      if (st === 'review' || st === 'error' || st === 'missing') acc[st] += 1;
      return acc;
    },
    { review: 0, error: 0, missing: 0 } as Record<'review' | 'error' | 'missing', number>,
  );
  const visible = citatable.filter((f) => filter === 'all' || statusOf(f) === filter);
  const failedIds = citatable.filter((f) => statusOf(f) === 'error').map((f) => f.id);

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setWorkingOne = (id: string, on: boolean) =>
    setWorking((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const setLookupNote = (id: string, message?: string) =>
    setLookupFailed((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const setErrorOne = (id: string, message?: string) =>
    setErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  /**
   * Read a book's metadata and, when it carries an ISBN, verify it against an
   * online catalogue. Ambiguous (no-ISBN) books keep their embedded metadata —
   * refine those with "Add citation".
   */
  const readOne = async (file: BookFile): Promise<void> => {
    setWorkingOne(file.id, true);
    setErrorOne(file.id);
    setLookupNote(file.id);
    try {
      const seed = file.citation ?? (await extractCitationFromFile(file));
      if (seed.isbn) {
        try {
          const found = await lookupByIsbn(seed.isbn);
          if (found) {
            found.isbn = found.isbn || seed.isbn;
            updateFile(file.id, { citation: found });
            return;
          }
        } catch (error) {
          // offline or blocked — the embedded seed is still worth saving, but say it was not checked
          setLookupNote(file.id, `Online check did not finish: ${errorMessage(error).replace(/\.+$/, '')}`);
        }
      }
      if (!file.citation) updateFile(file.id, { citation: seed });
    } catch (error) {
      setErrorOne(file.id, errorMessage(error));
    } finally {
      setWorkingOne(file.id, false);
    }
  };

  const runBatch = async (targets: BookFile[], verb: string) => {
    if (targets.length === 0) return;
    setBulk({ done: 0, total: targets.length });
    for (let index = 0; index < targets.length; index += 1) {
      await readOne(targets[index]);
      setBulk({ done: index + 1, total: targets.length });
    }
    setBulk(null);
    const good = targets.filter((f) => useBooks.getState().files[f.id]?.citation).length;
    toast.success(`${verb} ${good} of ${targets.length} book${targets.length === 1 ? '' : 's'}`);
  };

  const generateMissing = () => runBatch(citatable.filter((f) => checked.has(f.id) && !f.citation), 'Citations ready for');

  /** Try again the books whose read or online check failed; the ones that worked are left alone. */
  const retryFailed = () =>
    runBatch(
      citatable.filter((f) => failedIds.includes(f.id) || (lookupFailed[f.id] && statusOf(f) !== 'working')),
      'Retried',
    );

  const deselectRepeats = () =>
    setChecked((current) => {
      const next = new Set(current);
      checkedRepeats.forEach((id) => next.delete(id));
      return next;
    });

  const handleCopy = async () => {
    if (!withCitations.length) return;
    // Formatted references are copied as rich text (italics + hanging indent for Word/Docs);
    // BibTeX, RIS and JSON are code, so they stay plain.
    let copied: boolean;
    if (exportFormat === 'txt') {
      const { html, text } = renderBibliographyRich(
        withCitations.map((f) => f.citation as BookCitation),
        style,
      );
      copied = await copyRichText(html, text);
    } else {
      copied = await copyText(previewText);
    }
    if (copied) toast.success(`Copied ${withCitations.length} citation${withCitations.length === 1 ? '' : 's'}`);
    else toast.error('Could not copy to the clipboard');
  };

  const handleExport = async () => {
    if (!withCitations.length) return;
    const meta = EXPORT_FORMATS.find((f) => f.id === exportFormat) ?? EXPORT_FORMATS[0];
    setExporting(true);
    try {
      const bytes = new TextEncoder().encode(previewText);
      const date = new Date().toISOString().slice(0, 10);
      const result = await saveExportedFile(bytes, `citations-${date}.${meta.extension}`, meta);
      if (result.status === 'saved') toast.success('Citations exported', result.path);
      else if (result.status === 'downloaded') toast.success('Citations downloaded');
    } catch (error) {
      toast.error('Could not export citations', error);
    } finally {
      setExporting(false);
    }
  };

  const allChecked = checkedCount === citatable.length && citatable.length > 0;
  const citedIds = citatable.filter((f) => f.citation).map((f) => f.id);

  return (
    <Dialog open={open} onClose={onClose} title="Citations" width={620}>
      <div className="citations-dialog">
        <div className="citations-toolbar">
          <span className="citation-hint">
            {bulk
              ? `Generating… ${bulk.done} of ${bulk.total}`
              : `${checkedCount} of ${citatable.length} selected · ${withCitations.length} with citations${missingCheckedCount ? ` · ${missingCheckedCount} to generate` : ''}`}
          </span>
          {failedIds.length > 0 && bulk === null && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={retryFailed} title="Try again the books whose read or online check failed">
              <RotateCw size={13} />
              Retry failed ({failedIds.length})
            </button>
          )}
          {missingCheckedCount > 0 && (
            <button type="button" className="btn btn-sm btn-primary" onClick={generateMissing} disabled={bulk !== null}>
              {bulk ? <Loader2 size={14} className="btn-spin" /> : <BookMarked size={14} />}
              {bulk ? 'Working…' : 'Generate missing'}
            </button>
          )}
        </div>

        {bulk && (
          <div
            className="citations-progress"
            role="progressbar"
            aria-label="Generating citations"
            aria-valuemin={0}
            aria-valuemax={bulk.total}
            aria-valuenow={bulk.done}
          >
            <div className="citations-progress-bar" style={{ width: `${Math.round((bulk.done / bulk.total) * 100)}%` }} />
          </div>
        )}

        <div className="citations-filters" role="group" aria-label="Show books">
          {(
            [
              ['all', 'All', citatable.length],
              ['review', 'Needs review', statusCounts.review],
              ['error', 'Failed', statusCounts.error],
              ['missing', 'No citation', statusCounts.missing],
            ] as [RowFilter, string, number][]
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={`citations-filter${filter === id ? ' citations-filter-active' : ''}`}
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              disabled={id !== 'all' && count === 0}
            >
              {label} {count > 0 || id === 'all' ? `(${count})` : ''}
            </button>
          ))}
        </div>

        {checkedRepeats.length > 0 && (
          <p className="citations-duplicates" role="alert">
            <AlertTriangle size={13} />
            <span>
              {checkedRepeats.length} selected book{checkedRepeats.length === 1 ? ' repeats' : 's repeat'} another one and would be listed twice.
            </span>
            <button type="button" className="citation-link-btn" onClick={deselectRepeats}>
              Keep one of each
            </button>
          </p>
        )}

        <div className="citations-selectbar">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set(citatable.map((f) => f.id)))} disabled={!citatable.length}>
            All
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setChecked(new Set(citedIds))}
            disabled={!citedIds.length}
            title="Select only books that already have a citation"
          >
            With citations
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set())} disabled={!checkedCount}>
            None
          </button>
        </div>

        <div className="citations-list">
          {citatable.length === 0 && (
            <p className="citation-hint citations-preview-empty">No citatable books in this view — only PDF and ebook files carry citations.</p>
          )}
          {citatable.length > 0 && visible.length === 0 && (
            <p className="citation-hint citations-preview-empty">No books match this filter.</p>
          )}
          {visible.map((file) => {
            const status = statusOf(file);
            const reasons = reasonsOf(file);
            const repeatOf = duplicateName(file.id);
            return (
              <div key={file.id} className="citations-row">
                <div className="citations-row-main">
                  <label className="book-file-checkbox citations-row-check">
                    <input type="checkbox" checked={checked.has(file.id)} onChange={() => toggle(file.id)} />
                  </label>
                  <span className={`citations-status citations-status-${status}`} title={reasons.join(' · ') || STATUS_LABEL[status]}>
                    {status === 'working' && <Loader2 size={13} className="btn-spin" />}
                    {status === 'matched' && <Check size={13} />}
                    {status === 'review' && <Eye size={13} />}
                    {status === 'error' && <AlertTriangle size={13} />}
                    {status === 'missing' && <X size={13} />}
                  </span>
                  <span className="citations-row-name" title={file.filePath}>
                    {file.displayName || file.name}
                  </span>
                  <span className={`citations-status-label citations-status-label-${status}`}>{STATUS_LABEL[status]}</span>
                  <div className="citations-row-actions">
                    {!file.citation && status !== 'working' && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => readOne(file)}>
                        <BookMarked size={13} />
                        Generate
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setAddCitationFileId(file.id)}
                      title="Search online catalogues with title, author, ISBN or a pasted reference"
                    >
                      <BookMarked size={13} />
                      {status === 'review' ? 'Review' : 'Add citation'}
                    </button>
                  </div>
                </div>
                {status === 'review' && reasons.length > 0 && <p className="citations-row-note">{reasons.join(' · ')}</p>}
                {repeatOf && <p className="citations-row-note citations-row-repeat">Same book as “{repeatOf}”</p>}
                {errors[file.id] && <p className="citation-error">{errors[file.id]}</p>}
              </div>
            );
          })}
        </div>

        <div className="citations-output">
          <div className="citations-output-toolbar">
            <select
              className="input input-sm"
              value={style}
              onChange={(e) => setStyle(e.target.value as CitationStyle)}
              disabled={exportFormat !== 'txt'}
              title={exportFormat === 'txt' ? 'Citation style' : 'Styles apply to formatted text output only'}
            >
              {CITATION_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              aria-label="Export format"
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="citations-output-spacer" />
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleCopy} disabled={!withCitations.length}>
              <Copy size={14} />
              Copy
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={handleExport} disabled={exporting || !withCitations.length}>
              {exporting ? <Loader2 size={14} className="btn-spin" /> : <Download size={14} />}
              Export
            </button>
          </div>
          {withCitations.length ? (
            <pre className="citations-preview">{previewText.trimEnd()}</pre>
          ) : (
            <p className="citation-hint citations-preview-empty">
              {citatable.length
                ? 'Nothing selected with a citation — check books above, or use "Generate missing" / "Add citation".'
                : 'No citatable books in this view.'}
            </p>
          )}
        </div>
      </div>

      <AddCitationDialog
        key={addCitationFileId ?? 'none'}
        open={addCitationFileId !== null}
        onClose={() => setAddCitationFileId(null)}
        fileId={addCitationFileId}
      />
    </Dialog>
  );
}
