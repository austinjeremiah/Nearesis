'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Badge } from './evidence';
import { Button, Card, EmptyState, Segmented, Select, Skeleton } from './ui';
import { ApiErrorState } from './states';
import { ApprovalCard, RunLink, RunStateChip, usd } from './run-parts';
import { qk } from '@/lib/api/keys';
import { browserApi } from '@/lib/api/browser';
import { formatAge, formatUtc } from '@/lib/format';
import { ik, investigateApi } from '@/lib/investigate/api';
import { useDecision } from '@/lib/investigate/hooks';

/* ------------------------------------------------------------------ agents and runs */

export function AgentsView({ wid }: { wid: string }) {
  const runs = useQuery({ queryKey: qk.runs(wid), queryFn: () => investigateApi.runs(wid) });
  const recent = (runs.data?.runs ?? []).slice(0, 6);
  const taskQs = useQueries({
    queries: recent.map((r) => ({ queryKey: ik.tasks(wid, r.runId), queryFn: () => investigateApi.tasks(r.runId) })),
  });
  if (runs.isPending) return <Skeleton rows={6} />;
  if (runs.isError) return <ApiErrorState error={runs.error} onRetry={() => runs.refetch()} />;
  if (runs.data.runs.length === 0)
    return <EmptyState title="No agents have run" body="Agents start when you ask a question." action={<Link className="btn primary" href={`/w/${wid}/investigate`}>Ask a question</Link>} />;

  const rows = recent.flatMap((r, i) => (taskQs[i]?.data?.tasks ?? []).map((t) => ({ run: r, t })));
  const loadingTasks = taskQs.some((q) => q.isPending);
  return (
    <div className="col gap4">
      <Card title="Agents" subtitle="Agent tasks from the six most recent runs, with what each was charged.">
        {loadingTasks && rows.length === 0 ? (
          <Skeleton rows={4} />
        ) : rows.length === 0 ? (
          <span className="small dim">No tasks were recorded for the recent runs.</span>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="agent-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Run</th>
                  <th className="n">Charged</th>
                  <th className="n">Tool calls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ run, t }) => (
                  <tr key={t.taskId}>
                    <td>
                      <Badge tone="ink">{t.role}</Badge>
                    </td>
                    <td className="small">{t.objective}</td>
                    <td>
                      <Badge tone={t.status === 'DONE' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'info'}>{t.status.toLowerCase()}</Badge>
                    </td>
                    <td>
                      <RunLink wid={wid} runId={run.runId}>
                        <span className="mono tiny">{run.runId.slice(0, 8)}</span>
                      </RunLink>
                    </td>
                    <td className="n mono" title="A dash means no ledger entry, not zero.">{usd(t.cost.usd)}</td>
                    <td className="n mono">{t.toolCalls.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Runs" actions={<Link className="btn primary" href={`/w/${wid}/investigate`}>Ask a question</Link>}>
        <div className="table-wrap">
          <table className="table" data-testid="run-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Run</th>
                <th>Started</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    <RunStateChip state={r.state} />
                  </td>
                  <td>
                    <RunLink wid={wid} runId={r.runId}>
                      <span className="mono small">{r.runId}</span>
                    </RunLink>
                  </td>
                  <td className="mono small" title={formatUtc(r.startedAt)}>{formatAge(r.startedAt)}</td>
                  <td className="mono small" title={formatUtc(r.updatedAt)}>{formatAge(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ approvals */

export function ApprovalsView({ wid }: { wid: string }) {
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  // GET /v1/approvals spans the caller's workspaces (newest 100); this page keeps this workspace's rows.
  const q = useQuery({ queryKey: ik.wsApprovals(wid, status), queryFn: () => investigateApi.globalApprovals(status) });
  const { decide, pendingFor, errorFor } = useDecision(wid);
  const rows = useMemo(() => (q.data?.approvals ?? []).filter((a) => a.workspaceId === wid), [q.data, wid]);
  return (
    <div className="col gap3">
      <div className="row gap3">
        <Segmented
          ariaLabel="Approval filter"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'all', label: 'All' },
          ]}
        />
        {q.data?.truncated && <span className="tiny dim">Showing the newest approvals only.</span>}
      </div>
      {q.isPending ? (
        <Skeleton rows={4} />
      ) : q.isError ? (
        <ApiErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'Nothing is waiting for approval' : 'No approvals yet'} body="A run asks here before it changes the canvas." />
      ) : (
        <div className="col gap3" data-testid="approval-list">
          {rows.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              a={a}
              pending={pendingFor(a.approvalId)}
              error={errorFor(a.approvalId)}
              onDecide={(d) => decide(a.runId, a, d)}
              context={
                <div className="row gap2 wrap small">
                  <span className="label">Run</span>
                  <RunLink wid={wid} runId={a.runId}>
                    <span className="mono">{a.runId.slice(0, 8)}</span>
                  </RunLink>
                  <RunStateChip state={a.runState} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ timeline */

const PAGE = 100;

export function TimelineView({ wid }: { wid: string }) {
  const q = useQuery({ queryKey: qk.timeline(wid), queryFn: () => browserApi.timeline(wid) });
  const [actor, setActor] = useState('all');
  const [kind, setKind] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const entries = useMemo(() => [...(q.data?.entries ?? [])].sort((a, b) => b.seq - a.seq), [q.data]);
  const kinds = useMemo(() => [...new Set(entries.map((e) => e.type.split('.')[0]))].sort(), [entries]);
  const actors = useMemo(() => [...new Set(entries.map((e) => e.actorKind))].sort(), [entries]);
  const shown = entries.filter((e) => (actor === 'all' || e.actorKind === actor) && (kind === 'all' || e.type.startsWith(`${kind}.`)));
  if (q.isPending) return <Skeleton rows={8} />;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (entries.length === 0) return <EmptyState title="No activity yet" body="Events appear here as the workspace changes." />;
  return (
    <div className="col gap3">
      <div className="row gap3 wrap">
        <Select aria-label="Actor" value={actor} onChange={(e) => setActor(e.target.value)} options={[{ value: 'all', label: 'All actors' }, ...actors.map((a) => ({ value: a, label: a }))]} />
        <Select aria-label="Event family" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'all', label: 'All events' }, ...kinds.map((k) => ({ value: k, label: k }))]} />
        <span className="tiny dim">{shown.length} of {entries.length} entries</span>
      </div>
      <ol className="col gap2" data-testid="timeline-full" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {shown.slice(0, limit).map((e) => (
          <li key={e.seq} className="row top gap3" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 8 }}>
            <span className="tiny dim mono" style={{ minWidth: 150 }} title={formatUtc(e.at)}>
              {formatUtc(e.at)}
            </span>
            <div className="grow col gap1">
              <span className="small strong">{e.summary}</span>
              <span className="tiny dim mono">
                {e.type}
                {e.documentRevision !== null ? ` · revision ${e.documentRevision}` : ''}
              </span>
            </div>
            <Badge outline>{e.actorKind}</Badge>
          </li>
        ))}
      </ol>
      {shown.length > limit && (
        <div>
          <Button onClick={() => setLimit((l) => l + PAGE)}>Show more</Button>
        </div>
      )}
    </div>
  );
}
