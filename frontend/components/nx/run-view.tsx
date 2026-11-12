'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionBar } from './section';
import { Badge } from './evidence';
import { Button, BudgetMeter, Card, EmptyState, KeyValues, Notice, Skeleton } from './ui';
import { ConfirmDialog } from './overlays';
import { ApiErrorState, StateBanner } from './states';
import { ApprovalCard, FindingCard, HashChip, RunStateChip, RunSteps, runLabel, usd } from './run-parts';
import { useStreamStatus, useWorkspaceEvents } from '@/lib/sse/hub';
import type { DomainEvent } from '@/lib/sse/stream';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { qk } from '@/lib/api/keys';
import { formatAge, formatUtc } from '@/lib/format';
import { ik, investigateApi } from '@/lib/investigate/api';
import { useDecision } from '@/lib/investigate/hooks';
import type { RunDetail } from '@/lib/investigate/types';

type PanelStatus = 'QUERYING' | 'READY' | 'ERROR';
type LogRow = { key: string; at: string; type: string; text: string };
type PanelEvt = { panelId: string; status: PanelStatus; index: number; total: number; reasonCode?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

function describe(e: DomainEvent): string {
  const d = e.data;
  switch (e.event) {
    case 'run.state_changed':
      return `Run state: ${runLabel(str(d.state) ?? str(d.to) ?? '')}${d.cancelRequested ? ' (cancel requested)' : ''}`;
    case 'agent.spawned':
      return `Agent started${str(d.role) ? `: ${d.role}` : ''}`;
    case 'task.started':
      return `Task started${str(d.role) ? ` (${d.role})` : ''}${str(d.objective) ? `: ${d.objective}` : ''}`;
    case 'task.completed':
      return `Task finished${str(d.role) ? ` (${d.role})` : ''}${str(d.status) ? `: ${d.status}` : ''}`;
    case 'query.completed':
      return `Panel ${num(d.index) !== null ? Number(d.index) + 1 : ''}${num(d.total) !== null ? ` of ${d.total}` : ''}: ${str(d.status) ?? ''}${str(d.reasonCode) ? ` (${d.reasonCode})` : ''}`;
    case 'finding.created':
      return `Finding ${num(d.index) !== null ? Number(d.index) + 1 : ''}${num(d.total) !== null ? ` of ${d.total}` : ''} written (${str(d.basis) ?? 'finding'}, ${str(d.status) ?? ''})`;
    case 'approval.granted':
      return 'Approval granted';
    case 'approval.rejected':
      return 'Approval rejected';
    case 'canvas.patched':
      return 'Canvas patch applied';
    default:
      return e.event;
  }
}

const RUN_EVENTS = new Set(['run.state_changed', 'agent.spawned', 'task.started', 'task.completed', 'query.completed', 'finding.created', 'approval.granted', 'approval.rejected', 'canvas.patched']);

export default function RunView({ wid, runId }: { wid: string; runId: string }) {
  const qc = useQueryClient();
  const { status: stream } = useStreamStatus(wid);
  const [log, setLog] = useState<LogRow[]>([]);
  const [panelEvt, setPanelEvt] = useState<Record<string, PanelEvt>>({});
  const seen = useRef(new Set<number>());
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelErr, setCancelErr] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);

  const run = useQuery({
    queryKey: ik.run(wid, runId),
    queryFn: () => investigateApi.run(runId),
    // The stream invalidates this query on every run event. The slow poll covers events that happened before the stream
    // connected (it starts at the head), and a stream that is down (faster poll then). It stops at a terminal state.
    refetchInterval: (q) => (q.state.data?.terminal ? false : stream === 'open' ? 4000 : 1500),
  });
  const tasks = useQuery({ queryKey: ik.tasks(wid, runId), queryFn: () => investigateApi.tasks(runId) });
  const approvals = useQuery({ queryKey: ik.approvals(wid, runId), queryFn: () => investigateApi.approvals(runId) });
  const canvas = useQuery({ queryKey: qk.canvas(wid), queryFn: () => browserApi.canvas(wid) });
  const { decide, pendingFor, errorFor } = useDecision(wid);

  const onEvent = useCallback(
    (e: DomainEvent) => {
      if (!RUN_EVENTS.has(e.event)) return;
      const rid = str(e.data.runId);
      // canvas.patched and approvals carry no runId on some paths: keep them, they are workspace-visible context.
      if (rid && rid !== runId) return;
      if (seen.current.has(e.seq)) return;
      seen.current.add(e.seq);
      setLog((l) => [...l, { key: `${e.seq}`, at: new Date().toISOString(), type: e.event, text: describe(e) }].slice(-200));
      if (e.event === 'query.completed') {
        const pid = str(e.data.panelId);
        const st = str(e.data.status) as PanelStatus | null;
        if (pid && st)
          setPanelEvt((p) => ({
            ...p,
            [pid]: { panelId: pid, status: st, index: num(e.data.index) ?? 0, total: num(e.data.total) ?? 0, reasonCode: str(e.data.reasonCode) ?? undefined },
          }));
      }
    },
    [runId],
  );
  useWorkspaceEvents(wid, onEvent);

  // Reset local live state when switching runs.
  useEffect(() => {
    setLog([]);
    setPanelEvt({});
    seen.current.clear();
  }, [runId]);

  const r = run.data;
  const canvasTitles = useMemo(() => new Map((canvas.data?.panels ?? []).map((p) => [p.panelId, p])), [canvas.data]);
  const panelIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(panelEvt));
    for (const f of r?.findings ?? []) for (const p of f.panelIds) ids.add(p);
    return [...ids];
  }, [panelEvt, r?.findings]);

  if (run.isPending) return <Skeleton rows={6} />;
  if (run.isError) return <ApiErrorState error={run.error} onRetry={() => run.refetch()} />;
  const rd = r as RunDetail;

  const doCancel = async () => {
    setCancelling(true);
    setCancelErr(null);
    try {
      try {
        await investigateApi.cancel(runId, rd.version);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 409) {
          const fresh = await investigateApi.run(runId);
          await investigateApi.cancel(runId, fresh.version);
        } else throw e;
      }
      setCancelOpen(false);
    } catch (e) {
      setCancelErr(e);
    } finally {
      setCancelling(false);
      void qc.invalidateQueries({ queryKey: ['ws', wid] });
    }
  };

  const tasksPending = approvals.data?.approvals.filter((a) => a.status === 'pending') ?? [];
  const objective = rd.children.find((c) => c.role === 'composer')?.objective ?? rd.children[0]?.objective ?? rd.rootTask?.objective ?? null;
  const interp = rd.interpretation;
  const failure = rd.failure as { reasonCode?: string; message?: string; retryability?: string; humanActionNeeded?: string | null; replayCommand?: string; lastCheckpoint?: string } | string | null;
  const failureObj = failure && typeof failure === 'object' ? failure : null;
  const failureText = failure ? (typeof failure === 'string' ? failure : (failure.message ?? failure.reasonCode?.replace(/_/g, ' ').toLowerCase() ?? 'The run could not continue.')) : null;
  const rejected = approvals.data?.approvals.some((a) => a.status === 'rejected');

  return (
    <div className="col gap4" data-testid="run-view" data-run-state={rd.state} data-terminal={rd.terminal ? 'true' : 'false'}>
      <div className="row gap3 wrap" style={{ alignItems: 'center' }}>
        <RunStateChip state={rd.state} />
        <Badge outline>{rd.source}</Badge>
        {stream !== 'open' && !rd.terminal && <Badge tone="warn" title="The live stream is not open; this page is polling.">polling</Badge>}
        <span className="grow" />
        <span className="tiny dim mono" title={formatUtc(rd.updatedAt)}>
          updated {formatAge(rd.updatedAt)}
        </span>
        {!rd.terminal && (
          <Button variant="danger" data-testid="cancel-run" onClick={() => setCancelOpen(true)}>
            Cancel run
          </Button>
        )}
      </div>

      <RunSteps state={rd.state} />

      {objective && (
        <p className="small" data-testid="run-objective">
          <span className="label">Planned objective </span>
          {objective}
        </p>
      )}

      {rd.state === 'CANCELLED' && (
        <Notice tone="warn" title={rejected ? 'Cancelled: the canvas change was rejected' : 'Cancelled'}>
          {rejected
            ? 'You rejected the approval, so the run ended and no panels were added by it.'
            : 'The run was cancelled. Nothing further was applied.'}
          {failureText && <div className="tiny mono">{failureText}</div>}
        </Notice>
      )}
      {(rd.state === 'BLOCKED' || rd.state === 'BLOCKED_SOURCE') && (
        <div data-testid="run-blocked">
          <StateBanner
            state="source_unavailable"
            detail={
              <>
                {failureText ?? (rejected ? 'The approval was rejected, so the run is blocked and added no panels.' : 'The run could not continue.')}
                {failureObj?.reasonCode && <span className="mono tiny"> ({failureObj.reasonCode})</span>}
                {failureObj?.retryability && <span className="tiny"> This is {failureObj.retryability}: ask the question again once the source recovers.</span>}
                {failureObj?.humanActionNeeded && <span className="tiny"> Action needed: {failureObj.humanActionNeeded}</span>}
              </>
            }
          />
        </div>
      )}
      {failureObj?.reasonCode && /BUDGET|COST|CAP_/i.test(failureObj.reasonCode) && (
        <div data-testid="run-budget-stop">
          <StateBanner state="budget_exhausted" detail={failureText ?? undefined} />
        </div>
      )}
      {rd.state === 'PARTIAL' && <StateBanner state="partial" detail={failureText ?? undefined} />}
      {cancelErr != null && <ApiErrorState error={cancelErr} />}

      {rd.state === 'APPROVAL_NEEDED' && tasksPending.length === 0 && approvals.isSuccess && (
        <Notice tone="info" title="Waiting for the approval request">
          The run is at the approval step; the request has not been listed yet.
        </Notice>
      )}

      <section aria-label="Approvals">
        <SectionBar title="Approvals" number="001" />
        {approvals.isPending ? (
          <Skeleton rows={3} />
        ) : approvals.isError ? (
          <ApiErrorState error={approvals.error} onRetry={() => approvals.refetch()} />
        ) : approvals.data.approvals.length === 0 ? (
          <EmptyState title="No approval requested" body="A canvas change waits here for a decision before anything is applied." />
        ) : (
          <div className="col gap3">
            {approvals.data.approvals.map((a) => (
              <ApprovalCard
                key={a.approvalId}
                a={a}
                pending={pendingFor(a.approvalId)}
                error={errorFor(a.approvalId)}
                onDecide={(d) => decide(runId, a, d)}
                context={a.status === 'pending' ? <p className="small dim">Approving applies this canvas change. Panels then appear below as each query completes.</p> : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Panels">
        <SectionBar
          title="Panels"
          number="002"
          action={
            <Link className="link small" href={`/w/${wid}/canvas`}>
              Open canvas
            </Link>
          }
        />
        {panelIds.length === 0 ? (
          <EmptyState
            title={rd.terminal ? 'No panels were added by this run' : 'No panels yet'}
            body={rd.terminal ? 'The run ended without adding panels to the canvas.' : 'Panels appear here, one at a time, after the canvas change is approved.'}
          />
        ) : (
          <>
            {(() => {
              const evts = Object.values(panelEvt);
              const total = Math.max(0, ...evts.map((p) => p.total));
              const ready = evts.filter((p) => p.status === 'READY').length;
              return total > 0 ? (
                <p className="small dim" data-testid="panel-progress" aria-live="polite">
                  {ready} of {total} panels ready
                </p>
              ) : null;
            })()}
            <div className="grid c3" data-testid="run-panels">
              {panelIds.map((pid) => {
                const ev = panelEvt[pid];
                const meta = canvasTitles.get(pid);
                const status = (ev?.status ?? (meta ? 'ON_CANVAS' : 'QUERYING')) as PanelStatus | 'ON_CANVAS';
                return (
                  <div key={pid} className="rv-tile" data-testid="run-panel" data-status={status}>
                    <div className="row between gap2">
                      <span className="strong small">{meta?.title ?? 'Panel'}</span>
                      <Badge tone={status === 'READY' || status === 'ON_CANVAS' ? 'ok' : status === 'ERROR' ? 'bad' : 'info'}>
                        {status === 'ON_CANVAS' ? 'on canvas' : status.toLowerCase()}
                      </Badge>
                    </div>
                    {status === 'QUERYING' ? (
                      <Skeleton rows={2} />
                    ) : status === 'ERROR' ? (
                      <span className="small">Refused{ev?.reasonCode ? `: ${ev.reasonCode}` : ''}. Later changes in the patch were not applied.</span>
                    ) : (
                      <span className="tiny dim">{meta?.kind ?? 'panel'}</span>
                    )}
                    <span className="tiny dim mono">{pid}</span>
                    {status !== 'QUERYING' && status !== 'ERROR' && (
                      <Link className="link small" href={`/w/${wid}/panels/${pid}`}>
                        Open panel
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      <section aria-label="Findings">
        <SectionBar title="Findings" number="003" />
        {interp.state === 'unavailable' && (
          <div data-testid="interpretation-unavailable">
            <Notice tone="warn" title="Interpretation unavailable">
              The panels were produced, but no finding could be written about them.
              {interp.reason ? ` Reason: ${interp.reason}.` : ''} Open the panels to read their data directly.
            </Notice>
          </div>
        )}
        {rd.findings.length > 0 ? (
          <div className="col gap3">
            {rd.findings.map((f) => (
              <FindingCard key={f.id} f={f} />
            ))}
          </div>
        ) : interp.state === 'none' || (rd.terminal && interp.state !== 'unavailable') ? (
          <EmptyState title="No findings" body="This run produced no interpretation of its panels." />
        ) : interp.state === 'unavailable' ? null : (
          <EmptyState title="No findings yet" body="Findings are written after the panels are ready." />
        )}
      </section>

      <div className="grid c2">
        <Card title="Budget">
          {rd.budget ? (
            <div className="col gap3">
              <BudgetMeter spentUsd={rd.budget.spent.usd} budgetUsd={rd.budget.total.usd} label="Spent of cap" />
              <KeyValues
                rows={[
                  { k: 'Spent', v: <span className="mono">{usd(rd.budget.spent.usd)}</span> },
                  { k: 'Reserved (held, not spent)', v: <span className="mono">{usd(rd.budget.reserved.usd)}</span> },
                  { k: 'Cap for this run', v: <span className="mono">{usd(rd.budget.total.usd)}</span> },
                  { k: 'Tokens', v: <span className="mono">{rd.budget.spent.tokens.toLocaleString()} / {rd.budget.total.tokens.toLocaleString()}</span> },
                  { k: 'Tool calls', v: <span className="mono">{rd.budget.spent.toolCalls} / {rd.budget.total.toolCalls}</span> },
                ]}
              />
            </div>
          ) : (
            <span className="small dim">No budget usage is reported for this run.</span>
          )}
        </Card>
        <Card title="Replay information" subtitle="What is needed to rerun this question against the same inputs.">
          {rd.context ? (
            <KeyValues
              rows={[
                { k: 'Snapshot', v: <span className="mono">{rd.context.snapshotId}</span> },
                { k: 'Data source', v: <span className="mono">{rd.source}</span> },
                { k: 'Question hash', v: <HashChip value={rd.context.question} label="question hash" /> },
                { k: 'Metric version map', v: <HashChip value={rd.context.metricVersionMap} label="metric version map hash" /> },
                { k: 'Preregistration', v: <span className="mono">{rd.context.preregistrationHash}</span> },
                { k: 'Workflow', v: <span className="mono tiny">{rd.workflowId}</span> },
                ...(failureObj?.replayCommand ? [{ k: 'Replay command', v: <span className="mono tiny" data-testid="replay-command">{failureObj.replayCommand}</span> }] : []),
                ...(failureObj?.lastCheckpoint ? [{ k: 'Last checkpoint', v: <span className="mono tiny">{failureObj.lastCheckpoint}</span> }] : []),
              ]}
            />
          ) : (
            <span className="small dim">No replay context is recorded.</span>
          )}
        </Card>
      </div>

      <section aria-label="Agents and tasks">
        <SectionBar title="Agents and cost per task" number="004" />
        {tasks.isPending ? (
          <Skeleton rows={3} />
        ) : tasks.isError ? (
          <ApiErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : (
          <div className="col gap3" data-testid="task-list">
            {tasks.data.tasks.map((t) => (
              <div key={t.taskId} className="rv-tile" data-testid="task" style={{ marginLeft: t.depth * 16 }}>
                <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
                  <Badge tone="ink">{t.role}</Badge>
                  <Badge tone={t.status === 'DONE' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'info'}>{t.status.toLowerCase()}</Badge>
                  <span className="small grow">{t.objective}</span>
                  <span className="mono small" data-testid="task-cost" title="Charged to the ledger. A dash means no ledger entry, not zero.">
                    {usd(t.cost.usd)}
                  </span>
                </div>
                <div className="row gap4 wrap tiny dim">
                  <span>tokens {t.cost.tokens === null ? '—' : t.cost.tokens.toLocaleString()}</span>
                  <span>reserved {usd(t.cost.reservedUsd)}</span>
                  <span>released {usd(t.cost.releasedUsd)}</span>
                  <span>tool calls {t.toolCalls.length}</span>
                  {t.startedAt && <span title={formatUtc(t.startedAt)}>started {formatAge(t.startedAt)}</span>}
                </div>
                {t.toolCalls.length > 0 && (
                  <ol className="tiny mono" style={{ margin: 0, paddingLeft: 18 }}>
                    {t.toolCalls.map((c) => (
                      <li key={c.n}>{c.tool}</li>
                    ))}
                  </ol>
                )}
                {t.rejectedToolCalls.length > 0 && <Notice tone="warn" title={`${t.rejectedToolCalls.length} tool call(s) refused`}>The kernel refused these calls; they were not executed.</Notice>}
              </div>
            ))}
            <p className="tiny dim">
              Charged to the ledger for this run: <span className="mono">{usd(tasks.data.totals.chargedUsd)}</span> across {tasks.data.totals.tasks} tasks.
            </p>
          </div>
        )}
      </section>

      <section aria-label="Live activity">
        <SectionBar title="Live activity" number="005" />
        {log.length === 0 ? (
          <p className="small dim">
            Events from the live stream appear here while this page is open{stream === 'open' ? '' : ' (the stream is not open right now)'}. Earlier activity is in the
            workspace <Link className="link" href={`/w/${wid}/timeline`}>timeline</Link>.
          </p>
        ) : (
          <ul className="rv-log" data-testid="live-log" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[...log].reverse().map((l) => (
              <li key={l.key} data-event={l.type}>
                <span className="tiny dim mono" style={{ minWidth: 64 }}>
                  {l.at.slice(11, 19)}
                </span>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
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
    </div>
  );
}
