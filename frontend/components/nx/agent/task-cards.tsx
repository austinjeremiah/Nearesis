'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BellRing, Check, Circle, Hourglass, Minus, Loader } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Button } from '@/components/nx/ui';
import { ConfirmDialog } from '@/components/nx/overlays';
import { MutationError } from '@/components/nx/research-kit';
import { openCreditsPopup } from '@/lib/credits/refusal';
import { useStoryboardSync } from './storyboard/sync';
import WorkspaceThesisButtons from '@/components/nx/thesis/workspace-thesis-buttons';
import { useAnnounce, useBringIntoView } from './approval';
import { approvalAnnouncement, approvalNeeded, consentAllowance } from '@/lib/agent/approval';
import { agentApi, agentKeys } from '@/lib/agent/api';
import type { Task, TaskStep } from '@/lib/agent/thread';
import {
  STEP_LABEL,
  TASK_LABEL,
  consentBody,
  consentReady,
  doneCount,
  elapsedSeconds,
  formatElapsed,
  formatEntry,
  formatUsdString,
  nearblocksTx,
  taskThesisId,
  safeHref,
  stepCostText,
  taskCostText,
  costDetailText,
  stepLine,
  taskLive,
} from '@/lib/agent/tasks';

/** One shared clock for every ticking timer on the page: it only runs while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const TONE = { proposed: 'info', running: 'info', waiting_user: 'warn', completed: 'ok', failed: 'bad', cancelled: '' } as const;

function useRefresh(threadId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: agentKeys.thread(threadId) });
    void qc.invalidateQueries({ queryKey: agentKeys.threads });
    void qc.invalidateQueries({ queryKey: ['agent', 'costs'] });
    void qc.invalidateQueries({ queryKey: ['agent', 'credits'] });
  };
}

/* ------------------------------------------------------------------------------------------ plan card */

