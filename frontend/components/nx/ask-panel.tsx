'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUp, Square, X } from 'lucide-react';
import { Badge, RunStatus } from './evidence';
import { Button, IconButton, KeyValues, Notice } from './ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc } from '@/lib/format';

/**
 * The agent side panel.
 *
 * A docked column rather than a floating window, so a question can be asked
 * while the canvas, a panel or the evidence graph stays on screen and keeps its
 * selection. The full Investigate screen is still the place for a long run; this
 * is the place to start one and watch it.
 *
 * What it will not do: spawn work. Spec 5.6 is explicit that the prompt alone
 * never starts an agent, so submitting produces a side-effect-free plan and the
 * run itself waits for an authorized approval. Nothing here simulates agent
 * output either, so the progression below is the recorded run, not an animation.
 */

const TOKEN_CAP = 200_000;
const CALL_CAP = 24;

export function AskPanel({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string | null;
  workspaceName?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState<string | null>(null);

  const run = useMemo(() => {
    if (!workspaceId) return undefined;
    return db.activeRun(workspaceId) ?? db.runs(workspaceId)[0];
  }, [workspaceId]);

  const ws = workspaceId ? db.workspace(workspaceId) : undefined;
  const costCap = ws?.budgetUsd ?? 10;
  const spent = run?.spentUsd ?? 0;
  const toolCalls = run?.tasks.reduce((a, t) => a + t.toolCalls.length, 0) ?? 0;

  const measures = useMemo(() => {
    if (!workspaceId) return [];
    return [...new Set(db.panels(workspaceId).flatMap((p) => p.metricIds))].slice(0, 4);
  }, [workspaceId]);

  return (
    <aside className="askpanel" aria-label="Agent panel">
      <header className="ask-head">
        <span className="label">Ask</span>
        {workspaceName && <span className="tiny dim ellipsis">{workspaceName}</span>}
        <div className="grow" />
        <IconButton label="Close the agent panel" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="ask-body">
        {!workspaceId && (
          <Notice tone="info" title="Open a workspace to ask">
            A question is scoped to one workspace, because its budget, sources and evidence belong
            to that workspace rather than to the account.
          </Notice>
        )}

        {asked && (
          <>
            <div className="ask-bubble">{asked}</div>

            <section className="card">
              <header className="card-head">
                <div className="grow">
                  <div className="h3" style={{ fontSize: 14 }}>Proposed plan</div>
                  <div className="small dim">Nothing has run. This is a preview.</div>
                </div>
                <Badge tone="warn">Awaiting approval</Badge>
              </header>
              <div className="card-body">
                <KeyValues
                  rows={[
                    {
                      k: 'Agents',
                      v: <span className="small">director, scout, quant, skeptic, composer, auditor</span>,
                    },
                    {
                      k: 'Measures it would query',
                      v: measures.length ? (
                        measures.map((m) => (
                          <div key={m} className="mono tiny">
                            {m}
                          </div>
                        ))
                      ) : (
                        <span className="unavailable" />
                      ),
                    },
                    { k: 'Snapshot', v: <span className="mono">{ws?.snapshotId ?? '—'}</span> },
                    { k: 'Cost ceiling', v: <span className="mono">{formatUsd(costCap)}</span> },
                    { k: 'Writes', v: <span className="small">none without a separate approval</span> },
                  ]}
                />
                <div className="row gap2 wrap">
                  <Button
                    variant="primary"
                    disabled
                    disabledReason="Starting a run needs the authorized API and an approval bound to this plan."
                  >
                    Approve and run
                  </Button>
                  <Button onClick={() => setAsked(null)}>Edit scope</Button>
                </div>
                <p className="tiny dim">
                  The question text is sent to the planner only when you approve. No query is
                  issued, no budget is spent and no agent exists until then.
                </p>
              </div>
            </section>
          </>
        )}

        {run && (
          <section className="card">
            <header className="card-head">
              <div className="grow col gap1" style={{ minWidth: 0 }}>
                <div className="row gap2 wrap">
                  <RunStatus state={run.state} />
                  <span className="tiny dim mono">{run.id}</span>
                </div>
                <span className="small ellipsis" title={run.question}>
                  {run.question}
                </span>
              </div>
              {run.state === 'running' && (
                <Button disabled disabledReason="Cancelling a run needs the authorized API.">
                  <Square size={12} />
                  Cancel
                </Button>
              )}
            </header>

            <div className="card-body">
              <ol className="ask-steps">
                {run.tasks.map((t) => (
                  <li key={t.id} data-state={t.state}>
                    <span className="dotmark" aria-hidden="true" />
                    <div className="col gap1" style={{ minWidth: 0 }}>
                      <span className="small strong">{t.role}</span>
                      <span className="tiny dim">{t.label}</span>
                      {t.toolCalls.slice(0, 2).map((c, i) => (
                        <span key={i} className="tiny dim mono ellipsis">
                          {c.tool} · {c.detail}
                        </span>
                      ))}
                    </div>
                    <span className="tiny dim mono">{formatUsd(t.costUsd)}</span>
                  </li>
                ))}
              </ol>

              <div className="col gap2">
                <Meter label="Tokens" value={0} cap={TOKEN_CAP} display={`0 / ${TOKEN_CAP.toLocaleString('en-US')}`} />
                <Meter label="Tool calls" value={toolCalls} cap={CALL_CAP} display={`${toolCalls} / ${CALL_CAP}`} />
                <Meter
                  label="Cost"
                  value={spent}
                  cap={costCap}
                  display={`${formatUsd(spent)} / ${formatUsd(costCap)}`}
                />
              </div>

              <p className="tiny dim">
                Token usage is recorded by the kernel and is unavailable on fixture data. It is
                shown as zero because nothing has been spent, not as an estimate.
              </p>

              <div className="row gap2 wrap">
                <Link className="link small" href={`/w/${workspaceId}/runs/${run.id}`}>
                  Open full run
                </Link>
                <Link className="link small" href={`/w/${workspaceId}/investigate`}>
                  Open investigate
                </Link>
              </div>
            </div>
          </section>
        )}

        {!asked && !run && workspaceId && (
          <p className="small dim">
            Ask a question about this workspace. You will see the plan, its cost and the measures it
            would read before anything runs.
          </p>
        )}

        {run && (
          <p className="tiny dim">
            Started {formatUtc(run.startedAt)}. Recorded from the run ledger, not replayed.
          </p>
        )}
      </div>

      <form
        className="ask-foot"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length < 6) return;
          setAsked(draft.trim());
          setDraft('');
        }}
      >
        <textarea
          className="textarea"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={workspaceId ? 'Ask a question about this workspace' : 'Open a workspace to ask'}
          aria-label="Ask a research question"
          disabled={!workspaceId}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="row gap2" style={{ alignItems: 'center' }}>
          <span className="tiny dim">
            {TOKEN_CAP.toLocaleString('en-US')} tokens · {CALL_CAP} calls · {formatUsd(costCap)} cap
          </span>
          <div className="grow" />
          <Button type="submit" variant="primary" disabled={draft.trim().length < 6} disabledReason="Write the question first.">
            <ArrowUp size={13} />
            Ask
          </Button>
        </div>
      </form>
    </aside>
  );
}

function Meter({
  label,
  value,
  cap,
  display,
}: {
  label: string;
  value: number;
  cap: number;
  display: string;
}) {
  const ratio = cap > 0 ? Math.min(1, value / cap) : 0;
  return (
    <div className="row gap3" style={{ alignItems: 'center' }}>
      <span className="tiny dim" style={{ width: 70 }}>
        {label}
      </span>
      <div className="meter grow" role="progressbar" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={value} aria-label={`${label}: ${display}`}>
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="tiny mono">{display}</span>
    </div>
  );
}
