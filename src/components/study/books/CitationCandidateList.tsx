'use client';

import { citationSourceLabel, diffCitationFields, FIELD_LABELS, sourceDisplayName } from '@/lib/book-citations';
import { formatCitationHtml, type CitationStyle } from '@/lib/citation-formats';
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
 * the sources disagreed on. Each row previews the reference as it would be
 * copied (in the chosen style) and, when a citation is already saved, which of
 * its fields would change.
 */
export function CitationCandidateList({
  candidates,
  onPick,
  style = 'apa',
  current = null,
  duplicateOf,
}: {
  candidates: BookCitation[];
  onPick: (citation: BookCitation) => void;
  style?: CitationStyle;
  current?: BookCitation | null;
  /** Name of another book that already holds this citation, so a repeat is flagged before it is saved */
  duplicateOf?: (citation: BookCitation) => string | null;
}) {
  return (
    <div className="citation-candidates">
      {candidates.map((candidate, index) => {
        const sources = [...new Set(Object.values(candidate.fieldSources ?? {}))].map((s) => sourceDisplayName(s));
        const changes = current ? diffCitationFields(current, candidate) : null;
        const repeat = duplicateOf?.(candidate) ?? null;
        return (
          <button
            key={`${candidate.title}-${index}`}
            type="button"
            className="citation-candidate"
            onClick={() => onPick(candidate)}
          >
            <span className="citation-candidate-title">{candidate.title}</span>
            <span className="citation-candidate-meta">
              {[
                candidate.authors.join(', '),
                candidate.container || candidate.publisher,
                candidate.year,
                candidate.edition ? `${candidate.edition} ed.` : '',
                candidate.isbn ? `ISBN ${candidate.isbn}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'No details'}
            </span>
            {/* formatCitationHtml escapes everything and only adds <i> around titles */}
            <span
              className="citation-candidate-preview"
              dangerouslySetInnerHTML={{ __html: formatCitationHtml(style, candidate) }}
            />
            {changes && (
              <span className={changes.length ? 'citation-candidate-diff' : 'citation-candidate-diff citation-candidate-same'}>
                {changes.length
                  ? `Changes your saved citation: ${changes.map((f) => FIELD_LABELS[f]).join(', ')}`
                  : 'Same as your saved citation'}
              </span>
            )}
            {repeat && <span className="citation-candidate-diff">Already cited for “{repeat}”</span>}
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
