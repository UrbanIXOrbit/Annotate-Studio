'use client';

import React from 'react';
import { useArrangePreview } from '@/store/arrange-preview';
import { useActiveWorkspace } from '@/store/canvas';

/** Ghost outlines showing where the Arrange panel would put each selected
 * window, numbered by the chosen order. Rendered inside the transformed
 * `.canvas-world` so the ghosts sit at world coordinates; purely visual —
 * nothing here is interactive, and it exists only while the panel is open. */
export default function ArrangePreview() {
  const placement = useArrangePreview((state) => state.placement);
  const order = useArrangePreview((state) => state.order);
  const workspace = useActiveWorkspace();
  if (!placement) return null;
  const byId = new Map(workspace.resources.map((resource) => [resource.id, resource]));
  const rank = new Map(order.map((id, index) => [id, index + 1]));
  return (
    <div className="arrange-ghosts" aria-hidden>
      {Object.entries(placement).map(([id, at]) => {
        const resource = byId.get(id);
        if (!resource) return null;
        return (
          <div key={id} className="arrange-ghost" style={{ left: at.x, top: at.y, width: resource.width, height: resource.height }}>
            <span className="arrange-ghost-badge">{rank.get(id)}</span>
          </div>
        );
      })}
    </div>
  );
}
