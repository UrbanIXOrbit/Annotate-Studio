'use client';

import React from 'react';
import { useAlignmentGuides } from '@/store/guides';
import { cn } from '@/lib/utils';

/** Displays hint lines inside the canvas world while an item's edges or centre
 * align with other items — rendered inside the transformed `.canvas-world`. */
export default function AlignmentGuides() {
  const guides = useAlignmentGuides((state) => state.guides);
  if (guides.length === 0) return null;
  return (
    <div className="canvas-guides" aria-hidden>
      {guides.map((guide, index) => (
        <span
          key={`${guide.axis}-${guide.at}-${index}`}
          className={cn('canvas-guide', guide.axis === 'x' ? 'canvas-guide-x' : 'canvas-guide-y')}
          style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }}
        />
      ))}
    </div>
  );
}
