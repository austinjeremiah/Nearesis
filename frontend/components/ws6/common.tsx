'use client';

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { ApiRequestError } from '@/lib/api/errors';
import { shortHash } from '@/lib/format';

/** One query's data: skeleton while loading, a typed state on failure, children on success. */
export function Slot<T>({
  q,
  children,
  rows = 3,
}: {
  q: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  children: (d: T) => ReactNode;
  rows?: number;
}) {
  if (q.isPending) return <Skeleton rows={rows} />;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{children(q.data as T)}</>;
}

/** A hash shown short, full on hover and copyable by selection. */
export function Hash({ value, testId }: { value: string | null | undefined; testId?: string }) {
  if (!value) return <span className="dim">none</span>;
  return (
    <span className="mono" title={value} data-testid={testId} data-full={value}>
      {shortHash(value, 10, 6)}
    </span>
  );
}

/** Run a mutation, hold its pending/error state, refresh the workspace scope on success. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>, opts: { invalidate?: readonly unknown[][]; onDone?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...a: A) => {
    setPending(true);
    setError(null);
    try {
      const r = await fn(...a);
      for (const k of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: k });
      opts.onDone?.(r);
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error, clear: () => setError(null) };
}

/** A refused mutation, with the backend's reason code and details (for example the missing acknowledgements). */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiRequestError) {
    return (
      <div data-testid="action-error" data-reason={error.reasonCode ?? error.errorCode}>
        <Notice tone="bad" title={`Refused: ${error.reasonCode ?? error.errorCode}`}>
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
          {error.nextAction && <div className="small dim">{error.nextAction}</div>}
        </Notice>
      </div>
    );
  }
  return <ApiErrorState error={error} />;
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 260, overflow: 'auto' }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
