'use client';

import React, { useState } from 'react';
import { BookMarked, Check, Copy, Globe, Loader2, Pencil, Save, Trash2 } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation } from '@/store/books';
import { CITATION_FIELDS, type CitationField } from '@/lib/citation-schema';
import {
  extractCitationFromFile,
  enrichCitation,
  FIELD_LABELS,
  provenanceSummary,
} from '@/lib/book-citations';
import { CITATION_STYLES, formatCitation, type CitationStyle } from '@/lib/citation-formats';
import { errorMessage } from '@/lib/tauri-commands';
import { cn, copyText } from '@/lib/utils';
import { CitationCandidateList } from './CitationCandidateList';

const SOURCE_LABEL_SHORT: Record<string, string> = {
  openlibrary: 'Open Library',
  'google-books': 'Google Books',
  crossref: 'Crossref',
  file: 'file',
  manual: 'edited',
};

interface Draft {
  title: string;
  authorsText: string;
  publisher: string;
  city: string;
  year: string;
  edition: string;
  isbn: string;
  doi: string;
  language: string;
  pageCountText: string;
  container: string;
  containerShort: string;
  volume: string;
  issue: string;
  pages: string;
}

function draftFrom(citation: BookCitation): Draft {
  return {
    title: citation.title,
    authorsText: citation.authors.join('\n'),
    publisher: citation.publisher ?? '',
    city: citation.city ?? '',
    year: citation.year ?? '',
    edition: citation.edition ?? '',
    isbn: citation.isbn ?? '',
    doi: citation.doi ?? '',
    language: citation.language ?? '',
    pageCountText: citation.pageCount ? String(citation.pageCount) : '',
    container: citation.container ?? '',
    containerShort: citation.containerShort ?? '',
    volume: citation.volume ?? '',
    issue: citation.issue ?? '',
    pages: citation.pages ?? '',
  };
}

function citationFromDraft(draft: Draft): BookCitation {
  const pageCount = Number.parseInt(draft.pageCountText, 10);
  const citation: BookCitation = {
    title: draft.title.trim(),
    authors: draft.authorsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    publisher: draft.publisher.trim() || undefined,
    city: draft.city.trim() || undefined,
    year: draft.year.trim() || undefined,
    edition: draft.edition.trim() || undefined,
    isbn: draft.isbn.trim() || undefined,
    doi: draft.doi.trim() || undefined,
    language: draft.language.trim() || undefined,
    pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : undefined,
    container: draft.container.trim() || undefined,
    containerShort: draft.containerShort.trim() || undefined,
    volume: draft.volume.trim() || undefined,
    issue: draft.issue.trim() || undefined,
    pages: draft.pages.trim() || undefined,
    source: 'manual',
    retrievedAt: new Date().toISOString(),
  };
  // A manual save is the human resolving the record: every field is hand-set,
  // so any prior source disagreements are resolved by definition.
  const fieldSources: BookCitation['fieldSources'] = {};
  for (const field of CITATION_FIELDS) {
    const value = citation[field];
    if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      fieldSources[field] = 'manual';
    }
  }
  citation.fieldSources = Object.keys(fieldSources).length > 0 ? fieldSources : undefined;
  return citation;
}

