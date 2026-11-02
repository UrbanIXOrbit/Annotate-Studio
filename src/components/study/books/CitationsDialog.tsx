'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookMarked, Check, Copy, Download, Loader2, X } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation, type BookFile } from '@/store/books';
import { extractCitationFromFile, isCitationCapable, lookupByIsbn } from '@/lib/book-citations';
import { CITATION_STYLES, EXPORT_FORMATS, renderExport, type CitationStyle, type ExportFormat } from '@/lib/citation-formats';
import { saveExportedFile } from '@/lib/export-file';
import { errorMessage } from '@/lib/tauri-commands';
import { copyText } from '@/lib/utils';
import Dialog from '@/components/ui/Dialog';
import { AddCitationDialog } from './AddCitationDialog';

interface CitationsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Files in scope, fixed when the dialog was opened. Filtered down to citatable books here. */
  fileIds: string[];
}

type RowStatus = 'missing' | 'working' | 'saved' | 'error';

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

  if (!open) return null;

  const statusOf = (file: BookFile): RowStatus => {
    if (working.has(file.id)) return 'working';
    if (errors[file.id]) return 'error';
    if (file.citation) return 'saved';
    return 'missing';
  };

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
        } catch {
          // offline or blocked — the embedded seed is still worth saving
        }
      }
      if (!file.citation) updateFile(file.id, { citation: seed });
    } catch (error) {
      setErrorOne(file.id, errorMessage(error));
    } finally {
      setWorkingOne(file.id, false);
    }
  };

  const generateMissing = async () => {
    const targets = citatable.filter((f) => checked.has(f.id) && !f.citation);
    if (targets.length === 0) return;
    setBulk({ done: 0, total: targets.length });
    for (let index = 0; index < targets.length; index += 1) {
      await readOne(targets[index]);
      setBulk({ done: index + 1, total: targets.length });
    }
    setBulk(null);
    const good = targets.filter((f) => useBooks.getState().files[f.id]?.citation).length;
    toast.success(`Citations ready for ${good} of ${targets.length} book${targets.length === 1 ? '' : 's'}`);
  };

  const handleCopy = async () => {
    if (!withCitations.length) return;
    if (await copyText(previewText)) toast.success(`Copied ${withCitations.length} citation${withCitations.length === 1 ? '' : 's'}`);
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
          {missingCheckedCount > 0 && (
            <button type="button" className="btn btn-sm btn-primary" onClick={generateMissing} disabled={bulk !== null}>
              {bulk ? <Loader2 size={14} className="btn-spin" /> : <BookMarked size={14} />}
              {bulk ? 'Working…' : 'Generate missing'}
            </button>
          )}
        </div>

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
          {citatable.map((file) => {
            const status = statusOf(file);
            return (
              <div key={file.id} className="citations-row">
                <div className="citations-row-main">
                  <label className="book-file-checkbox citations-row-check">
                    <input type="checkbox" checked={checked.has(file.id)} onChange={() => toggle(file.id)} />
                  </label>
                  <span className={`citations-status citations-status-${status}`}>
                    {status === 'working' && <Loader2 size={13} className="btn-spin" />}
                    {status === 'saved' && <Check size={13} />}
                    {status === 'error' && <AlertTriangle size={13} />}
                    {status === 'missing' && <X size={13} />}
                  </span>
                  <span className="citations-row-name" title={file.filePath}>
                    {file.displayName || file.name}
                  </span>
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
                      Add citation
                    </button>
                  </div>
                </div>
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
