'use client';

import type { ReactNode } from 'react';
import { Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { Badge } from '@/components/nx/evidence';
import { ApiRequestError } from '@/lib/api/errors';

/** One query's data: skeleton while loading, the typed state on failure, children on success. */
export function Slot<T>({
  q,
  rows = 3,
  children,
}: {
  q: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  rows?: number;
  children: (d: T) => ReactNode;
}) {
  if (q.isPending) return <Skeleton rows={rows} />;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{children(q.data as T)}</>;
}

/** A failed mutation, shown where the action was taken. Names the refusal code so it is not a mystery. */
export function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiRequestError) {
    return (
      <div data-testid="mutation-error" data-code={error.reasonCode ?? error.errorCode}>
        <Notice tone="bad" title={error.reasonCode ?? error.errorCode}>
          {error.message}
          {error.details.length > 0 && (
            <ul className="small">
              {error.details.map((d, i) => (
                <li key={i} className="mono">
                  {d.path}: {d.issue}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      </div>
    );
  }
  return (
    <div data-testid="mutation-error">
      <Notice tone="bad" title="Action failed">
        {error instanceof Error ? error.message : String(error)}
      </Notice>
    </div>
  );
}

const MARKER_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | ''> = {
  DRAFT: '',
  ACTIVE: 'info',
  INVESTIGATING: 'info',
  REVIEW_REQUIRED: 'warn',
  RESOLVED: 'ok',
  MONITORING: 'ok',
  DISMISSED: '',
};
export const MarkerStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={MARKER_TONE[status] ?? ''}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>
);

export const ModeBadge = ({ mode }: { mode: 'live' | 'replay' }) => (
  <Badge tone={mode === 'replay' ? 'warn' : 'ok'} title={mode === 'replay' ? 'Replay: re-emitted events, excluded from live counters.' : 'Live source path.'}>
    {mode}
  </Badge>
);

export const SUPPORT_TONE: Record<string, 'ok' | 'warn' | 'bad'> = { supported: 'ok', unsupported: 'warn', contradicted: 'bad' };

/** Renders an `{state:'unknown', reason}` or a value object honestly. */
export function UnknowableView({ v, empty = 'Not provided' }: { v: { state?: string; reason?: string } & Record<string, unknown> | undefined; empty?: string }) {
  if (!v) return <span className="dim small">{empty}</span>;
  if (v.state === 'unknown')
    return (
      <div data-state="unknown">
        <Badge tone="warn">unknown</Badge> <span className="small dim">{v.reason}</span>
      </div>
    );
  const { state, ...rest } = v;
  return (
    <div className="col gap1">
      {state && <Badge outline>{String(state)}</Badge>}
      <pre className="rs-pre">{JSON.stringify(rest, null, 2)}</pre>
    </div>
  );
}

export const fmtNum = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits);
