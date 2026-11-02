'use client';

import React, { useEffect, useState } from 'react';
import { FileText, Loader2, Search, Wand2 } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation } from '@/store/books';
import {
  extractCitationFromFile,
  fallbackTitleFromFile,
  parseCitationInput,
  enrichCitation,
} from '@/lib/book-citations';
import { SOURCE_LABELS, setReferenceContactEmail } from '@/lib/reference-lookup.ts';
import { errorMessage } from '@/lib/tauri-commands';
import Dialog from '@/components/ui/Dialog';
import { CitationCandidateList } from './CitationCandidateList';

const SOURCE_KEYS = Object.keys(SOURCE_LABELS);
const SOURCES_STORE_KEY = 'citation-sources-disabled';
const EMAIL_STORE_KEY = 'citation-contact-email';

function loadEnabledSources(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SOURCES_STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

interface AddCitationDialogProps {
  open: boolean;
  onClose: () => void;
  fileId: string | null;
}

/**
 * Search-first citation dialog (the therightbibtex input model): feed the
 * engine whatever you know — title, author, ISBN, DOI, a pasted reference the
 * parser can mine for identifiers — or start from the file's own metadata.
 * The picked record is saved onto the book.
 */
export function AddCitationDialog({ open, onClose, fileId }: AddCitationDialogProps) {
  const { files, updateFile } = useBooks();
  const file = fileId ? files[fileId] : null;

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [isbn, setIsbn] = useState('');
  const [doi, setDoi] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<BookCitation[] | null>(null);
  const [seed, setSeed] = useState<BookCitation | null>(null);
  // On by default while the display name is still the untouched filename — a
  // fetched citation usually knows the real title better than "10.1515_...pdf".
  const [renameToTitle, setRenameToTitle] = useState(
    () => !file || file.name === (file.filePath.split('/').pop() ?? ''),
  );
  const [enabledSources, setEnabledSources] = useState<Record<string, boolean>>(loadEnabledSources);
  const [email, setEmail] = useState(() => {
    try {
      return window.localStorage.getItem(EMAIL_STORE_KEY) ?? '';
    } catch {
      return '';
    }
  });

  // The polite-pool email reaches Crossref/OpenAlex/PubMed with every lookup.
  useEffect(() => {
    setReferenceContactEmail(email);
    try {
      window.localStorage.setItem(EMAIL_STORE_KEY, email);
    } catch {
      // private mode — the session still works
    }
  }, [email]);

  const toggleSource = (key: string) => {
    setEnabledSources((current) => {
      const next = { ...current, [key]: current[key] === false };
      try {
        window.localStorage.setItem(SOURCES_STORE_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
      return next;
    });
  };

  if (!open || !file) return null;

  const handleParse = () => {
    const parsed = parseCitationInput(paste);
    if (!parsed.isbn && !parsed.doi && !parsed.remainder) {
      toast.info('Nothing found — paste a citation, ISBN or DOI');
      return;
    }
    if (parsed.isbn) setIsbn(parsed.isbn);
    if (parsed.doi) setDoi(parsed.doi);
    if (!title.trim() && parsed.remainder) setTitle(parsed.remainder);
    setPaste('');
  };

  /** Prefill the inputs from the file's own metadata — useful when only the title is garbage. */
  const handleReadFile = async () => {
    setReading(true);
    setError(null);
    try {
      const extracted = await extractCitationFromFile(file);
      if (!title.trim()) setTitle(extracted.title);
      if (!author.trim() && extracted.authors[0]) setAuthor(extracted.authors.join(', '));
      if (!isbn.trim() && extracted.isbn) setIsbn(extracted.isbn);
      if (!doi.trim() && extracted.doi) setDoi(extracted.doi);
      setSeed(extracted);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };

  const buildSeedFromInputs = (): BookCitation => ({
    title: title.trim() || fallbackTitleFromFile(file.name),
    authors: author
      .trim()
      .split(/[,;\n]+/)
      .map((name) => name.trim())
      .filter(Boolean),
    isbn: isbn.trim() || undefined,
    doi: doi.trim() || undefined,
    source: 'embedded',
    retrievedAt: new Date().toISOString(),
  });

  const handleSearch = async () => {
    setError(null);
    setBusy(true);
    try {
      let base = seed;
      if (!base) {
        base = buildSeedFromInputs();
        // No manual input at all — the file's own metadata is the better seed.
        if (!title.trim() && !author.trim() && !isbn.trim() && !doi.trim()) {
          try {
            base = await extractCitationFromFile(file);
          } catch {
            // keep the filename-derived seed
          }
        }
      }
      setSeed(base);
      const result = await enrichCitation(base, { enabled: enabledSources });
      setCandidates(result.candidates);
      if (result.candidates.length === 0) {
        toast.info('No online matches — refine the inputs or use the file metadata');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePick = (citation: BookCitation) => {
    // The display name is a separate field — `name` keeps the original import
    // filename and filePath is untouched, so duplicate detection and disk
    // verification are unaffected.
    updateFile(file.id, {
      citation,
      ...(renameToTitle && citation.title.trim() ? { displayName: citation.title.trim() } : {}),
    });
    toast.success(renameToTitle ? 'Citation saved — book renamed to its title' : 'Citation saved to the book');
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Add citation — ${file.displayName || file.name}`} width={560}>
      <div className="add-citation">
        <p className="citation-hint">
          Fill in whatever you know about the book — every field is optional. An ISBN or DOI pins the exact edition.
        </p>

        <div className="citation-search-form">
          <label className="citation-field citation-field-wide">
            <span>Title</span>
            <input
              className="input input-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={fallbackTitleFromFile(file.name)}
              dir="auto"
            />
          </label>
          <label className="citation-field citation-field-wide">
            <span>Author (optional)</span>
            <input
              className="input input-sm"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Tolstoy, Leo"
              dir="auto"
            />
          </label>
          <label className="citation-field">
            <span>ISBN</span>
            <input
              className="input input-sm"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              placeholder="9780140449136"
              dir="auto"
            />
          </label>
          <label className="citation-field">
            <span>DOI</span>
            <input
              className="input input-sm"
              value={doi}
              onChange={(e) => setDoi(e.target.value)}
              placeholder="10.1000/…"
              dir="auto"
            />
          </label>
        </div>

        <label className="citation-field citation-field-wide">
          <span>Paste a reference — the parser pulls out the ISBN, DOI and title</span>
          <textarea
            className="textarea citation-authors-input"
            rows={2}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Tolstoy, Leo. War and Peace. Penguin, 1869. ISBN 978-0-14-044913-6"
            dir="auto"
          />
        </label>

        <div className="citation-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={handleParse} disabled={!paste.trim()}>
            <Wand2 size={14} />
            Parse
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={handleReadFile} disabled={reading}>
            {reading ? <Loader2 size={14} className="btn-spin" /> : <FileText size={14} />}
            {reading ? 'Reading…' : 'Read from file'}
          </button>
          <span className="add-citation-spacer" />
          <button type="button" className="btn btn-sm btn-primary" onClick={handleSearch} disabled={busy}>
            {busy ? <Loader2 size={14} className="btn-spin" /> : <Search size={14} />}
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>

        <details className="add-citation-settings">
          <summary>Optional settings</summary>
          <p className="citation-hint">Sources to check. Untick one if it keeps failing or rate-limiting you.</p>
          <div className="add-citation-checks">
            {SOURCE_KEYS.map((key) => (
              <label key={key} className="add-citation-check">
                <input type="checkbox" checked={enabledSources[key] !== false} onChange={() => toggleSource(key)} />
                {SOURCE_LABELS[key]}
              </label>
            ))}
          </div>
          <p className="citation-hint">
            Crossref, OpenAlex and PubMed give faster, more reliable service when you include a contact email. It is
            only sent to those services.
          </p>
          <label className="citation-field">
            <span>Your email (optional)</span>
            <input
              className="input input-sm"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </details>

        {error && <p className="citation-error">{error}</p>}

        {candidates && candidates.length > 0 && (
          <div className="citation-pick">
            <p className="citation-hint">Pick the right record — it will be saved to this book:</p>
            <label className="add-citation-rename">
              <input type="checkbox" checked={renameToTitle} onChange={(e) => setRenameToTitle(e.target.checked)} />
              Rename the book to the picked citation's title (display name only — the file on disk is untouched)
            </label>
            <CitationCandidateList candidates={candidates} onPick={handlePick} />
            {seed && (
              <div className="citation-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => handlePick(seed)}>
                  None of these — save what the file provides
                </button>
              </div>
            )}
          </div>
        )}
        {candidates && candidates.length === 0 && (
          <p className="citation-hint">No matches. Correct the title or identifiers and search again.</p>
        )}
      </div>
    </Dialog>
  );
}