/** A proposed task: numbered steps, what it may cost, one tick per consent it needs, then Start. */
export function PlanCard({ task }: { task: Task }) {
  const refresh = useRefresh(task.threadId);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const ready = consentReady(task, ticked);
  const start = useMutation({ mutationFn: () => agentApi.start(task.id, consentBody(task, ticked)), onSettled: refresh });
  const proposed = task.state === 'proposed';
  const missing = task.consent.required.filter((c) => !ticked.has(c.key)).length;
  const noConsent = task.consent.required.length === 0;
  const approval = proposed ? approvalNeeded(task, ticked) : null;
  const blockRef = useRef<HTMLElement>(null);
  useBringIntoView(blockRef, task.id, proposed);
  const said = useAnnounce(approvalAnnouncement(approval));
  const toggle = (k: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <article className="ag-plan" data-testid="agent-plan" data-state={task.state} aria-label={`Plan: ${task.title}`}>
      <header className="ag-plan-head">
        <p className="ag-k" style={{ margin: 0 }}>Plan</p>
        <h3 className="ag-plan-title">{task.title}</h3>
        <Badge tone={TONE[task.state]}>{TASK_LABEL[task.state]}</Badge>
      </header>
      <ol className="ag-plan-steps">
        {task.steps.map((s) => (
          <li key={s.idx}>
            <span className="ag-plan-n" aria-hidden="true">{s.idx + 1}</span>
            <div className="ag-plan-body">
              <span className="strong">{s.title}</span>
              {s.detail && <span className="small dim">{s.detail}</span>}
            </div>
          </li>
        ))}
      </ol>
      <dl className="ag-estimates" aria-label="Estimates">
        <div>
          <dt>Proofs and gas, at most</dt>
          <dd className="mono" data-testid="plan-credits">{formatUsdString(task.estimate.creditsMaxUsd)}</dd>
        </div>
        <div>
          <dt>Model cost, at most</dt>
          <dd className="mono" data-testid="plan-usd">{formatUsdString(task.estimate.modelUsdMax)}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd className="mono">{task.steps.length}</dd>
        </div>
      </dl>
      {proposed && (
        <section
          ref={blockRef}
          className="ag-approve"
          data-testid="plan-approval"
          data-approval-task={task.id}
          data-needs={noConsent ? 'start' : ready ? 'start' : 'consent'}
          aria-labelledby={`ag-approve-${task.id}`}
        >
          <header className="ag-approve-head">
            <BellRing size={16} aria-hidden="true" />
            <h4 id={`ag-approve-${task.id}`} className="ag-approve-title">Needs your approval</h4>
            <Badge tone="warn">{noConsent ? 'press Start' : ready ? 'ready to start' : `${missing} to tick`}</Badge>
          </header>
          <p className="ag-approve-line small">{approval?.line}</p>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said}</div>
          {!noConsent && (
            <fieldset className="ag-consents">
              <legend className="sr-only">Permissions this plan needs</legend>
              {task.consent.required.map((c) => (
                <label key={c.key} className="ag-consent-row" data-on={ticked.has(c.key) ? 'true' : undefined}>
                  <input type="checkbox" checked={ticked.has(c.key)} onChange={() => toggle(c.key)} data-testid={`consent-${c.key}`} />
                  <span className="col gap1">
                    <span className="strong small">{c.label}</span>
                    <span className="ag-allow mono tiny" data-testid={c.maxUsd !== null ? 'consent-max' : 'consent-allows'}>{consentAllowance(c)}</span>
                    {c.detail && <span className="small dim">{c.detail}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <footer className="ag-plan-foot" data-attn={ready ? 'true' : undefined}>
            <Button
              variant="primary"
              pending={start.isPending}
              disabled={!ready}
              disabledReason={`Tick ${missing} consent${missing === 1 ? '' : 's'} above to start.`}
              onClick={() => start.mutate()}
              data-testid="plan-start"
            >
              Start
            </Button>
            {!ready && <span className="small dim">Tick {missing} more consent{missing === 1 ? '' : 's'} to start.</span>}
          </footer>
        </section>
      )}
      {start.error != null && (
        <div className="ag-plan-err">
          <MutationError error={start.error} />
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------------------------ live timeline */

function StepIcon({ state }: { state: TaskStep['state'] }) {
  const p = { size: 14, 'aria-hidden': true } as const;
  return (
    <span className="ag-sicon" data-s={state} role="img" aria-label={STEP_LABEL[state]}>
      {state === 'done' ? <Check {...p} /> : state === 'running' ? <Loader {...p} className="ag-spin" /> : state === 'failed' ? <AlertTriangle {...p} /> : state === 'waiting_user' ? <Hourglass {...p} /> : state === 'skipped' ? <Minus {...p} /> : <Circle {...p} />}
    </span>
  );
}

function CostLine({ s }: { s: TaskStep }) {
  const c = stepCostText(s);
  if (!c.hasAny) return null;
  return (
    <div className="ag-scost" data-testid="step-cost">
      <span className="tiny"><span className="label">Model</span> <span className="mono">{c.model}</span>{s.cost.modelCalls !== null && <span className="dim"> · {s.cost.modelCalls} call{s.cost.modelCalls === 1 ? '' : 's'}</span>}</span>
      <span className="tiny"><span className="label">On chain</span> <span className="mono">{c.onChain}</span></span>
      <span className="tiny"><span className="label">Total</span> <span className="mono" data-testid="step-cost-total">{c.total}</span></span>
      {s.cost.entries.map((e, i) => {
        const near = costDetailText(e.detail);
        return (
          <span key={i} className="tiny">
            <span className="dim">{e.label}</span> <span className="mono">{formatEntry(e)}</span>
            {near && <span className="dim"> ({near})</span>}
            {e.txHash && (
              <>
                {' '}
                <a className="link mono" href={nearblocksTx(e.txHash)} target="_blank" rel="noreferrer noopener" title={e.txHash}>
                  tx {e.txHash.slice(0, 8)}
                </a>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

function StepApproval({ task, s }: { task: Task; s: TaskStep }) {
  const refresh = useRefresh(task.threadId);
  const w = s.waiting;
  const decide = useMutation({ mutationFn: (d: 'approve' | 'reject') => agentApi.approval(task.id, s.idx, d), onSettled: refresh });
  const [reject, setReject] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useBringIntoView(boxRef, `${task.id}:${s.idx}`, !!w);
  const said = useAnnounce(w ? approvalAnnouncement(approvalNeeded(task)) : '');
  if (!w) return null;
  const limit = w.costLimit === null ? 'unknown' : /^\d+(\.\d+)?$/.test(w.costLimit) ? formatUsdString(w.costLimit) : w.costLimit;
  return (
    <div ref={boxRef} className="ag-approval" data-attn="true" data-testid="step-approval" data-approval-task={task.id} role="group" aria-label="Approval needed">
      <div className="ag-approve-head">
        <BellRing size={16} aria-hidden="true" />
        <strong className="ag-approve-title">The agent is waiting for you</strong>
      </div>
      <p className="small" style={{ margin: 0 }}>Approve to let it continue, or reject to stop the task at this step.</p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said}</div>
      <div className="row gap2 wrap">
        <Badge tone="warn">approval</Badge>
        <span className="mono small">{w.approvalKind}</span>
      </div>
      <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }}>{w.summary}</p>
      <p className="tiny" style={{ margin: 0 }}><span className="label">Cost limit</span> <span className="mono">{limit}</span></p>
      <div className="row gap2 wrap">
        <Button variant="primary" pending={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} disabledReason="A decision is being sent." onClick={() => decide.mutate('approve')} data-testid="step-approve">Approve</Button>
        <Button variant="danger" pending={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} disabledReason="A decision is being sent." onClick={() => setReject(true)} data-testid="step-reject">Reject</Button>
        {w.runId && <Link className="link small" href={task.workspaceId ? `/w/${task.workspaceId}/runs/${w.runId}` : '#'}>Open the run</Link>}
      </div>
      <MutationError error={decide.error} />
      <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject this approval?" body="The task stops at this step. Nothing it would have applied is applied." confirmLabel="Reject" danger pending={decide.isPending} onConfirm={() => (setReject(false), decide.mutate('reject'))} />
    </div>
  );
}

function StepRow({ task, s, now }: { task: Task; s: TaskStep; now: number }) {
  const refresh = useRefresh(task.threadId);
  const retry = useMutation({ mutationFn: () => agentApi.retry(task.id), onSettled: refresh });
  const running = s.state === 'running';
  const sec = elapsedSeconds(s.startedAt, now, running || s.state === 'waiting_user' ? null : s.finishedAt);
  const sync = useStoryboardSync();
  const shown = !!sync?.activeStepIdxs.includes(s.idx);
  return (
    <li className="ag-step" data-s={s.state} data-shown={shown ? 'true' : undefined} data-testid="task-step" aria-current={running || s.state === 'waiting_user' ? 'step' : undefined}>
      <StepIcon state={s.state} />
      <div className="ag-step-body">
        <div className="row gap2 wrap" style={{ alignItems: 'baseline' }}>
          <span className="tiny mono dim">{s.idx + 1}.</span>
          {sync ? (
            <button type="button" className="strong ag-step-title ag-step-link" onClick={() => sync.onStepClick(s.idx)} title="Show this step in the storyboard" aria-pressed={shown}>{s.title}</button>
          ) : (
            <span className="strong ag-step-title">{s.title}</span>
          )}
          <span className="ag-step-state">{STEP_LABEL[s.state]}</span>
          <span className="grow" />
          {(running || s.state === 'waiting_user' || s.state === 'done' || s.state === 'failed') && s.startedAt && (
            <span className="tiny mono dim" data-testid="step-elapsed" title={running ? 'Time since this step started' : 'How long this step took'}>{formatElapsed(sec)}</span>
          )}
        </div>
        {(running || s.state === 'pending') && s.detail && <p className="small dim ag-step-detail">{s.detail}</p>}
        {running && (
          <p className="ag-progress" data-testid="step-progress">
            <span className="ag-pulse" aria-hidden="true" />
            <span>{s.progress ?? 'Working…'}</span>
          </p>
        )}
        {s.state === 'waiting_user' && <StepApproval task={task} s={s} />}
        {s.state === 'done' && s.result && (
          <div className="ag-sresult" data-testid="step-result">
            {s.result.summary && <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }}>{s.result.summary}</p>}
            {s.result.items.length > 0 && (
              <ul className="ag-ritems">
                {s.result.items.map((i, k) => {
                  const href = safeHref(i.href);
                  return (
                    <li key={k}>
                      <span className="dim">{i.label}</span>{' '}
                      {href ? <Link className="link mono" href={href}>{i.value || 'open'}</Link> : <span className="mono">{i.value}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {s.state === 'failed' && s.error && (
          <div className="ag-serr" role="alert" data-testid="step-error">
            <span className="mono small strong">{s.error.reasonCode}</span>
            <span className="small" style={{ overflowWrap: 'anywhere' }}>{s.error.message}</span>
            {s.error.reasonCode === 'CREDITS_EXHAUSTED' && (
              <div>
                <Button variant="primary" onClick={() => openCreditsPopup()} data-testid="step-credits-request">Request more credits</Button>
              </div>
            )}
            {s.error.retryable && task.state === 'failed' && (
              <div>
                <Button variant="primary" pending={retry.isPending} onClick={() => retry.mutate()} data-testid="step-retry">Retry from this step</Button>
              </div>
            )}
            <MutationError error={retry.error} />
          </div>
        )}
        {s.state === 'skipped' && s.result?.summary && <p className="small dim ag-step-detail">{s.result.summary}</p>}
        {s.state !== 'pending' && <CostLine s={s} />}
      </div>
    </li>
  );
}

/** The task as it runs: every step with its state, the running one prominent, plus cancel and the final links. */
export function TaskTimeline({ task }: { task: Task }) {
  const refresh = useRefresh(task.threadId);
  const live = taskLive(task);
  const now = useNow(live);
  const [confirm, setConfirm] = useState(false);
  const cancel = useMutation({ mutationFn: () => agentApi.cancel(task.id), onSettled: refresh, onSuccess: () => setConfirm(false) });
  const line = useMemo(() => stepLine(task), [task]);
  const total = task.steps.length;
  const done = doneCount(task);
  const announced = useRef<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Announce a change of step (not every progress tick) to screen readers.
  const cur = task.steps.find((s) => s.state === 'running' || s.state === 'waiting_user');
  const curKey = cur ? `${cur.idx}:${cur.state}` : `${task.state}`;
  useEffect(() => {
    if (announced.current === curKey) return;
    announced.current = curKey;
    setAnnounce(cur ? `Step ${cur.idx + 1} of ${total}: ${cur.title}${cur.state === 'waiting_user' ? ', waiting for your approval' : ''}` : `Task ${TASK_LABEL[task.state].toLowerCase()}`);
  }, [curKey, cur, total, task.state]);
  const wid = task.links.workspaceId ?? task.workspaceId;
  const tc = taskCostText(task);
  const thesisId = taskThesisId(task);
  return (
    <article className="ag-timeline" data-testid="agent-task" data-state={task.state} aria-label={`Task: ${task.title}`}>
      <header className="ag-tl-head">
        <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
          <h3 className="ag-plan-title">{task.title}</h3>
          <Badge tone={TONE[task.state]}>{TASK_LABEL[task.state]}</Badge>
          <span className="grow" />
          {live && (
            <Button variant="danger" onClick={() => setConfirm(true)} data-testid="task-cancel">Cancel task</Button>
          )}
        </div>
        <div className="ag-tl-meter" aria-hidden="true">
          <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <p className="small" style={{ margin: 0 }} data-testid="task-line">
          {line ?? `${done} of ${total} steps done`}
        </p>
        <p className="tiny dim" style={{ margin: 0 }}>
          {live ? 'Started' : task.finishedAt ? 'Took' : 'Started'}{' '}
          <span className="mono">{formatElapsed(elapsedSeconds(task.startedAt, now, live ? null : task.finishedAt))}</span>
          {' · model '}<span className="mono">{tc.model}</span>
          {' · on chain '}<span className="mono">{tc.onChain}</span>
          {' · total '}<span className="mono" data-testid="task-cost-total">{tc.total}</span>
          {tc.held && <> {' · held '}<span className="mono">{tc.held}</span></>}
        </p>
      </header>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <ol className="ag-steps" aria-label="Task steps">
        {task.steps.map((s) => (
          <StepRow key={s.idx} task={task} s={s} now={now} />
        ))}
      </ol>
      {wid && task.state !== 'proposed' && (
        <footer className="ag-tl-foot">
          {task.state === 'completed' && <Badge tone="ok">finished</Badge>}
          {(thesisId || !live) && <WorkspaceThesisButtons wid={wid} thesisId={thesisId} />}
          <Link className="link small" href={`/w/${wid}/overview`}>Open workspace</Link>
        </footer>
      )}
      <MutationError error={cancel.error} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel this task?"
        body="The running step is stopped and any credits held for it are released. Steps already finished stay as they are and what they cost stays on the ledger."
        confirmLabel="Cancel task"
        danger
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </article>
  );
}
