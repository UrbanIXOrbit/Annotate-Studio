'use client';

import { citationSourceLabel, FIELD_LABELS } from '@/lib/book-citations';
import { SOURCE_LABELS } from '@/lib/reference-lookup.ts';
import type { BookCitation } from '@/store/books';

const CONF_TEXT: Record<string, string> = {
  high: 'Cross-checked',
  medium: 'Partly cross-checked',
  low: 'Not cross-checked',
};

/**
 * Shared candidate picker rows — the merged-best record first, then the
 * engine's alternates (other versions, next-best clusters). Every row shows
 * its provenance chip, how thoroughly it was cross-checked, and any fields
 * the sources disagreed on.
 */
export function CitationCandidateList({
  candidates,
  onPick,
}: {
  candidates: BookCitation[];
  onPick: (citation: BookCitation) => void;
}) {
  return (
    <div className="citation-candidates">
      {candidates.map((candidate, index) => {
        const sources = [...new Set(Object.values(candidate.fieldSources ?? {}))].map((s) => SOURCE_LABELS[s] || s);
        return (
          <button
            key={`${candidate.title}-${index}`}
            type="button"
            className="citation-candidate"
            onClick={() => onPick(candidate)}
          >
            <span className="citation-candidate-title">{candidate.title}</span>
            <span className="citation-candidate-meta">
              {[candidate.authors.join(', '), candidate.container || candidate.publisher, candidate.year].filter(Boolean).join(' · ') ||
                'No details'}
            </span>
            <span className="citation-candidate-tags">
              {index === 0 && candidates.length > 1 && (
                <span className="citation-source-chip citation-source-chip-best">Best match</span>
              )}
              <span className={`citation-source-chip citation-pill-${candidate.confidence ?? 'low'}`}>
                {CONF_TEXT[candidate.confidence ?? 'low']}
              </span>
              <span className="citation-source-chip">{citationSourceLabel(candidate)}</span>
              {sources.length > 0 && (
                <span className="citation-source-chip" title="Sources that contributed to this record">
                  {sources.join(', ')}
                </span>
              )}
              {candidate.retracted && (
                <span className="citation-conflict-chip" title="At least one source marks this work as retracted">
                  Retracted?
                </span>
              )}
              {(candidate.conflicts ?? []).map((field) => (
                <span key={field} className="citation-conflict-chip" title="Sources disagree on this field">
                  {FIELD_LABELS[field]}?
                </span>
              ))}
            </span>
            {candidate.note && <span className="citation-candidate-note">{candidate.note}</span>}
          </button>
        );
      })}
    </div>
  );
}
