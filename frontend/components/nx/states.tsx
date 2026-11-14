'use client';

import type { ReactNode } from 'react';
import type { ApiState } from '@/lib/contracts/generated';
import { ApiRequestError } from '@/lib/api/errors';
import { STATE_UI } from '@/lib/api/states';
import { Button, EmptyState, Notice, Skeleton } from './ui';

/**
 * The 12 states from docs/api/STATES.md, rendered with the app's own Notice /
 * EmptyState / Skeleton. Non-blocking states (partial, stale, truncated,
 * metric_uncertified, method_unvalidated) draw a banner above whatever data
 * exists; blocking states (loading, source_unavailable, permission_denied,
 * rate_limited, insufficient_data, budget_exhausted) replace the content. No
 * state ever renders a number.
 */

export type StateExtra = {
  /** The caller's own sentence, shown under the standard copy (a reason, a missing input, a limit). */
  detail?: ReactNode;
  retryAfterSeconds?: number | null;
  traceId?: string | null;
  nextAction?: string | null;
  onRetry?: () => void;
};

function Footer({ state, x }: { state: ApiState; x: StateExtra }) {
  const parts: string[] = [];
  if (x.retryAfterSeconds) parts.push(`Retry in ${x.retryAfterSeconds}s.`);
  if (x.nextAction) parts.push(x.nextAction);
  const canRetry = x.onRetry && state !== 'permission_denied' && state !== 'insufficient_data';
  return (
    <>
      {x.detail && <div className="small">{x.detail}</div>}
      {parts.length > 0 && <div className="small dim">{parts.join(' ')}</div>}
      {x.traceId && <div className="tiny dim mono">trace {x.traceId}</div>}
      {canRetry && (
        <div style={{ marginTop: 8 }}>
          <Button onClick={x.onRetry}>Try again</Button>
        </div>
      )}
    </>
  );
}

/** Compact notice for non-blocking states. */
export function StateBanner({ state, ...x }: { state: ApiState } & StateExtra) {
  const ui = STATE_UI[state];
  return (
    <div data-state={state}>
      <Notice tone={ui.tone} title={ui.title}>
        {ui.body}
        <Footer state={state} x={x} />
      </Notice>
    </div>
  );
}

/** Full block for states that replace the content. */
export function StatePanel({ state, ...x }: { state: ApiState } & StateExtra) {
  const ui = STATE_UI[state];
  if (state === 'loading') {
    return (
      <div data-state="loading">
        <Skeleton rows={4} />
      </div>
    );
  }
  return (
    <div data-state={state}>
      <EmptyState title={ui.title} body={ui.body} />
      <div className="col gap1" style={{ alignItems: 'center', textAlign: 'center' }}>
        <Footer state={state} x={x} />
      </div>
    </div>
  );
}

/**
 * Render children according to a state: blocking states replace them, the
 * others put a banner above them. `complete` renders children untouched.
 */
export function WithState({ state, children, ...x }: { state: ApiState; children?: ReactNode } & StateExtra) {
  if (state === 'complete') return <>{children}</>;
  if (STATE_UI[state].blocksContent) return <StatePanel state={state} {...x} />;
  return (
    <div className="col gap3">
      <StateBanner state={state} {...x} />
      {children}
    </div>
  );
}

/**
 * Any failed API call as a state. State-bearing refusals use the taxonomy;
 * the rest (not found, validation, stale version, internal, network) get plain
 * copy and never pretend to be data.
 */
export function ApiErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!(error instanceof ApiRequestError)) {
    return (
      <Notice tone="bad" title="Something went wrong">
        The page could not load. {error instanceof Error ? error.message : ''}
      </Notice>
    );
  }
  const extra: StateExtra = {
    detail: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
    traceId: error.traceId,
    nextAction: error.nextAction,
    onRetry: error.retryable ? onRetry : undefined,
  };
  if (error.state) return <StatePanel state={error.state} {...extra} />;
  switch (error.kind) {
    case 'not_found':
      return <EmptyState title="Not found" body="That object does not exist, or you do not have access to it." />;
    case 'stale_version':
      return (
        <Notice tone="warn" title="Changed elsewhere">
          This was updated by someone else. Reload to see the latest version.
          <Footer state="partial" x={extra} />
        </Notice>
      );
    case 'validation':
      return (
        <Notice tone="bad" title="Request refused">
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
          <Footer state="partial" x={{ traceId: error.traceId }} />
        </Notice>
      );
    default:
      return (
        <Notice tone="bad" title="Something went wrong">
          {error.message}
          <Footer state="partial" x={extra} />
        </Notice>
      );
  }
}

/**
 * A page whose data stream has not been connected to the API yet. States that
 * honestly: no figures, no placeholders, which workstream owns it.
 */
export function NotConnected({ what, stream }: { what: string; stream: string }) {
  return (
    <div data-testid="not-connected" data-stream={stream}>
      <EmptyState
        title="Not connected to the API yet"
        body={`${what} is not wired to the backend yet (${stream}). Nothing is shown here until it is, so there are no placeholder figures.`}
      />
    </div>
  );
}
