'use client';

import React, { memo, useMemo } from 'react';
import { useAlignmentGuides } from '@/store/guides';
import { cn } from '@/lib/utils';
import type { SpacingGuide } from '@/lib/layout';

const GapMarker = memo(function GapMarker({ gap }: { gap: SpacingGuide }) {
  const { length, style } = useMemo(() => {
    const length = Math.round(gap.to - gap.from);
    return {
      length,
      style: gap.axis === 'x'
        ? { left: gap.from, top: gap.across, width: length }
        : { left: gap.across, top: gap.from, height: length },
    };
  }, [gap]);
  return (
    <span className={cn('canvas-gap', gap.axis === 'x' ? 'canvas-gap-x' : 'canvas-gap-y')} style={style}>
      <span className="canvas-gap-label">{length}</span>
    </span>
  );
});

/** Displays hint lines inside the canvas world while an item's edges or centre
 * align with other items, plus a marker (labelled with its size) for each of two
 * equal gaps — rendered inside the transformed `.canvas-world`. Only things that
 * really hold at the current position are ever passed in. */
export default function AlignmentGuides() {
  const guides = useAlignmentGuides((state) => state.guides);
  const spacing = useAlignmentGuides((state) => state.spacing);
  if (guides.length === 0 && spacing.length === 0) return null;
  return (
    <div className="canvas-guides" aria-hidden>
      {guides.map((guide, index) => (
        <span
          key={`${guide.axis}-${guide.at}-${index}`}
          className={cn('canvas-guide', guide.axis === 'x' ? 'canvas-guide-x' : 'canvas-guide-y')}
          style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }}
        />
      ))}
      {spacing.map((gap, index) => <GapMarker key={`gap-${gap.axis}-${gap.from}-${gap.across}-${index}`} gap={gap} />)}
    </div>
  );
}
