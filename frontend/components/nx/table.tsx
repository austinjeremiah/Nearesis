'use client';

import type { ReactNode } from 'react';
import { EmptyState, Skeleton } from './ui';
import { Notice } from './ui';

/**
 * DataTable. Spec 5.3 defaults lists to a table for density, and spec 14 demands
 * every list handle loading, empty, no-results, denied and error separately.
 * Those are five different situations and a reader should not have to guess
 * which one they are looking at, so they are five explicit branches here rather
 * than one "no data" message.
 */

export type Column<T> = {
  key: string;
  header: string;
  /** Right-aligned with tabular figures. Use for every numeric column. */
  numeric?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
};

export type TableState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'empty' }
  | { status: 'no_results' }
  | { status: 'denied'; reason: string }
  | { status: 'error'; message: string; onRetry?: () => void };

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  state = { status: 'ready' },
  density = 'compact',
  onRowClick,
  caption,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  state?: TableState;
  density?: 'compact' | 'comfortable';
  onRowClick?: (row: T) => void;
  caption: string;
  empty?: { title: string; body?: string; action?: ReactNode };
}) {
  if (state.status === 'loading') {
    return (
      <div className="table-wrap" style={{ padding: 16 }}>
        <Skeleton rows={5} />
      </div>
    );
  }

  if (state.status === 'denied') {
    return <Notice tone="warn" title="You do not have access to this list">{state.reason}</Notice>;
  }

  if (state.status === 'error') {
    return (
      <Notice tone="bad" title="This list could not be loaded">
        {state.message}
      </Notice>
    );
  }

  if (state.status === 'no_results') {
    return (
      <EmptyState
        title="No matches"
        body="No rows match the current filters. Clear a filter or widen the time range."
      />
    );
  }

  if (state.status === 'empty' || rows.length === 0) {
    return (
      <EmptyState
        title={empty?.title ?? 'Nothing here yet'}
        body={empty?.body}
        action={empty?.action}
      />
    );
  }

  return (
    <div className="table-wrap">
      <table className="table" data-density={density}>
        <caption className="label" style={{ textAlign: 'left', padding: '8px 12px' }}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.numeric ? 'n' : undefined} style={{ width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              // Rows stay keyboard reachable when they are clickable. Spec 14
              // requires a keyboard alternative for every table action.
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'n' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
