'use client';

import React, { useState } from 'react';
import { AlertTriangle, BookMarked, Check, Copy, Globe, Loader2, Pencil, Save, Trash2 } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation, type CitationWorkType } from '@/store/books';
import { CITATION_FIELDS, type CitationField } from '@/lib/citation-schema';
import {
  citationGaps,
  extractCitationFromFile,
  enrichCitation,
  FIELD_LABELS,
  findDuplicateOf,
  provenanceSummary,
  sourceDisplayName,
  validateCitationField,
} from '@/lib/book-citations';
import { CITATION_STYLES, formatCitation, renderBibliographyRich, type CitationStyle } from '@/lib/citation-formats';
import { errorMessage } from '@/lib/tauri-commands';
import { cn, copyRichText } from '@/lib/utils';
import { AuthorsEditor } from './AuthorsEditor';
import { CitationCandidateList } from './CitationCandidateList';

const SOURCE_LABEL_SHORT: Record<string, string> = {
  file: 'file',
  manual: 'edited',
};

interface Draft {
  type: CitationWorkType;
  title: string;
  authors: string[];
  editors: string[];
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

type DraftField = 'publisher' | 'city' | 'edition' | 'isbn' | 'doi' | 'language' | 'pageCountText' | 'container' | 'containerShort' | 'volume' | 'issue' | 'pages' | 'editors';

/** Which fields matter for each kind of work; the rest sit behind "More fields". */
const TYPE_FIELDS: Record<CitationWorkType, DraftField[]> = {
  book: ['publisher', 'city', 'edition', 'isbn', 'doi'],
  thesis: ['publisher', 'city', 'doi'],
  article: ['container', 'volume', 'issue', 'pages', 'doi'],
  conference: ['container', 'pages', 'publisher', 'city', 'doi'],
  chapter: ['container', 'editors', 'pages', 'publisher', 'city', 'edition', 'isbn', 'doi'],
  preprint: ['container', 'doi'],
  other: ['publisher', 'city', 'edition', 'isbn', 'doi', 'container', 'volume', 'issue', 'pages'],
};

const WORK_TYPES: { id: CitationWorkType; label: string }[] = [
  { id: 'book', label: 'Book' },
  { id: 'article', label: 'Journal article' },
  { id: 'chapter', label: 'Book chapter' },
  { id: 'conference', label: 'Conference paper' },
  { id: 'preprint', label: 'Preprint' },
  { id: 'thesis', label: 'Thesis' },
  { id: 'other', label: 'Other' },
];

const CONTAINER_LABEL: Partial<Record<CitationWorkType, string>> = {
  article: 'Journal',
  chapter: 'Book title',
  conference: 'Proceedings',
  preprint: 'Server (e.g. arXiv)',
};

const CONFIDENCE_TEXT = { high: 'Cross-checked', medium: 'Partly cross-checked', low: 'Not cross-checked' } as const;
const CONFIDENCE_TITLE = {
  high: 'Three or more independent sources agree on this record',
  medium: 'Two independent sources agree on this record',
  low: 'Only one independent source — worth checking against the original',
} as const;

function draftFrom(citation: BookCitation): Draft {
  return {
    type: citation.type ?? (citation.container ? 'article' : 'book'),
    title: citation.title,
    authors: [...citation.authors],
    editors: [...(citation.editors ?? [])],
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

function citationFromDraft(draft: Draft, original: BookCitation | null): BookCitation {
  const pageCount = Number.parseInt(draft.pageCountText, 10);
  const names = (list: string[]) => list.map((line) => line.trim()).filter(Boolean);
  const editors = names(draft.editors);
  const citation: BookCitation = {
    title: draft.title.trim(),
    authors: names(draft.authors),
    publisher: draft.publisher.trim() || undefined,
    city: draft.city.trim() || undefined,
    year: draft.year.trim() || undefined,
    edition: draft.edition.trim() || undefined,
    isbn: draft.isbn.trim() || undefined,
    doi: draft.doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') || undefined,
    language: draft.language.trim() || undefined,
    pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : undefined,
    // The work type chosen in the form: it decides how the reference is laid out.
    type: draft.type,
    container: draft.container.trim() || undefined,
    containerShort: draft.containerShort.trim() || undefined,
    volume: draft.volume.trim() || undefined,
    issue: draft.issue.trim() || undefined,
    pages: draft.pages.trim() || undefined,
    editors: editors.length ? editors : undefined,
    // Facts the form does not edit are kept rather than silently dropped.
    url: original?.url,
    retracted: original?.retracted,
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
        {source ? ` · ${SOURCE_LABEL_SHORT[source] ?? sourceDisplayName(source)}` : ''}
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
  const [showAll, setShowAll] = useState(false);
  const [fetching, setFetching] = useState<'isbn' | 'doi' | null>(null);

  if (!file) return null;
  const citation = file.citation ?? null;
  const provenance = provenanceSummary(citation);
  const styleLabel = CITATION_STYLES.find((entry) => entry.id === style)?.label ?? style;
  const gaps = citation ? citationGaps(citation, style) : [];
  const duplicateName = (c: BookCitation): string | null => {
    const other = findDuplicateOf(files, c, fileId);
    return other ? other.displayName || other.name : null;
  };
  const savedDuplicate = citation ? duplicateName(citation) : null;

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
    // Rich copy: pasting into Word or Docs keeps the italics and the hanging indent.
    const { html, text } = renderBibliographyRich([citation], style);
    if (await copyRichText(html, text)) toast.success('Citation copied');
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
      } else {
        // Say why when the engine knows (every source unreachable, check-digit typo…).
        const why = (result.error ?? 'No online match found').replace(/\.+$/, '');
        if (!citation) {
          save(base);
          toast.info(`${why} — saved what the file itself provides. You can edit it.`);
        } else {
          toast.info(`${why} — the saved citation was left unchanged.`);
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const handleStartEdit = () => {
    setDraft(draftFrom(citation ?? { title: file.name.replace(/\.[^.]+$/, ''), authors: [], source: 'embedded', retrievedAt: '' }));
    setShowAll(false);
    setEditing(true);
    setPicking(null);
  };

  /** Fill the form from the catalogues using the ISBN or DOI typed in it; nothing is saved until "Save citation". */
  const handleFetch = async (kind: 'isbn' | 'doi') => {
    if (!draft) return;
    const value = (kind === 'isbn' ? draft.isbn : draft.doi).trim();
    if (!value) return;
    setFetching(kind);
    try {
      const identifier: Partial<BookCitation> = kind === 'isbn' ? { isbn: value } : { doi: value };
      const result = await enrichCitation({ title: '', authors: [], source: 'embedded', retrievedAt: '', ...identifier });
      const found = result.citation ?? result.candidates[0] ?? null;
      if (!found) {
        toast.error((result.error ?? 'No catalogue has a record for that identifier').replace(/\.+$/, ''));
        return;
      }
      // Keep what only the file knows (language, page count); everything else comes from the record.
      setDraft((current) => ({
        ...draftFrom({ ...found, [kind]: found[kind] || value }),
        language: current?.language ?? '',
        pageCountText: current?.pageCountText ?? '',
      }));
      toast.success('Filled from the online catalogues — check the fields, then save');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setFetching(null);
    }
  };

  const handleSaveEdit = () => {
    if (!draft) return;
    const next = citationFromDraft(draft, citation);
    if (!next.title) {
      toast.error('A citation needs at least a title');
      return;
    }
    save(next);
    setEditing(false);
    setDraft(null);
  };

  const conflictedFields = new Set<CitationField>(editing && citation ? (citation.conflicts ?? []) : []);

  // Which form fields apply to this kind of work (a field that already holds a value is never hidden).
  const hasValue = (field: DraftField) =>
    !!draft && (field === 'editors' ? draft.editors.length > 0 : String((draft as unknown as Record<string, string>)[field] ?? '').trim() !== '');
  const show = (field: DraftField) => !!draft && (showAll || TYPE_FIELDS[draft.type].includes(field) || hasValue(field));
  const ALL_DRAFT_FIELDS: DraftField[] = ['publisher', 'city', 'edition', 'isbn', 'doi', 'language', 'pageCountText', 'container', 'containerShort', 'volume', 'issue', 'pages', 'editors'];
  const hiddenCount = draft ? ALL_DRAFT_FIELDS.filter((f) => !TYPE_FIELDS[draft.type].includes(f) && !hasValue(f)).length : 0;
  const isbnProblem = draft ? validateCitationField('isbn', draft.isbn) : null;
  const doiProblem = draft ? validateCitationField('doi', draft.doi) : null;
  const yearProblem = draft ? validateCitationField('year', draft.year) : null;

  return (
    <div className="file-details-section">
      <div className="file-details-label">
        <BookMarked size={12} />
        Citation
      </div>

      {editing && draft ? (
        <div className="citation-form">
          <label className="citation-field citation-field-wide">
            <span>Type of work</span>
            <select className="input input-sm" value={draft.type} onChange={(e) => setField('type', e.target.value as CitationWorkType)}>
              {WORK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <Field label="Title" field="title" citation={citation} conflicted={conflictedFields.has('title')} wide>
            <input className="input input-sm" value={draft.title} onChange={(e) => setField('title', e.target.value)} dir="auto" />
          </Field>
          <div className="citation-field citation-field-wide">
            <span>Authors</span>
            <AuthorsEditor label="Author" value={draft.authors} onChange={(next) => setField('authors', next)} />
          </div>
          {show('editors') && (
            <div className="citation-field citation-field-wide">
              <span>Editors</span>
              <AuthorsEditor label="Editor" addLabel="Add editor" value={draft.editors} onChange={(next) => setField('editors', next)} />
            </div>
          )}
          <Field label="Year" field="year" citation={citation} conflicted={conflictedFields.has('year')}>
            <input className="input input-sm" value={draft.year} onChange={(e) => setField('year', e.target.value)} dir="auto" inputMode="numeric" />
            {yearProblem && <span className="citation-field-problem" role="alert">{yearProblem}</span>}
          </Field>
          {show('container') && (
            <Field label={CONTAINER_LABEL[draft.type] ?? 'Journal / venue'} field="container" citation={citation} conflicted={conflictedFields.has('container')} wide>
              <input className="input input-sm" value={draft.container} onChange={(e) => setField('container', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('volume') && (
            <Field label="Volume" field="volume" citation={citation} conflicted={conflictedFields.has('volume')}>
              <input className="input input-sm" value={draft.volume} onChange={(e) => setField('volume', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('issue') && (
            <Field label="Issue" field="issue" citation={citation} conflicted={conflictedFields.has('issue')}>
              <input className="input input-sm" value={draft.issue} onChange={(e) => setField('issue', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('pages') && (
            <Field label="Pages" field="pages" citation={citation} conflicted={conflictedFields.has('pages')}>
              <input className="input input-sm" value={draft.pages} onChange={(e) => setField('pages', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('publisher') && (
            <Field label="Publisher" field="publisher" citation={citation} conflicted={conflictedFields.has('publisher')}>
              <input className="input input-sm" value={draft.publisher} onChange={(e) => setField('publisher', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('city') && (
            <Field label="Place" field="city" citation={citation} conflicted={conflictedFields.has('city')}>
              <input className="input input-sm" value={draft.city} onChange={(e) => setField('city', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('edition') && (
            <Field label="Edition" field="edition" citation={citation} conflicted={conflictedFields.has('edition')}>
              <input className="input input-sm" value={draft.edition} onChange={(e) => setField('edition', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('isbn') && (
            <Field label="ISBN" field="isbn" citation={citation} conflicted={conflictedFields.has('isbn')}>
              <span className="citation-input-action">
                <input className="input input-sm" value={draft.isbn} onChange={(e) => setField('isbn', e.target.value)} dir="auto" />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleFetch('isbn')}
                  disabled={!draft.isbn.trim() || !!isbnProblem || fetching !== null}
                  title="Fill the fields from the online catalogues"
                >
                  {fetching === 'isbn' ? <Loader2 size={13} className="btn-spin" /> : <Globe size={13} />}
                  Fetch
                </button>
              </span>
              {isbnProblem && <span className="citation-field-problem" role="alert">{isbnProblem}</span>}
            </Field>
          )}
          {show('doi') && (
            <Field label="DOI" field="doi" citation={citation} conflicted={conflictedFields.has('doi')}>
              <span className="citation-input-action">
                <input className="input input-sm" value={draft.doi} onChange={(e) => setField('doi', e.target.value)} dir="auto" />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleFetch('doi')}
                  disabled={!draft.doi.trim() || !!doiProblem || fetching !== null}
                  title="Fill the fields from the online catalogues"
                >
                  {fetching === 'doi' ? <Loader2 size={13} className="btn-spin" /> : <Globe size={13} />}
                  Fetch
                </button>
              </span>
              {doiProblem && <span className="citation-field-problem" role="alert">{doiProblem}</span>}
            </Field>
          )}
          {show('containerShort') && (
            <label className="citation-field">
              <span>Journal abbreviation</span>
              <input className="input input-sm" value={draft.containerShort} onChange={(e) => setField('containerShort', e.target.value)} dir="auto" />
            </label>
          )}
          {show('language') && (
            <Field label="Language" field="language" citation={citation} conflicted={conflictedFields.has('language')}>
              <input className="input input-sm" value={draft.language} onChange={(e) => setField('language', e.target.value)} dir="auto" />
            </Field>
          )}
          {show('pageCountText') && (
            <Field label="Pages (file)" field="pageCount" citation={citation} conflicted={conflictedFields.has('pageCount')}>
              <input className="input input-sm" type="number" min={1} value={draft.pageCountText} onChange={(e) => setField('pageCountText', e.target.value)} />
            </Field>
          )}
          {(showAll || hiddenCount > 0) && (
            <button type="button" className="btn btn-sm btn-ghost citation-more-fields" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Fewer fields' : `More fields (${hiddenCount})`}
            </button>
          )}
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
            style={style}
            current={citation}
            duplicateOf={duplicateName}
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
          {citation.retracted && (
            <p className="citation-retracted" role="alert">
              <AlertTriangle size={12} />
              At least one source marks this work as retracted. Check before citing it.
            </p>
          )}
          {gaps.length > 0 && (
            <p className="citation-gaps" role="note">
              <AlertTriangle size={12} />
              <span>
                {gaps.some((g) => g.required) && (
                  <>
                    Incomplete for {styleLabel}: missing <strong>{gaps.filter((g) => g.required).map((g) => g.label).join(', ')}</strong>.{' '}
                  </>
                )}
                {gaps.some((g) => !g.required) && (
                  <>
                    {styleLabel} usually also has {gaps.filter((g) => !g.required).map((g) => g.label).join(', ')}.{' '}
                  </>
                )}
                <button type="button" className="citation-link-btn" onClick={handleStartEdit}>
                  Fill in
                </button>
              </span>
            </p>
          )}
          {savedDuplicate && (
            <p className="citation-warning-line" role="note">
              <AlertTriangle size={12} />
              Already cited for “{savedDuplicate}” — it would appear twice in a bibliography.
            </p>
          )}
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
            {citation.source === 'enriched' && citation.confidence && (
              <span
                className={`citation-source-chip citation-confidence-${citation.confidence}`}
                title={CONFIDENCE_TITLE[citation.confidence]}
              >
                {CONFIDENCE_TEXT[citation.confidence]}
              </span>
            )}
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
