'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Globe, Layers, Quote as QuoteIcon, Search, StickyNote } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import type { SearchHit, SearchKind } from '@/lib/global-search';
import { cn } from '@/lib/utils';
import { openSearchHit, useSearch, type SearchScope } from '@/store/search';

const KIND_META: Record<SearchKind, { label: string; icon: React.ReactNode }> = {
  note: { label: 'Notes', icon: <StickyNote size={14} /> },
  pdf: { label: 'PDFs', icon: <FileText size={14} /> },
  book: { label: 'Books', icon: <BookOpen size={14} /> },
  card: { label: 'Cards', icon: <Layers size={14} /> },
  article: { label: 'Articles', icon: <Globe size={14} /> },
  quote: { label: 'Quotes', icon: <QuoteIcon size={14} /> },
};

const SCOPES: Array<{ id: SearchScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'note', label: 'Notes' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'book', label: 'Books' },
  { id: 'card', label: 'Cards' },
  { id: 'article', label: 'Articles' },
  { id: 'quote', label: 'Quotes' },
];

/** Render the snippet with the matched ranges emphasised. */
function Snippet({ hit }: { hit: SearchHit }) {
  if (hit.highlight.length === 0) return <>{hit.snippet}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of hit.highlight) {
    if (range.start > cursor) parts.push(hit.snippet.slice(cursor, range.start));
    parts.push(<mark key={`${range.start}-${range.end}`}>{hit.snippet.slice(range.start, range.end)}</mark>);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < hit.snippet.length) parts.push(hit.snippet.slice(cursor));
  return <>{parts}</>;
}

/** "p. 14" for pages; a chapter marker for book positions. */
function locationOf(hit: SearchHit): string | null {
  if (hit.locator?.page) return `p. ${hit.locator.page}`;
  if (hit.locator?.cfi) return 'chapter';
  return null;
}

export default function GlobalSearchDialog() {
  const open = useSearch((state) => state.open);
  const query = useSearch((state) => state.query);
  const scope = useSearch((state) => state.scope);
  const hits = useSearch((state) => state.hits);
  const indexing = useSearch((state) => state.indexing);
  const hide = useSearch((state) => state.hide);
  const setQuery = useSearch((state) => state.setQuery);
  const setScope = useSearch((state) => state.setScope);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A fresh palette starts with an empty query, like other launchers.
  useEffect(() => {
    if (open) {
      setQuery('');
      setScope('all');
      setActive(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [query, scope]);

  useEffect(() => {
    const row = listRef.current?.querySelector('.search-hit.active');
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const indexingNow = indexing.total > 0 && indexing.done < indexing.total;
  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    if (openSearchHit(hit)) hide();
  };

  // Group headers appear wherever the kind of the sorted results changes.
  let previousKind: SearchKind | null = null;

  return (
    <Dialog open onClose={hide} title="Search contents" width={560}>
      <div className="search-palette">
        <div className="search-field search-palette-field">
          <Search size={15} />
          <input
            className="input"
            data-autofocus
            value={query}
            placeholder="Search notes, PDFs, books, cards… (&quot;quoted phrases&quot; supported)"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, hits.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                pick(hits[active]);
              }
            }}
            dir="auto"
          />
        </div>
        <div className="segmented search-palette-scopes" role="group" aria-label="Search scope">
          {SCOPES.map((entry) => (
            <button key={entry.id} type="button" className={cn(scope === entry.id && 'active')} aria-pressed={scope === entry.id} onClick={() => setScope(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <div className="search-results" ref={listRef}>
          {query.trim() === '' ? (
            <p className="search-hint">
              Type to search the full text of every note, PDF, book, card and article — plus your annotations. Click a result to jump to it
              on the canvas.
            </p>
          ) : hits.length === 0 ? (
            <p className="search-hint">{indexingNow ? 'Still reading files… try again in a moment.' : 'No matches.'}</p>
          ) : (
            hits.map((hit, index) => {
              const header = hit.kind !== previousKind ? <div className="search-results-header">{KIND_META[hit.kind].label}</div> : null;
              previousKind = hit.kind;
              const location = locationOf(hit);
              return (
                <React.Fragment key={`${hit.path}-${index}`}>
                  {header}
                  <button
                    type="button"
                    className={cn('search-hit', index === active && 'active')}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => pick(hit)}
                  >
                    <span className="search-hit-icon">{KIND_META[hit.kind].icon}</span>
                    <span className="search-hit-main">
                      <span className="search-hit-title">{hit.title}</span>
                      <span className="search-hit-snippet">
                        <Snippet hit={hit} />
                      </span>
                    </span>
                    {location && <span className="search-hit-loc">{location}</span>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
        {indexingNow && (
          <p className="search-progress" aria-live="polite">
            Reading {indexing.done}/{indexing.total} files…
          </p>
        )}
      </div>
    </Dialog>
  );
}
