'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { GraphCanvas, type GraphEdge, type GraphNode } from '@/components/nx/graph';
import { Segmented } from '@/components/nx/ui';

/**
 * Evidence graph explorer: the canvas, with the written chain kept one click
 * away. The graph is the better tool for "where did this number come from";
 * the list is the better tool for reading, copying a hash, or using a screen
 * reader, so neither replaces the other.
 */
export function EvidenceExplorer({
  nodes,
  edges,
  children,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  children: ReactNode;
}) {
  const [mode, setMode] = useState<'graph' | 'list'>('graph');

  return (
    <>
      <div className="row gap2 wrap">
        <Segmented
          ariaLabel="Evidence view"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'graph', label: 'Graph' },
            { value: 'list', label: 'Chain list' },
          ]}
        />
        <div className="grow" />
        <span className="tiny dim">
          {nodes.length} records · {edges.length} links
        </span>
      </div>

      {mode === 'graph' ? (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          height={640}
          renderLink={(l) => (
            <Link className="link small" href={l.href}>
              {l.label}
            </Link>
          )}
        />
      ) : (
        children
      )}
    </>
  );
}
