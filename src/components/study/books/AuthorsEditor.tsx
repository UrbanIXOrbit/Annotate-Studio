'use client';

import React from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';

/**
 * One row per person ("Family, Given"), with move-up / move-down / remove, instead of a
 * text box where order and punctuation are easy to break. Pasting several lines into a
 * row (a copied author list) splits them into separate people.
 */
export function AuthorsEditor({
  value,
  onChange,
  label,
  addLabel = 'Add author',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  addLabel?: string;
}) {
  const rows = value.length ? value : [];

  const update = (index: number, text: string) => onChange(rows.map((r, i) => (i === index ? text : r)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const paste = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[\r\n;]/.test(text)) return;
    event.preventDefault();
    const parts = text
      .split(/\r?\n|;/)
      .map((p) => p.trim())
      .filter(Boolean);
    onChange([...rows.slice(0, index), ...parts, ...rows.slice(index + 1)]);
  };

  return (
    <div className="citation-authors" role="group" aria-label={label}>
      {rows.map((row, index) => (
        <div key={index} className="citation-author-row">
          <input
            className="input input-sm"
            value={row}
            placeholder="Family, Given"
            aria-label={`${label} ${index + 1}`}
            dir="auto"
            onChange={(e) => update(index, e.target.value)}
            onPaste={(e) => paste(index, e)}
          />
          <button type="button" className="btn btn-sm btn-ghost citation-icon-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${label.toLowerCase()} ${index + 1} up`}>
            <ArrowUp size={13} />
          </button>
          <button type="button" className="btn btn-sm btn-ghost citation-icon-btn" onClick={() => move(index, 1)} disabled={index === rows.length - 1} aria-label={`Move ${label.toLowerCase()} ${index + 1} down`}>
            <ArrowDown size={13} />
          </button>
          <button type="button" className="btn btn-sm btn-ghost citation-icon-btn" onClick={() => remove(index)} aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm btn-ghost citation-add-author" onClick={() => onChange([...rows, ''])}>
        <Plus size={13} />
        {addLabel}
      </button>
    </div>
  );
}
