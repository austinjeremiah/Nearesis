'use client';

import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { ApprovalCard, runLabel, usd } from '@/components/nx/run-parts';
import { browserApi } from '@/lib/api/browser';
import { shellBrowser } from '@/lib/api/shell-browser';
import { qk } from '@/lib/api/keys';
import { useDecision } from '@/lib/investigate/hooks';
import { ACTIVE_STATES, investigateApi } from '@/lib/investigate/api';
import type { GlobalApproval } from '@/lib/api/shell';

const MAX_WORKSPACES = 6;

function InlineApproval({ a }: { a: GlobalApproval }) {
  const { decide, pendingFor, errorFor } = useDecision(a.workspaceId);
  return (
    <ApprovalCard
      a={{ approvalId: a.approvalId, actionHash: a.actionHash, status: a.status, kind: a.kind ?? 'approval', network: a.network ?? '—', costLimit: a.costLimit as number, requestedAt: a.requestedAt, decidedBy: a.decidedBy, decidedAt: null }}
      context={
        <p className="small dim">
          <Link className="link" href={`/w/${a.workspaceId}/runs/${a.runId}`}>{a.workspaceObjective}</Link> · run {runLabel(a.runState).toLowerCase()}
        </p>
      }
      pending={pendingFor(a.approvalId)}
      error={errorFor(a.approvalId)}
      onDecide={(d) => decide(a.runId, { approvalId: a.approvalId, actionHash: a.actionHash, status: a.status, kind: a.kind ?? 'approval', network: a.network ?? '', costLimit: a.costLimit as number, requestedAt: a.requestedAt, decidedBy: a.decidedBy, decidedAt: null }, d)}
    />
  );
}

/**
 * Header strip: runs that are not finished across the user's workspaces (the newest few, bounded), approvals waiting with
 * in-place decisions, and the global model spend. Polling is slow and react-query pauses it while the tab is hidden.
 */
export default function OpsStrip({ taskLine = null, taskWaiting = false }: { taskLine?: string | null; taskWaiting?: boolean }) {
  const ws = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces(), refetchInterval: 60_000 });
  const newest = [...(ws.data?.workspaces ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_WORKSPACES);
  const runs = useQueries({
    queries: newest.map((w) => ({ queryKey: ['agent', 'ops', 'runs', w.id], queryFn: () => investigateApi.runs(w.id), refetchInterval: 20_000, retry: false })),
  });
  const approvals = useQuery({ queryKey: ['agent', 'ops', 'approvals'], queryFn: () => shellBrowser.approvals('pending'), refetchInterval: 15_000, retry: false });
  const spend = useQuery({ queryKey: ['agent', 'ops', 'spend'], queryFn: () => shellBrowser.costGlobal(), refetchInterval: 30_000, retry: false });

  const active = newest.flatMap((w, i) => (runs[i]?.data?.runs ?? []).filter((r) => !r.terminal && ACTIVE_STATES.has(r.state)).map((r) => ({ w, r })));
  const runsKnown = newest.length === 0 || runs.every((r) => r.isSuccess);
  const pend = approvals.data?.approvals ?? [];
  return (
    <div className="ag-ops" data-testid="agent-ops">
      {taskLine && (
        <p className="ag-ops-task" data-testid="agent-ops-step" data-waiting={taskWaiting ? 'true' : undefined} title={taskLine}>
          <span className="ag-pulse" aria-hidden="true" />
          <span>{taskLine}</span>
        </p>
      )}
      <div className="ag-ops-row">
        <span data-testid="agent-ops-runs" title="Runs that are not finished, in your newest workspaces">
          <span className="label">Running</span> <span className="mono">{ws.isPending || !runsKnown ? '—' : active.length}</span>
        </span>
        <span data-testid="agent-ops-approvals">
          <span className="label">Approvals</span>{' '}
          <span className="mono">{approvals.isSuccess ? pend.length : '—'}</span>
          {approvals.data?.truncated && <span className="tiny dim"> (some workspaces not included)</span>}
        </span>
        <span data-testid="agent-ops-spend" title="Global model spend against the shared ceiling">
          <span className="label">Spend</span>{' '}
          <span className="mono">{spend.data ? `${usd(spend.data.committedUsd)} / ${usd(spend.data.ceilingUsd)}` : '—'}</span>
          {spend.data && spend.data.state !== 'ok' && <> <Badge tone="warn">{spend.data.state}</Badge></>}
        </span>
      </div>
      {active.length > 0 && (
        <ul className="ag-ops-list" aria-label="Active runs">
          {active.map(({ w, r }) => (
            <li key={r.runId}>
              <Badge tone={r.state === 'APPROVAL_NEEDED' ? 'warn' : 'info'}>{runLabel(r.state)}</Badge>{' '}
              <Link className="link small" href={`/w/${w.id}/runs/${r.runId}`}>{r.questionSummary || w.objective}</Link>
            </li>
          ))}
        </ul>
      )}
      {pend.length > 0 && (
        <details className="ag-ops-approvals">
          <summary>Decide {pend.length} waiting approval{pend.length === 1 ? '' : 's'} here</summary>
          <div className="col gap2" style={{ marginTop: 8 }}>
            {pend.slice(0, 5).map((a) => (
              <InlineApproval key={`${a.runId}-${a.approvalId}`} a={a} />
            ))}
            {pend.length > 5 && <Link className="link small" href="/notifications">{pend.length - 5} more</Link>}
          </div>
        </details>
      )}
    </div>
  );
}
