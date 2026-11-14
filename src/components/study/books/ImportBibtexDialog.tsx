'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BookMarked, FileWarning, Loader2 } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { CitationStylePicker } from '@/components/study/books/CitationPickers';
import { parseBibtex, type ParseResult } from '@/lib/bibtex';
import {
  matchEntries,
  type MatchFile,
  type MatchSuggestion,
} from '@/lib/bibtex-import';
import { formatCitation, type CitationStyle } from '@/lib/citation-formats';
import type { BookCitation } from '@/store/books';
import { useBooks, type BookFile } from '@/store/books';
import { readExternalFileBytes, errorMessage } from '@/lib/tauri-commands';
import { toast } from '@/store/toast';
import { cn } from '@/lib/utils';

type RowChoice = { kind: 'file'; fileId: string } | { kind: 'manual' } | { kind: 'skip' };

interface RowState {
  suggestion: MatchSuggestion;
  choice: RowChoice;
  /** Only asked when the chosen file already carries a citation. */
  replace: boolean;
}

const CONFIDENCE_BADGE: Record<MatchSuggestion['confidence'], { label: string; tone: string }> = {
  auto: { label: 'Matched', tone: 'tone-green' },
  suggested: { label: 'Check', tone: 'tone-amber' },
  none: { label: 'No file', tone: 'tone-slate' },
};

function fileLabel(file: BookFile): string {
  return file.displayName || file.name;
}

/** Why a candidate was proposed — shown after the file name in the picker. */
function candidateHint(candidate: MatchSuggestion['candidates'][number]): string {
  if (candidate.reason === 'doi') return ' (DOI match)';
  if (candidate.yearConflict) return ' (year differs)';
  if (candidate.score >= 0.9) return '';
  return ' (similar)';
}