/** Form field with provenance hint and conflict highlighting. */
function Field({
  label,
  field,
  citation,
  conflicted,
  wide,
  children,
}: {
  label: string;
  field: CitationField;
  citation: BookCitation | null;
  conflicted: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const source = citation?.fieldSources?.[field];
  return (
    <label className={cn('citation-field', wide && 'citation-field-wide', conflicted && 'citation-field-conflict')}>
      <span>
        {label}
        {source ? ` · ${SOURCE_LABEL_SHORT[source] ?? source}` : ''}
      </span>
      {children}
      {conflicted && <span className="citation-conflict-note">Sources disagree — pick the right value</span>}
    </label>
  );
}

/** Citation panel for one book: generate from file + online, edit by hand, copy. */
export function BookCitationSection({ fileId }: { fileId: string }) {
  const { files, updateFile } = useBooks();
  const file = files[fileId];

  const [style, setStyle] = useState<CitationStyle>('apa');
  const [busy, setBusy] = useState<'extract' | 'lookup' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<BookCitation[] | null>(null);
  const [seed, setSeed] = useState<BookCitation | null>(null);

  if (!file) return null;
  const citation = file.citation ?? null;
  const provenance = provenanceSummary(citation);

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const save = (next: BookCitation | null) => updateFile(fileId, { citation: next });

  /** A fetched or generated citation also renames the book to its title —
   * unless the user already set a display name (only Rename changes that). */
  const saveWithRename = (next: BookCitation) => {
    updateFile(fileId, {
      citation: next,
      ...(file.displayName || !next.title.trim() ? {} : { displayName: next.title.trim() }),
    });
  };

  const handleCopy = async () => {
    if (!citation) return;
    if (await copyText(formatCitation(style, citation))) toast.success('Citation copied');
    else toast.error('Could not copy to the clipboard');
  };

  /** Extract from the file (when needed), then query every catalogue; the merged record goes through the pick list. */
  const handleGenerate = async () => {
    setError(null);
    setPicking(null);
    try {
      let base = citation;
      if (!base) {
        setBusy('extract');
        base = await extractCitationFromFile(file);
      }
      setBusy('lookup');
      const result = await enrichCitation(base);
      if (result.applied && result.citation) {
        saveWithRename(result.citation);
        toast.success('Citation saved from an online catalogue');
      } else if (result.candidates.length > 0) {
        setSeed(base);
        setPicking(result.candidates);
      } else if (!citation) {
        save(base);
        toast.info('No online match found — saved what the file itself provides. You can edit it.');
      } else {
        toast.info('No online match found — the saved citation was left unchanged.');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleStartEdit = () => {
    setDraft(draftFrom(citation ?? { title: file.name.replace(/\.[^.]+$/, ''), authors: [], source: 'embedded', retrievedAt: '' }));
    setEditing(true);
    setPicking(null);
  };

  const handleSaveEdit = () => {
    if (!draft) return;
    const next = citationFromDraft(draft);
    if (!next.title) {
      toast.error('A citation needs at least a title');
      return;
    }
    save(next);
    setEditing(false);
    setDraft(null);
  };

  const conflictedFields = new Set<CitationField>(editing && citation ? (citation.conflicts ?? []) : []);

  return (
    <div className="file-details-section">
      <div className="file-details-label">
        <BookMarked size={12} />
        Citation
      </div>

      {editing && draft ? (
        <div className="citation-form">
          <Field label="Title" field="title" citation={citation} conflicted={conflictedFields.has('title')} wide>
            <input className="input input-sm" value={draft.title} onChange={(e) => setField('title', e.target.value)} dir="auto" />
          </Field>
          <Field label="Authors (one per line)" field="authors" citation={citation} conflicted={conflictedFields.has('authors')} wide>
            <textarea
              className="textarea citation-authors-input"
              rows={3}
              value={draft.authorsText}
              onChange={(e) => setField('authorsText', e.target.value)}
              placeholder={'Tolstoy, Leo'}
              dir="auto"
            />
          </Field>
          <Field label="Publisher" field="publisher" citation={citation} conflicted={conflictedFields.has('publisher')}>
            <input className="input input-sm" value={draft.publisher} onChange={(e) => setField('publisher', e.target.value)} dir="auto" />
          </Field>
          <Field label="Year" field="year" citation={citation} conflicted={conflictedFields.has('year')}>
            <input className="input input-sm" value={draft.year} onChange={(e) => setField('year', e.target.value)} dir="auto" />
          </Field>
          <Field label="Place" field="city" citation={citation} conflicted={conflictedFields.has('city')}>
            <input className="input input-sm" value={draft.city} onChange={(e) => setField('city', e.target.value)} dir="auto" />
          </Field>
          <Field label="Edition" field="edition" citation={citation} conflicted={conflictedFields.has('edition')}>
            <input className="input input-sm" value={draft.edition} onChange={(e) => setField('edition', e.target.value)} dir="auto" />
          </Field>
          <Field label="ISBN" field="isbn" citation={citation} conflicted={conflictedFields.has('isbn')}>
            <input className="input input-sm" value={draft.isbn} onChange={(e) => setField('isbn', e.target.value)} dir="auto" />
          </Field>
          <Field label="DOI" field="doi" citation={citation} conflicted={conflictedFields.has('doi')}>
            <input className="input input-sm" value={draft.doi} onChange={(e) => setField('doi', e.target.value)} dir="auto" />
          </Field>
          <Field label="Language" field="language" citation={citation} conflicted={conflictedFields.has('language')}>
            <input className="input input-sm" value={draft.language} onChange={(e) => setField('language', e.target.value)} dir="auto" />
          </Field>
          <Field label="Pages (file)" field="pageCount" citation={citation} conflicted={conflictedFields.has('pageCount')}>
            <input
              className="input input-sm"
              type="number"
              min={1}
              value={draft.pageCountText}
              onChange={(e) => setField('pageCountText', e.target.value)}
            />
          </Field>
          <Field label="Journal / venue" field="container" citation={citation} conflicted={conflictedFields.has('container')} wide>
            <input className="input input-sm" value={draft.container} onChange={(e) => setField('container', e.target.value)} dir="auto" />
          </Field>
          <Field label="Volume" field="volume" citation={citation} conflicted={conflictedFields.has('volume')}>
            <input className="input input-sm" value={draft.volume} onChange={(e) => setField('volume', e.target.value)} dir="auto" />
          </Field>
          <Field label="Issue" field="issue" citation={citation} conflicted={conflictedFields.has('issue')}>
            <input className="input input-sm" value={draft.issue} onChange={(e) => setField('issue', e.target.value)} dir="auto" />
          </Field>
          <Field label="Pages" field="pages" citation={citation} conflicted={conflictedFields.has('pages')}>
            <input className="input input-sm" value={draft.pages} onChange={(e) => setField('pages', e.target.value)} dir="auto" />
          </Field>
          <div className="citation-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveEdit}>
              <Save size={14} />
              Save citation
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : picking ? (
        <div className="citation-pick">
          <p className="citation-hint">Several records matched “{seed?.title || file.name}”. Pick the right one:</p>
          <CitationCandidateList
            candidates={picking}
            onPick={(candidate) => {
              saveWithRename(candidate);
              setPicking(null);
              toast.success('Citation saved');
            }}
          />
          <div className="citation-actions">
            {seed && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  saveWithRename(seed);
                  setPicking(null);
                  toast.success('Saved what the file itself provides');
                }}
              >
                None of these — use file metadata
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : citation ? (
        <>
          <div className="citation-preview">{formatCitation(style, citation)}</div>
          {provenance && <p className="citation-provenance">{provenance}</p>}
          <div className="citation-toolbar">
            <select
              className="input input-sm citation-style-select"
              value={style}
              onChange={(e) => setStyle(e.target.value as CitationStyle)}
              aria-label="Citation style"
            >
              {CITATION_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className={`citation-badge citation-badge-${citation.source}`}>
              {citation.source === 'enriched' ? <Check size={11} /> : null}
              {citation.source === 'embedded' ? 'From file' : citation.source === 'enriched' ? 'Verified online' : 'Manual'}
            </span>
            {(citation.conflicts ?? []).length > 0 && (
              <span className="citation-source-chip citation-conflict-chip" title="Sources disagreed on these fields — edit to resolve">
                {(citation.conflicts ?? []).map((field) => FIELD_LABELS[field]).join(', ')}?
              </span>
            )}
          </div>
          <div className="citation-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleCopy}>
              <Copy size={14} />
              Copy
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleStartEdit}>
              <Pencil size={13} />
              Edit
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={handleGenerate} disabled={busy !== null}>
              {busy === 'lookup' ? <Loader2 size={14} className="btn-spin" /> : <Globe size={14} />}
              {busy === 'lookup' ? 'Looking up…' : 'Look up online'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger-text"
              onClick={() => save(null)}
              title="Remove the saved citation"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </>
      ) : (
        <div className="citation-empty">
          <p className="citation-hint">Read the book's metadata, check it against every online catalogue, or enter it by hand.</p>
          <div className="citation-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={handleGenerate} disabled={busy !== null}>
              {busy === 'extract' || busy === 'lookup' ? <Loader2 size={14} className="btn-spin" /> : <BookMarked size={14} />}
              {busy === 'extract' ? 'Reading file…' : busy === 'lookup' ? 'Looking up…' : 'Generate citation'}
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={handleStartEdit}>
              Enter manually
            </button>
          </div>
        </div>
      )}

      {error && <p className="citation-error">{error}</p>}
    </div>
  );
}
