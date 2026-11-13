'use client';

import Link from 'next/link';
import { Badge } from '@/components/nx/evidence';
import { Button, Notice, Spinner } from '@/components/nx/ui';
import { STEP_IDS, STEP_LABEL, type PipelineState, type StepStatus } from '@/lib/agent/pipeline';
import { fmtCost } from './answer-card';

const GLYPH: Record<StepStatus, string> = { pending: '', active: '', done: '✓', skipped: '–', failed: '!', stopped: '!', timeout: '…' };
const SR: Record<StepStatus, string> = { pending: 'not started', active: 'in progress', done: 'done', skipped: 'skipped', failed: 'failed', stopped: 'stopped for you', timeout: 'still running' };
const PHASE_TONE = { running: 'info', failed: 'bad', stopped: 'warn', timeout: 'warn', interrupted: 'warn', done: 'ok' } as const;

export function ConsentCard({
  objective,
  onChange,
  onConfirm,
  onCancel,
  busy,
}: {
  objective: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const t = objective.trim();
  return (
    <section className="ag-consent" aria-labelledby="ag-consent-h" data-testid="agent-consent">
      <h3 id="ag-consent-h" className="h3" style={{ margin: 0 }}>
        Create a workspace and run it end to end
      </h3>
      <label className="col gap1">
        <span className="label">Workspace objective (editable)</span>
        <textarea rows={3} maxLength={2000} value={objective} onChange={(e) => onChange(e.target.value)} data-testid="agent-consent-objective" />
      </label>
      <div>
        <p className="small strong" style={{ margin: '0 0 4px' }}>
          One click covers exactly this:
        </p>
        <ul className="small">
          <li>Create a new workspace with the objective above.</li>
          <li>Run the investigation on live data. It reserves up to USD 3 and is charged for what it uses.</li>
          <li>Add the investigation&apos;s charts to that workspace&apos;s canvas, at zero cost (it approves only a canvas patch with a cost limit of 0).</li>
          <li>Add up to 3 markers, up to 3 monitors and one draft hypothesis based on the findings.</li>
        </ul>
        <p className="small" style={{ margin: '8px 0 0' }}>
          It will <strong>not</strong> publish, freeze or approve anything else. If any other approval appears, the pipeline stops and shows it to you.
        </p>
      </div>
      <div className="row gap2 wrap">
        <Button variant="primary" onClick={onConfirm} disabled={!t || busy} disabledReason={busy ? 'Another pipeline is still running.' : 'Write an objective first.'} data-testid="agent-consent-confirm">
          Create workspace and run
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

export function PipelineCard({ p, onResume, onRetry }: { p: PipelineState; onResume: () => void; onRetry: () => void }) {
  const wid = p.workspaceId;
  const base = wid ? `/w/${wid}` : null;
  const active = STEP_IDS.find((s) => p.steps[s].status === 'active');
  const live = active ? `${STEP_LABEL[active]}: ${SR.active}` : p.phase === 'done' ? 'Pipeline finished.' : p.phase === 'failed' ? `Failed: ${p.error?.message ?? ''}` : '';
  return (
    <article className="ag-card" data-testid="agent-pipeline" data-phase={p.phase} aria-label="Workspace pipeline">
      <header>
        <div className="row gap2 wrap">
          <span className="strong">Workspace pipeline</span>
          <Badge tone={PHASE_TONE[p.phase]}>{p.phase}</Badge>
          {p.runState && <Badge outline>run {p.runState.toLowerCase().replace(/_/g, ' ')}</Badge>}
        </div>
        <p className="small dim" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}>
          {p.objective}
        </p>
        <div className="sr-only" role="status" aria-live="polite">
          {live}
        </div>
      </header>
      <section>
        <ol className="ag-pipe-steps">
          {STEP_IDS.map((s) => {
            const st = p.steps[s];
            return (
              <li key={s} data-step={s} data-status={st.status}>
                <span className="ag-mark" data-s={st.status} aria-hidden>
                  {st.status === 'active' ? <Spinner size={12} /> : GLYPH[st.status]}
                </span>
                <div>
                  <div className="small">
                    {STEP_LABEL[s]} <span className="sr-only">: {SR[st.status]}</span>
                  </div>
                  {st.detail && <div className="tiny dim">{st.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {p.phase === 'failed' && p.error && (
        <section>
          <Notice tone="bad" title={`${STEP_LABEL[p.error.step]} failed`}>
            {p.error.message}
          </Notice>
          <div className="row gap2 wrap" style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={onRetry} data-testid="agent-retry">
              Retry from this step
            </Button>
            {base && p.runId && (
              <Link className="link small" href={`${base}/runs/${p.runId}`}>
                Open the run
              </Link>
            )}
          </div>
          <p className="tiny dim" style={{ margin: '6px 0 0' }}>
            Steps that already finished are not repeated.
          </p>
        </section>
      )}
      {p.phase === 'stopped' && p.stoppedOn && (
        <section>
          <Notice tone="warn" title="Stopped: an approval needs your decision">
            {p.stoppedOn.reason}
          </Notice>
          <div className="row gap2 wrap" style={{ marginTop: 10 }}>
            {base && (
              <Link className="btn primary" href={`${base}/approvals`} data-testid="agent-open-approval">
                Open the approval
              </Link>
            )}
            <Button onClick={onRetry}>I decided it, continue</Button>
          </div>
        </section>
      )}
      {p.phase === 'timeout' && (
        <section>
          <Notice tone="warn" title="Still running">
            This took longer than 5 minutes. The run is still going on the server; nothing was cancelled.
          </Notice>
          <div className="row gap2 wrap" style={{ marginTop: 10 }}>
            {base && p.runId && (
              <Link className="btn primary" href={`${base}/runs/${p.runId}`} data-testid="agent-open-run">
                Open the run
              </Link>
            )}
            <Button onClick={onRetry}>Keep waiting</Button>
          </div>
        </section>
      )}
      {p.phase === 'interrupted' && (
        <section>
          <Notice tone="info" title="Paused when the page was closed">
            Resuming continues from the first step that is not done.
          </Notice>
          <div className="row gap2 wrap" style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={onResume} data-testid="agent-resume">
              Resume
            </Button>
            {base && p.runId && (
              <Link className="link small" href={`${base}/runs/${p.runId}`}>
                Open the run
              </Link>
            )}
          </div>
        </section>
      )}

      {p.phase === 'done' && base && p.runId && (
        <section data-testid="agent-pipeline-summary">
          <p className="ag-k">Done</p>
          <div className="ag-links">
            <Link className="link" href={`${base}/overview`} data-testid="agent-link-workspace">Workspace overview</Link>
            <Link className="link" href={`${base}/canvas`}>Canvas</Link>
            <Link className="link" href={`${base}/runs/${p.runId}`}>Run</Link>
            <Link className="link" href={`${base}/markers`}>Markers{p.setup ? ` (${p.setup.markers.length})` : ''}</Link>
            <Link className="link" href={`${base}/monitors`}>Monitors{p.setup ? ` (${p.setup.monitors.length})` : ''}</Link>
            <Link className="link" href={`${base}/hypotheses`}>Hypotheses{p.setup?.hypothesis ? ' (1 draft)' : ''}</Link>
          </div>
          {p.setup && (
            <div className="col gap2" style={{ marginTop: 12 }}>
              {[...p.setup.markers.map((m) => ({ ...m, k: 'marker' })), ...p.setup.monitors.map((m) => ({ ...m, k: 'monitor' })), ...(p.setup.hypothesis ? [{ id: p.setup.hypothesis.id, title: p.setup.hypothesis.title, reason: 'Draft only: not frozen.', k: 'hypothesis' }] : [])].map((m) => (
                <div key={`${m.k}-${m.id}`} className="small">
                  <Badge outline>{m.k}</Badge> <span className="strong">{m.title}</span>
                  {m.reason && <span className="dim"> · {m.reason}</span>}
                </div>
              ))}
              {p.setup.skipped.map((s, i) => (
                <div key={i} className="small dim">
                  Skipped {s.kind}: {s.reason}
                </div>
              ))}
              <span className="tiny dim mono">setup cost {fmtCost(p.setup.cost.usd)}</span>
            </div>
          )}
          {p.findings.length > 0 && (
            <div className="ag-findings" style={{ marginTop: 14 }}>
              <p className="ag-k" style={{ margin: 0 }}>Findings from the run</p>
              {p.findings.map((f, i) => (
                <article key={i} className="ag-finding" data-testid="agent-run-finding">
                  <div className="row gap2 wrap">
                    <Badge>{f.basis}</Badge>
                    <Badge tone={f.status === 'supported' ? 'ok' : f.status === 'mixed' ? 'warn' : ''}>{f.status.replace('_', ' ')}</Badge>
                  </div>
                  <p>{f.statement}</p>
                  <div className="tiny dim">{f.facts} number(s) tied to result cells · {f.skepticNotes} skeptic note(s)</div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  );
}