export default function ImportBibtexDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const files = useBooks((state) => state.files);
  const bibliographies = useBooks((state) => state.bibliographies);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [style, setStyle] = useState<CitationStyle>('apa');
  const [bibliographyChoice, setBibliographyChoice] = useState('');
  const [newBibliographyName, setNewBibliographyName] = useState(`Zotero import ${new Date().toLocaleDateString('en-GB')}`);
  const [addKeywords, setAddKeywords] = useState(true);
  const [applying, setApplying] = useState(false);
  const fileName = path.split(/[\\/]/).pop() ?? path;

  const matchFiles = useMemo<MatchFile[]>(
    () =>
      Object.values(files).map((file) => ({
        id: file.id,
        name: file.name,
        displayName: file.displayName,
        doi: file.citation?.doi ?? null,
        year: file.citation?.year ?? null,
        hasCitation: Boolean(file.citation),
      })),
    [files],
  );

  // Parse and match as soon as the dialog opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // External read: the .bib lives wherever the user keeps it, not in the workspace.
        const bytes = await readExternalFileBytes(path);
        if (cancelled) return;
        const text = new TextDecoder('utf-8').decode(bytes);
        const result = parseBibtex(text);
        const suggestions = matchEntries(result.entries, matchFiles);
        setLoadError(null);
        setParse(result);
        setRows(
          suggestions.map((suggestion): RowState => {
            const choice: RowChoice =
              suggestion.confidence === 'none'
                ? { kind: 'manual' }
                : suggestion.candidates.length > 0
                  ? { kind: 'file', fileId: suggestion.candidates[0].fileId }
                  : { kind: 'manual' };
            return { suggestion, choice, replace: false };
          }),
        );
        if (result.entries.length === 0) toast.warning('No entries found', 'This file does not contain any BibTeX entries.');
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const setChoice = (index: number, choice: RowChoice) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, choice, replace: false } : row)));
  };

  const setReplace = (index: number, replace: boolean) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, replace } : row)));
  };

  const stats = useMemo(() => {
    const fileCount = rows.filter((row) => row.choice.kind === 'file').length;
    const manualCount = rows.filter((row) => row.choice.kind === 'manual').length;
    const skipped = rows.filter((row) => row.choice.kind === 'skip').length;
    return { fileCount, manualCount, skipped };
  }, [rows]);

  /** Bibliography-only entries have nowhere to go without a target list. */
  const manualNeedsTarget = stats.manualCount > 0 && bibliographyChoice === '';

  const apply = async () => {
    setApplying(true);
    try {
      const books = useBooks.getState();
      let applied = 0;
      let kept = 0;
      const bibliographyRows: Array<{ fileId?: string; manual?: BookCitation }> = [];
      for (const row of rows) {
        if (row.choice.kind === 'skip') continue;
        const { suggestion } = row;
        if (row.choice.kind === 'file') {
          const file = files[row.choice.fileId];
          if (!file) continue;
          if (file.citation && !row.replace) {
            kept += 1;
            bibliographyRows.push({ fileId: file.id });
            continue;
          }
          const tags =
            addKeywords && suggestion.keywords.length > 0 ? [...new Set([...file.tags, ...suggestion.keywords])] : undefined;
          books.updateFile(file.id, { citation: suggestion.citation, ...(tags ? { tags } : {}) });
          applied += 1;
          bibliographyRows.push({ fileId: file.id });
        } else {
          bibliographyRows.push({ manual: suggestion.citation });
        }
      }

      let bibliographyId: string | null = null;
      if (bibliographyChoice === 'new') {
        bibliographyId = books.createBibliography(newBibliographyName.trim() || 'Zotero import', style);
      } else if (bibliographyChoice) {
        bibliographyId = bibliographyChoice;
      }
      if (bibliographyId && bibliographyRows.length > 0) {
        books.addBibliographyEntries(bibliographyId, bibliographyRows);
      }

      const parts = [`${applied} citation${applied === 1 ? '' : 's'} applied`];
      if (kept > 0) parts.push(`${kept} existing kept`);
      if (bibliographyId) parts.push('bibliography updated');
      toast.success('BibTeX imported', parts.join(' · '));
      onClose();
    } catch (error) {
      toast.error('Import failed', error);
    } finally {
      setApplying(false);
    }
  };

  if (loadError) {
    return (
      <Dialog open onClose={onClose} title="Import BibTeX" width={560}>
        <div className="bibtex-error">
          <FileWarning size={16} />
          <div>
            <p className="bibtex-error-title">Could not read {fileName}</p>
            <p className="bibtex-error-detail">{loadError}</p>
          </div>
        </div>
        <div className="bibtex-footer">
          <span className="bibtex-footer-summary" />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }

  if (!parse) {
    return (
      <Dialog open onClose={onClose} title="Import BibTeX" width={560}>
        <div className="bibtex-loading">
          <Loader2 size={18} className="spin" /> Reading {fileName}…
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Import BibTeX" width={720}>
      <div className="bibtex">
        <div className="bibtex-summary">
          <BookMarked size={14} />
          {parse.entries.length} entr{parse.entries.length === 1 ? 'y' : 'ies'} from {fileName}
          {parse.duplicates > 0 && <span className="bibtex-summary-note">{parse.duplicates} duplicate{parse.duplicates === 1 ? '' : 's'} skipped</span>}
          {parse.malformed > 0 && (
            <span className="bibtex-summary-note bibtex-summary-warn">
              <FileWarning size={11} /> {parse.malformed} unparseable
            </span>
          )}
        </div>

        <div className="bibtex-rows">
          {rows.length === 0 && (
            <p className="bibtex-empty">
              Nothing to import — this file has no usable BibTeX entries.
            </p>
          )}
          {rows.map((row, index) => {
            const badge = CONFIDENCE_BADGE[row.suggestion.confidence];
            const chosenFile = row.choice.kind === 'file' ? files[row.choice.fileId] : null;
            return (
              <div key={row.suggestion.entry.key + index} className="bibtex-row">
                <div className="bibtex-row-citation">
                  <span className={cn('badge', badge.tone)}>{badge.label}</span>
                  <span className="bibtex-row-text">{formatCitation(style, row.suggestion.citation)}</span>
                </div>
                <div className="bibtex-row-controls">
                  <select
                    className="select select-sm"
                    value={row.choice.kind === 'file' ? row.choice.fileId : row.choice.kind}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'manual' || value === 'skip') setChoice(index, { kind: value });
                      else setChoice(index, { kind: 'file', fileId: value });
                    }}
                    aria-label="Match to file"
                  >
                    <option value="manual">No file — bibliography only</option>
                    {row.suggestion.candidates.map((candidate) => (
                      <option key={candidate.fileId} value={candidate.fileId}>
                        {files[candidate.fileId] ? fileLabel(files[candidate.fileId]) : candidate.fileId}
                        {candidateHint(candidate)}
                      </option>
                    ))}
                    <optgroup label="Other files">
                      {Object.values(files)
                        .filter((file) => !row.suggestion.candidates.some((candidate) => candidate.fileId === file.id))
                        .map((file) => (
                          <option key={file.id} value={file.id}>
                            {fileLabel(file)}
                          </option>
                        ))}
                    </optgroup>
                    <option value="skip">Skip this entry</option>
                  </select>
                  {chosenFile?.citation && (
                    <label className="bibtex-replace">
                      <input type="checkbox" checked={row.replace} onChange={(event) => setReplace(index, event.target.checked)} />
                      Replace existing citation
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="bibtex-target">
          <label className="bibtex-target-label">Bibliography</label>
          <select className="select select-sm" value={bibliographyChoice} onChange={(event) => setBibliographyChoice(event.target.value)}>
            <option value="">None — only update files</option>
            {Object.values(bibliographies).map((bibliography) => (
              <option key={bibliography.id} value={bibliography.id}>
                {bibliography.title}
              </option>
            ))}
            <option value="new">New bibliography…</option>
          </select>
          {bibliographyChoice === 'new' && (
            <input className="input input-sm" value={newBibliographyName} onChange={(event) => setNewBibliographyName(event.target.value)} placeholder="Name" dir="auto" />
          )}
          <CitationStylePicker value={style} onChange={setStyle} />
        </div>

        <label className="bibtex-keywords">
          <input type="checkbox" checked={addKeywords} onChange={(event) => setAddKeywords(event.target.checked)} />
          Add Zotero keywords as tags to matched files
        </label>

        <div className="bibtex-footer">
          <span className="bibtex-footer-summary">
            {stats.fileCount} file{stats.fileCount === 1 ? '' : 's'} cited · {stats.manualCount} bibliography-only · {stats.skipped} skipped
          </span>
          {manualNeedsTarget && (
            <span className="bibtex-footer-warn">Choose a bibliography to keep the unmatched entries</span>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={applying || rows.length === 0 || manualNeedsTarget}
            onClick={() => void apply()}
          >
            {applying ? <Loader2 size={14} className="btn-spin" /> : <BookMarked size={14} />} Apply
          </button>
        </div>
      </div>
    </Dialog>
  );
}
