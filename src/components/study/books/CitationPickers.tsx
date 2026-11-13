'use client';

import React from 'react';
import { CITATION_STYLES, EXPORT_FORMATS, type CitationStyle, type ExportFormat } from '@/lib/citation-formats';
import { cn } from '@/lib/utils';

/** Short pill labels; the full labels stay on hover. */
const STYLE_SHORT: Record<CitationStyle, string> = {
  apa: 'APA',
  harvard: 'Harvard',
  mla: 'MLA',
  chicago: 'Chicago',
  vancouver: 'Vancouver',
};

const FORMAT_SHORT: Record<ExportFormat, string> = {
  txt: 'Text',
  bib: 'BibTeX',
  ris: 'RIS',
  json: 'CSL',
};

/** Citation style as a segmented control (APA / Harvard / MLA / Chicago / Vancouver). */
export function CitationStylePicker({
  value,
  onChange,
  disabled,
  ariaLabel = 'Citation style',
  disabledTitle,
}: {
  value: CitationStyle;
  onChange: (style: CitationStyle) => void;
  disabled?: boolean;
  ariaLabel?: string;
  disabledTitle?: string;
}) {
  return (
    <div
      className={cn('segmented segmented-wrap citation-picker', disabled && 'citation-picker-disabled')}
      role="radiogroup"
      aria-label={ariaLabel}
      title={disabled ? disabledTitle : undefined}
    >
      {CITATION_STYLES.map((style) => (
        <button
          key={style.id}
          type="button"
          className={cn(value === style.id && 'active')}
          onClick={() => onChange(style.id)}
          disabled={disabled}
          title={style.label}
          aria-pressed={value === style.id}
        >
          {STYLE_SHORT[style.id]}
        </button>
      ))}
    </div>
  );
}

/** Export format as a segmented control (Text / BibTeX / RIS / CSL). */
export function ExportFormatPicker({
  value,
  onChange,
  ariaLabel = 'Export format',
}: {
  value: ExportFormat;
  onChange: (format: ExportFormat) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented segmented-wrap citation-picker" role="radiogroup" aria-label={ariaLabel}>
      {EXPORT_FORMATS.map((format) => (
        <button
          key={format.id}
          type="button"
          className={cn(value === format.id && 'active')}
          onClick={() => onChange(format.id)}
          title={format.label}
          aria-pressed={value === format.id}
        >
          {FORMAT_SHORT[format.id]}
        </button>
      ))}
    </div>
  );
}
