'use client';

import { errorReason, SOURCE_LABELS, summarizeProgress, type SourceProgress } from '@/lib/reference-lookup.ts';

type ChipState = 'wait' | 'ok' | 'none' | 'err';

function stateOf(p: SourceProgress): { state: ChipState; text: string } {
  if (p.pending) return { state: 'wait', text: 'checking' };
  if (p.found) return { state: 'ok', text: `${p.found} found` };
  if (p.errors.length) return { state: 'err', text: errorReason(p.errors) };
  return { state: 'none', text: 'no record' };
}

/**
 * How each online source answered the lookup — live while it runs, and kept
 * afterwards so a source that failed or was rate-limited is visible rather
 * than silently missing from the merge.
 */
export function SourceStatusChips({ progress }: { progress: Record<string, SourceProgress> | null }) {
  const keys = progress ? Object.keys(progress) : [];
  if (!progress || keys.length === 0) return null;
  return (
    <ul className="citation-source-status" aria-label="Source status">
      {keys.map((key) => {
        const p = progress[key];
        const { state, text } = stateOf(p);
        return (
          <li
            key={key}
            className={`citation-source-status-item citation-source-status-${state}`}
            title={p.errors.length ? [...new Set(p.errors)].join(' ') : undefined}
          >
            {SOURCE_LABELS[key] ?? key}: {text}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One plain sentence for the whole lookup ("Checked 7 sources — 4 found a record, 2 had none;
 * Semantic Scholar was rate-limited.") with a button to ask only the failed sources again.
 */
export function SourceSummary({
  progress,
  busy,
  onRetry,
}: {
  progress: Record<string, SourceProgress> | null;
  busy: boolean;
  onRetry?: () => void;
}) {
  if (!progress) return null;
  const summary = summarizeProgress(progress);
  if (!summary.text) return null;
  const canRetry = !!onRetry && !busy && summary.checking === 0 && summary.failed.length > 0;
  return (
    <div className="citation-source-summary" role="status" aria-live="polite">
      <span>{summary.text}</span>
      {canRetry && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
          Retry {summary.failed.length === 1 ? summary.failed[0].label : 'failed sources'}
        </button>
      )}
    </div>
  );
}
