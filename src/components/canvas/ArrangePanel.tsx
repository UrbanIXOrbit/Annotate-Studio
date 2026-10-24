'use client';

import React, { useState, type RefObject } from 'react';
import { Columns3, LayoutGrid, Rows3, Workflow } from 'lucide-react';
import Popover from '@/components/ui/Popover';
import { arrangeIds, ORDER_LABELS } from '@/lib/group-actions';
import type { Layout, Order, Spacing } from '@/lib/arrange';
import { cn } from '@/lib/utils';

const LAYOUTS: { id: Layout; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'grid', label: 'Grid', hint: 'Rows and columns', icon: <LayoutGrid size={18} /> },
  { id: 'row', label: 'Row', hint: 'One line, left to right', icon: <Rows3 size={18} /> },
  { id: 'column', label: 'Column', hint: 'A tidy stack', icon: <Columns3 size={18} /> },
  { id: 'flow', label: 'Flow', hint: 'Like a row that wraps', icon: <Workflow size={18} /> },
];
const ORDERS: Order[] = ['position', 'page', 'color', 'title', 'selection'];
const SPACINGS: { id: Spacing; label: string }[] = [
  { id: 'tight', label: 'Tight' },
  { id: 'normal', label: 'Normal' },
  { id: 'roomy', label: 'Roomy' },
];

// Remembered for the rest of the session so repeated tidying is one click.
let last: { layout: Layout; order: Order; spacing: Spacing; chain: boolean } = { layout: 'grid', order: 'position', spacing: 'normal', chain: false };

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  ids: string[];
}

function Body({ ids, onClose }: Pick<Props, 'ids' | 'onClose'>) {
  const [layout, setLayout] = useState(last.layout);
  const [order, setOrder] = useState(last.order);
  const [spacing, setSpacing] = useState(last.spacing);
  const [chain, setChain] = useState(last.chain);

  const apply = () => {
    last = { layout, order, spacing, chain };
    arrangeIds(ids, { layout, order, spacing, chain });
    onClose();
  };

  return (
    <div className="arrange-panel">
      <div className="arrange-head">Arrange {ids.length} items</div>
      <div className="arrange-section">Layout</div>
      <div className="arrange-layouts" role="radiogroup" aria-label="Layout">
        {LAYOUTS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={layout === option.id}
            className={cn('arrange-layout', layout === option.id && 'active')}
            title={option.hint}
            onClick={() => setLayout(option.id)}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <div className="arrange-section">Order by</div>
      <div className="arrange-orders" role="radiogroup" aria-label="Order">
        {ORDERS.map((option) => (
          <button key={option} type="button" role="radio" aria-checked={order === option} className={cn('arrange-chip', order === option && 'active')} onClick={() => setOrder(option)}>
            {ORDER_LABELS[option]}
          </button>
        ))}
      </div>
      <div className="arrange-section">Spacing</div>
      <div className="arrange-spacings" role="radiogroup" aria-label="Spacing">
        {SPACINGS.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={spacing === option.id} className={cn('arrange-chip', spacing === option.id && 'active')} onClick={() => setSpacing(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
      <label className="arrange-chain">
        <input type="checkbox" checked={chain} onChange={(event) => setChain(event.target.checked)} /> Also chain them in this order
      </label>
      <button type="button" className="btn btn-primary arrange-apply" onClick={apply}>
        Arrange
      </button>
    </div>
  );
}

/** Choose how the selected items are laid out: shape, order, spacing, and whether to chain them. */
export default function ArrangePanel({ anchorRef, open, onClose, ids }: Props) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={300} className="arrange-popover">
      <Body ids={ids} onClose={onClose} />
    </Popover>
  );
}
