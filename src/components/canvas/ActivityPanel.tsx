'use client';

import React, { useEffect, useState } from 'react';
import { Clock3, Crosshair, History, Trash2 } from 'lucide-react';
import Popover from '@/components/ui/Popover';
import { useCanvas, type ActivityEntry } from '@/store/canvas';
import { cn } from '@/lib/utils';

function when(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Recent additions to the canvas; click one to jump to it. */
export default function ActivityPanel({ asToolbarButton = false }: { asToolbarButton?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const anchor = React.useRef<HTMLButtonElement>(null);
  const activity = useCanvas((state) => state.activity);
  const reveal = useCanvas((state) => state.revealActivity);
  const clear = useCanvas((state) => state.clearActivity);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);
  void tick;

  const entries = [...activity].reverse();
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={asToolbarButton ? cn('toolbar-btn', open && 'toolbar-btn-active') : cn('tool-btn', open && 'tool-btn-active')}
        title="Recent activity — find an item on the canvas"
        onClick={() => setOpen((value) => !value)}
      >
        <History size={14} />
        {asToolbarButton && <span className="toolbar-label">History</span>}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} width={340}>
        <div className="activity-panel">
          <div className="activity-head">
            <strong>Recent activity</strong>
            {entries.length > 0 && (
              <button type="button" className="icon-btn icon-btn-sm" title="Clear history" onClick={clear}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
          {entries.length === 0 ? (
            <p className="muted">Items you add to the canvas will appear here.</p>
          ) : (
            <div className="activity-list">
              {entries.map((entry: ActivityEntry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="activity-row"
                  title="Go to this item on the canvas"
                  onClick={() => {
                    reveal(entry);
                    setOpen(false);
                  }}
                >
                  <Crosshair size={13} />
                  <span className="activity-label">{entry.label}</span>
                  <span className="activity-time">
                    <Clock3 size={11} /> {when(entry.at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
