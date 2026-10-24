'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RowMenuItem {
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  dividerBefore?: boolean;
  onClick: () => void;
}

/**
 * The "…" button revealed on row hover. The dropdown dismisses on
 * outside click or Escape.
 */
export function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={cn('row-menu', open && 'menu-open')} ref={ref}>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label="More actions"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={15} />
      </button>

      {open && (
        <div className="dropdown" onClick={(event) => event.stopPropagation()}>
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.dividerBefore && <div className="dropdown-divider" />}
              <button
                type="button"
                className={cn('dropdown-item', item.danger && 'danger')}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
