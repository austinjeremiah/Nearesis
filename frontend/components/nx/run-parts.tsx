'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge } from './evidence';
import { Button, Notice } from './ui';
import { ConfirmDialog } from './overlays';
import { StateBanner } from './states';
import { ApiRequestError } from '@/lib/api/errors';
import { formatAge, formatUtc } from '@/lib/format';
import { usd } from '@/lib/investigate/format';
import type { ApprovalRow, Basis, Finding, FindingStatus, RunStateName } from '@/lib/investigate/types';
import './run.css';

/* ------------------------------------------------------------------ run state */

export const RUN_PIPELINE = ['REQUESTED', 'PLANNING', 'APPROVAL_NEEDED', 'EXECUTING', 'EVIDENCE_REVIEW', 'CANVAS_PATCH_REVIEW', 'COMPLETE'] as const;

const RUN_LABEL: Record<string, string> = {
  REQUESTED: 'Requested',
  PLANNING: 'Planning',
  APPROVAL_NEEDED: 'Approval needed',
  EXECUTING: 'Executing',
  EVIDENCE_REVIEW: 'Evidence review',
  CANVAS_PATCH_REVIEW: 'Canvas patch review',
  COMPLETE: 'Complete',
  PARTIAL: 'Partial',
  BLOCKED: 'Blocked',
  BLOCKED_SOURCE: 'Source unavailable',
  CANCELLED: 'Cancelled',
};
export const runLabel = (s: string) => RUN_LABEL[s] ?? 'Unknown state';

export function RunStateChip({ state }: { state: RunStateName }) {
  const tone = state === 'COMPLETE' ? 'ok' : state === 'APPROVAL_NEEDED' ? 'warn' : state === 'PARTIAL' ? 'warn' : state === 'BLOCKED' || state === 'BLOCKED_SOURCE' ? 'bad' : state === 'CANCELLED' ? '' : 'info';
  return (
    <span data-testid="run-state" data-state={state}>
      <Badge tone={tone}>{runLabel(state)}</Badge>
    </span>
  );
}

/** Where the run is on its way to COMPLETE, and how it ended when it ended some other way. */
export function RunSteps({ state }: { state: RunStateName }) {
  const idx = RUN_PIPELINE.indexOf(state as (typeof RUN_PIPELINE)[number]);
  const ended = idx < 0;
  return (
    <ol className="rv-steps" aria-label="Run progress" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {RUN_PIPELINE.map((s, i) => (
        <li
          key={s}
          className="rv-step"
          data-done={!ended && i < idx ? 'true' : 'false'}
          data-current={!ended && i === idx ? 'true' : 'false'}
          aria-current={!ended && i === idx ? 'step' : undefined}
        >
          {runLabel(s)}
        </li>
      ))}
      {ended && (
        <li className="rv-step" data-end={state === 'PARTIAL' ? 'warn' : state === 'CANCELLED' ? 'warn' : 'bad'} aria-current="step">
          {runLabel(state)}
        </li>
      )}
    </ol>
  );
}

/* ------------------------------------------------------------------ money */

export { usd } from '@/lib/investigate/format';

/* ------------------------------------------------------------------ hash */

