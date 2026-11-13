'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { Button, Notice, Skeleton, Spinner } from '@/components/nx/ui';
import { ConfirmDialog } from '@/components/nx/overlays';
import { ApiErrorState, StateBanner } from '@/components/nx/states';
import { ApprovalCard, FindingCard, RunStateChip, usd } from '@/components/nx/run-parts';
import { ApiRequestError } from '@/lib/api/errors';
import { formatAge } from '@/lib/format';
import { useStreamStatus } from '@/lib/sse/hub';
import { ik, investigateApi } from '@/lib/investigate/api';
import { useDecision } from '@/lib/investigate/hooks';
import { findingHighlighted, panelKey, runFindingKey, toggle, type Selection } from '@/lib/agent/selection';
import { tidyNumbers } from '@/lib/prose';

const dur = (a: string | null, b: string | null, now: number) => {
  if (!a) return '—';
  const ms = (b ? Date.parse(b) : now) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`) : '—';
};

function Meter({ label, spent, total, format }: { label: string; spent: number; total: number; format: (n: number) => string }) {
  const ratio = total > 0 ? Math.min(1, spent / total) : 0;
  return (
    <div className="ag-meter">
      <div className="row between tiny">
        <span className="label">{label}</span>
        <span className="mono">{format(spent)} / {format(total)}</span>
      </div>
      <progress value={ratio} max={1} aria-label={`${label} used`} />
    </div>
  );
}

/** Status values the API reports for a task that has stopped. Anything else is shown as running. */
const TASK_DONE = new Set(['DONE', 'COMPLETE', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED']);

/**
 * Live card for one run: state, the agents (tasks) with role, state and timings, budget used against reserved,
 * approvals with manual Approve and Reject, the run's panels, findings with their cited numbers, and cancel. Data is the
 * same as the run page (GET /v1/runs/:id, /tasks, /approvals) kept fresh by the workspace stream and a slow poll.
 */
export default function RunCard({ wid, runId, sel, onSelect }: { wid: string; runId: string; sel: Selection; onSelect: (s: Selection) => void }) {
  const qc = useQueryClient();
  const { status: stream } = useStreamStatus(wid);
  const [now, setNow] = useState(() => Date.now());
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelErr, setCancelErr] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const { decide, pendingFor, errorFor } = useDecision(wid);

  const run = useQuery({
    queryKey: ik.run(wid, runId),
    queryFn: () => investigateApi.run(runId),
    refetchInterval: (q) => (q.state.data?.terminal ? false : stream === 'open' ? 4000 : 2000),
    // A run row can appear a moment after the question was accepted.
    retry: (n, e) => e instanceof ApiRequestError && e.status === 404 && n < 10,
    retryDelay: 2000,
  });
  const tasks = useQuery({ queryKey: ik.tasks(wid, runId), queryFn: () => investigateApi.tasks(runId), enabled: run.isSuccess, refetchInterval: () => (run.data?.terminal ? false : 4000) });
  const approvals = useQuery({ queryKey: ik.approvals(wid, runId), queryFn: () => investigateApi.approvals(runId), enabled: run.isSuccess, refetchInterval: () => (run.data?.terminal ? false : 4000) });
  const terminal = !!run.data?.terminal;
  // When the run ends, read the tasks and approvals once more so the card shows their final states.
  const refetchTasks = tasks.refetch;
  const refetchApprovals = approvals.refetch;
  useEffect(() => {
    if (terminal) {
      void refetchTasks();
      void refetchApprovals();
    }
  }, [terminal, refetchTasks, refetchApprovals]);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal]);

  if (run.isPending) return <Skeleton rows={3} />;
  if (run.isError) return <ApiErrorState error={run.error} onRetry={() => run.refetch()} />;
  const rd = run.data;
  const pending = (approvals.data?.approvals ?? []).filter((a) => a.status === 'pending');
  const decided = (approvals.data?.approvals ?? []).filter((a) => a.status !== 'pending');
  const failure = rd.failure as { message?: string; reasonCode?: string } | string | null;
  const failureText = failure ? (typeof failure === 'string' ? failure : (failure.message ?? failure.reasonCode?.replace(/_/g, ' ').toLowerCase() ?? 'The run could not continue.')) : null;
  const panelIds = [...new Set(rd.findings.flatMap((f) => f.panelIds))];

  const doCancel = async () => {
    setCancelling(true);
    setCancelErr(null);
    try {
      try {
        await investigateApi.cancel(runId, rd.version);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 409) await investigateApi.cancel(runId, (await investigateApi.run(runId)).version);
        else throw e;
      }
      setCancelOpen(false);
    } catch (e) {
      setCancelErr(e);
    } finally {
      setCancelling(false);
      void qc.invalidateQueries({ queryKey: ['ws', wid] });
    }
  };

  return (
    <article className="ag-card ag-run" data-testid="agent-run-card" data-run-state={rd.state} data-terminal={terminal ? 'true' : 'false'} aria-label="Investigation run">
      <header>
        <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
          <span className="strong">Investigation run</span>
          <RunStateChip state={rd.state} />
          <Badge outline>{rd.source}</Badge>
          {!terminal && stream !== 'open' && <Badge tone="warn" title="The live stream is not open; this card is polling.">polling</Badge>}
          <span className="grow" />
          <span className="tiny dim mono">updated {formatAge(rd.updatedAt)}</span>
        </div>
        {rd.context?.question && <p className="small dim" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}>{rd.context.question}</p>}
        <div className="row gap2 wrap" style={{ marginTop: 8 }}>
          <Link className="link small" href={`/w/${wid}/runs/${runId}`}>Open the run</Link>
          {!terminal && (
            <Button variant="danger" onClick={() => setCancelOpen(true)} data-testid="agent-cancel-run">
              Cancel run
            </Button>
          )}
        </div>
        {cancelErr != null && <ApiErrorState error={cancelErr} />}
      </header>

      {failureText && (rd.state === 'BLOCKED' || rd.state === 'BLOCKED_SOURCE' || rd.state === 'CANCELLED' || rd.state === 'PARTIAL') && (
        <section>
          {rd.state === 'CANCELLED' ? <Notice tone="warn" title="Cancelled">{failureText}</Notice> : <StateBanner state={rd.state === 'PARTIAL' ? 'partial' : 'source_unavailable'} detail={failureText} />}
        </section>
      )}

      <section aria-label="Agents">
        <p className="ag-k">Agents</p>
        {tasks.isPending ? (
          <p className="small dim">Waiting for the agents to start…</p>
        ) : tasks.isError ? (
          <ApiErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : tasks.data.tasks.length === 0 ? (
          <p className="small dim">No agent tasks reported yet.</p>
        ) : (
          <ol className="ag-tasks" data-testid="agent-tasks">
            {tasks.data.tasks.map((t) => {
              const active = !TASK_DONE.has(t.status) && !terminal;
              return (
                <li key={t.taskId} data-status={t.status} style={{ paddingLeft: Math.min(t.depth, 3) * 12 }}>
                  <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
                    {active ? <Spinner size={12} /> : null}
                    <Badge tone="ink">{t.role}</Badge>
                    <Badge tone={t.status === 'DONE' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'info'}>{t.status.toLowerCase()}</Badge>
                    <span className="grow" />
                    <span className="tiny dim mono" title="Wall time from start to end (or until now while it runs)">{dur(t.startedAt, t.endedAt, now)}</span>
                    <span className="tiny mono" title="Charged to the ledger. A dash means no ledger entry, not zero.">{usd(t.cost.usd)}</span>
                  </div>
                  <div className="tiny dim" style={{ overflowWrap: 'anywhere' }}>{t.objective}</div>
                  {t.toolCalls.length > 0 && <div className="tiny dim mono">{t.toolCalls.map((c) => c.tool).join(' → ')}</div>}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-label="Budget">
        <p className="ag-k">Budget, used of reserved</p>
        {rd.budget ? (
          <div className="ag-meters">
            <Meter label="Tokens" spent={rd.budget.spent.tokens} total={rd.budget.total.tokens} format={(n) => n.toLocaleString('en-US')} />
            <Meter label="Tool calls" spent={rd.budget.spent.toolCalls} total={rd.budget.total.toolCalls} format={(n) => String(n)} />
            <Meter label="Cost" spent={rd.budget.spent.usd} total={rd.budget.total.usd} format={usd} />
            <span className="tiny dim">Held in reserve (not spent): <span className="mono">{usd(rd.budget.reserved.usd)}</span></span>
          </div>
        ) : (
          <p className="small dim">No budget usage is reported for this run yet.</p>
        )}
      </section>

      <section aria-label="Approvals" data-testid="agent-approvals">
        <p className="ag-k">Approvals{pending.length > 0 ? ` (${pending.length} waiting)` : ''}</p>
        {approvals.isError ? (
          <ApiErrorState error={approvals.error} onRetry={() => approvals.refetch()} />
        ) : (approvals.data?.approvals.length ?? 0) === 0 ? (
          <p className="small dim">{rd.state === 'APPROVAL_NEEDED' ? 'The run is at the approval step; the request is not listed yet.' : 'No approval requested.'}</p>
        ) : (
          <div className="col gap2">
            {[...pending, ...decided].map((a) => (
              <ApprovalCard
                key={a.approvalId}
                a={a}
                pending={pendingFor(a.approvalId)}
                error={errorFor(a.approvalId)}
                onDecide={(d) => decide(runId, a, d)}
                context={a.status === 'pending' ? <p className="small dim">Approving applies this canvas change; the panels then appear in the canvas.</p> : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Panels and findings">
        <p className="ag-k">Panels from this run</p>
        {panelIds.length === 0 ? (
          <p className="small dim">{terminal ? 'The run added no panels that a finding cites.' : 'Panels appear in the canvas after the change is approved.'}</p>
        ) : (
          <div className="ag-chips-row">
            {panelIds.map((p) => (
              <button key={p} type="button" className="ag-ref" aria-pressed={sel?.type === 'chart' && sel.id === panelKey(p)} onClick={() => onSelect(toggle(sel, { type: 'chart', id: panelKey(p), findings: rd.findings.filter((f) => f.panelIds.includes(p)).map((f) => runFindingKey(f.id)) }))}>
                panel {p.slice(0, 8)}
              </button>
            ))}
          </div>
        )}
        {rd.interpretation.state === 'unavailable' && (
          <Notice tone="warn" title="Interpretation unavailable">
            No finding could be written about the panels{rd.interpretation.reason ? `: ${rd.interpretation.reason}` : ''}. Open the panels to read their data.
          </Notice>
        )}
        {rd.findings.length > 0 && (
          <div className="ag-findings" style={{ marginTop: 10 }}>
            {rd.findings.map((f) => {
              const key = runFindingKey(f.id);
              const hl = findingHighlighted(sel, key);
              return (
                <div key={f.id} className="ag-runfinding" data-hl={hl ? 'true' : undefined}>
                  <FindingCard f={{ ...f, statement: tidyNumbers(f.statement) }} />
                  {f.panelIds.length > 0 && (
                    <button type="button" className="ag-ref" aria-pressed={hl} onClick={() => onSelect(toggle(sel, { type: 'finding', id: key, charts: f.panelIds.map(panelKey) }))} data-testid="agent-finding-select">
                      {hl ? 'Clear highlight' : `Highlight ${f.panelIds.length} chart${f.panelIds.length === 1 ? '' : 's'}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this run?"
        body="Work already charged stays on the ledger. Nothing further will be applied to the canvas."
        confirmLabel="Cancel run"
        danger
        pending={cancelling}
        onConfirm={() => void doCancel()}
      />
    </article>
  );
}