export function HashChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="row gap2 wrap" style={{ alignItems: 'center' }}>
      <span className="rv-hash" data-testid="action-hash" title={value}>
        {value}
      </span>
      <button
        type="button"
        className="btn ghost"
        aria-label={`Copy ${label ?? 'hash'}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ findings */

const STATUS_TONE: Record<FindingStatus, 'ok' | 'warn' | 'bad' | 'info' | ''> = {
  supported: 'ok',
  contradicted: 'bad',
  mixed: 'warn',
  insufficient_data: 'info',
  cannot_compute: 'info',
  unverified: 'warn',
};

export function BasisLabel({ basis }: { basis: Basis }) {
  return basis === 'observation' ? (
    <Badge tone="ink" title="Read directly from the result rows.">
      Observation
    </Badge>
  ) : (
    <Badge outline title="A reading drawn from the rows, not stated in them.">
      Inference
    </Badge>
  );
}

export function FindingCard({ f }: { f: Finding }) {
  const noData = f.status === 'cannot_compute' || f.status === 'insufficient_data';
  return (
    <article className="rv-finding" data-testid="finding" data-status={f.status} data-basis={f.basis} aria-label="Finding">
      <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
        <span data-testid="finding-basis">
          <BasisLabel basis={f.basis} />
        </span>
        <span data-testid="finding-status">
          <Badge tone={STATUS_TONE[f.status] ?? ''}>{f.status.replace(/_/g, ' ')}</Badge>
        </span>
        <Badge outline>{f.kind}</Badge>
        <span className="tiny dim">by {f.agentRole}</span>
        <span className="grow" />
        <span className="tiny dim mono" title={formatUtc(f.createdAt)}>
          {formatAge(f.createdAt)}
        </span>
      </div>
      {noData && (
        <StateBanner
          state="insufficient_data"
          detail="The panels cannot support this question as asked. Nothing has been filled in."
        />
      )}
      <p className="strong" style={{ margin: 0 }} data-testid="finding-statement">
        {f.statement}
      </p>
      {f.facts.length > 0 && (
        <div className="col gap1">
          <span className="label">Numbers, each tied to a result row</span>
          <ul>
            {f.facts.map((x, i) => (
              <li key={i}>
                <span className="mono strong">
                  {x.value} {x.unit}
                </span>{' '}
                <span className="tiny dim mono" title={`query ${x.resultRef.queryHash} · ${x.resultRef.semanticVersion} · column ${x.resultRef.column}`}>
                  {x.resultRef.column} · {x.resultRef.rowIds.length} row{x.resultRef.rowIds.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {f.limitations.length > 0 && (
        <div className="col gap1" data-testid="finding-limitations">
          <span className="label">Limitations</span>
          <ul>
            {f.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="col gap1" data-testid="finding-skeptic">
        <span className="label">Skeptic notes</span>
        {f.skepticDegraded && (
          <Notice tone="warn" title="Skeptic review degraded">
            The skeptic could not complete a full review of this finding. Read the notes below as partial.
          </Notice>
        )}
        {f.skepticNotes.length > 0 ? (
          <ul>
            {f.skepticNotes.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <span className="small dim">No skeptic notes were recorded.</span>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ approvals */

export function decisionErrorText(e: unknown): { title: string; body: string } {
  if (e instanceof ApiRequestError) {
    if (e.status === 409)
      return {
        title: 'This approval changed',
        body: `${e.message} It was already decided, or the action it names is different now. The list below has been reloaded; check it before deciding again.`,
      };
    return { title: 'The decision was not recorded', body: e.message };
  }
  return { title: 'The decision was not recorded', body: e instanceof Error ? e.message : 'Unknown error.' };
}

/**
 * One approval. The action hash shown is the exact value sent with the decision:
 * the API refuses a decision whose hash no longer matches the pending action.
 */
export function ApprovalCard({
  a,
  context,
  onDecide,
  pending,
  error,
}: {
  a: ApprovalRow;
  context?: ReactNode;
  onDecide: (decision: 'approve' | 'reject') => void;
  pending: 'approve' | 'reject' | null;
  error?: unknown;
}) {
  const [rejecting, setRejecting] = useState(false);
  const isPending = a.status === 'pending';
  const err = error ? decisionErrorText(error) : null;
  return (
    <article className="rv-approval" data-testid="approval" data-status={a.status} aria-label={`Approval ${a.approvalId}`}>
      <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
        <Badge tone={isPending ? 'warn' : a.status === 'approved' ? 'ok' : 'bad'}>{a.status}</Badge>
        <span className="strong small mono">{a.kind}</span>
        <Badge outline>{a.network}</Badge>
        <span className="grow" />
        <span className="tiny dim mono" title={formatUtc(a.requestedAt)}>
          requested {formatAge(a.requestedAt)}
        </span>
      </div>
      {context}
      <div className="col gap1">
        <span className="label">Action hash (the decision binds to exactly this action)</span>
        <HashChip value={a.actionHash} label="action hash" />
      </div>
      <div className="row gap4 wrap">
        <div className="col">
          <span className="label">Cost limit</span>
          <span className="mono" data-testid="cost-limit">
            {usd(a.costLimit)}
          </span>
        </div>
        <div className="col">
          <span className="label">Network</span>
          <span className="mono">{a.network}</span>
        </div>
        {a.decidedAt && (
          <div className="col">
            <span className="label">Decided</span>
            <span className="mono small" title={formatUtc(a.decidedAt)}>
              {formatAge(a.decidedAt)}
            </span>
          </div>
        )}
      </div>
      {err && (
        <Notice tone="bad" title={err.title}>
          {err.body}
        </Notice>
      )}
      {isPending && (
        <div className="row gap2">
          <Button variant="primary" data-testid="approve" pending={pending === 'approve'} disabled={pending !== null} disabledReason="A decision is being sent." onClick={() => onDecide('approve')}>
            Approve
          </Button>
          <Button variant="danger" data-testid="reject" pending={pending === 'reject'} disabled={pending !== null} disabledReason="A decision is being sent." onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this action?"
        body="The run will not apply this canvas change. No panels will be added by it."
        confirmLabel="Reject"
        danger
        pending={pending === 'reject'}
        onConfirm={() => {
          setRejecting(false);
          onDecide('reject');
        }}
      />
    </article>
  );
}

export function RunLink({ wid, runId, children }: { wid: string; runId: string; children: ReactNode }) {
  return (
    <Link className="link" href={`/w/${wid}/runs/${runId}`}>
      {children}
    </Link>
  );
}
