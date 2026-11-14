'use client';

import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { RunStateChip, RUN_PIPELINE, runLabel } from '@/components/nx/run-parts';
import { PanelBody, PanelFrame, layoutHeight } from '@/components/nx/panel';
import { Skeleton } from '@/components/nx/ui';
import { formatAge, formatUtc, shortHash } from '@/lib/format';
import { usePanelProgress } from '@/lib/panel/hooks';
import { usePanelData } from '@/lib/panel/hooks';
import type { CanvasMarker, CanvasPanel } from '@/lib/panel/types';
import type { Finding, RunDetail } from '@/lib/investigate/types';
import type { Marker, MonitorRule, MonitorEvaluation } from '@/lib/research/api';
import { usd } from '@/lib/investigate/format';
import { panelKey } from '@/lib/agent/selection';
import { FINDING_STATUS_LABEL, FINDING_STATUS_TONE, createdWithin, emphasiseNumbers, markerAt, markerTitle, metricIdsOf, metricWords, monitorSentence, quotedText, thresholdOf, type Stage } from '@/lib/agent/storyboard';
import { panelForMetric, seriesOf } from '@/lib/agent/storyboard-series';
import { MiniSeries, SbCard } from './parts';
import { useCanvasDoc, useEvaluationList, useHypothesisList, useMarkerList, useOnChange, useRuleList, useRunDoc, useRunTasks, useTriggerList, useWorkspaceDoc } from './data';

export type Hl = { id: string | null; hover: (id: string | null) => void; pin: (id: string) => void };

const longDate = (iso: string | null) => {
  if (!iso) return 'unknown date';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(t) : 'unknown date';
};

/** Each stage with no id to show says so plainly instead of leaving a gap. */
function Unknown({ what }: { what: string }) {
  return <p className="sb-note">{what}: unknown. The agent did not report an id for it.</p>;
}

function Num({ text }: { text: string }) {
  return (
    <>
      {emphasiseNumbers(text).map((p, i) => (p.num ? <b key={i} className="sb-num">{p.text}</b> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ 1. workspace */

export function WorkspaceArtifact({ wid, objectiveFallback }: { wid: string | null; objectiveFallback?: string | null }) {
  const q = useWorkspaceDoc(wid);
  if (!wid) return <Unknown what="Workspace" />;
  if (q.isPending) return <SbCard><Skeleton rows={2} /></SbCard>;
  const w = q.data;
  const objective = w?.objective ?? objectiveFallback ?? null;
  return (
    <SbCard
      testId="sb-workspace"
      label="Workspace"
      title="Objective"
      badges={w?.archivedAt ? <Badge>archived</Badge> : <Badge outline>{w?.networkScope ?? 'scope unknown'}</Badge>}
      tools={<Link className="sb-link" href={`/w/${wid}/overview`}>Open workspace</Link>}
      foot={
        <>
          <span className="mono">created {w ? formatUtc(w.createdAt) : 'unknown'}</span>
          <span className="mono" title={wid}>workspace {shortHash(wid, 8, 4)}</span>
        </>
      }
    >
      <p className="sb-lead">{objective ?? 'The objective is unknown.'}</p>
    </SbCard>
  );
}

/* ------------------------------------------------------------------------------------------------ 2. investigation */

function RunSteps({ run }: { run: RunDetail }) {
  const idx = RUN_PIPELINE.indexOf(run.state as (typeof RUN_PIPELINE)[number]);
  const ended = idx < 0;
  return (
    <ol className="sb-runsteps" aria-label="Run progress">
      {RUN_PIPELINE.map((s, i) => (
        <li key={s} data-done={!ended && i < idx ? 'true' : run.state === 'COMPLETE' ? 'true' : undefined} data-current={!ended && i === idx && run.state !== 'COMPLETE' ? 'true' : undefined}>
          <span aria-hidden="true" />
          {runLabel(s)}
        </li>
      ))}
    </ol>
  );
}

const TASK_DONE = new Set(['DONE', 'COMPLETE', 'COMPLETED']);

export function usePanelsOfRun(wid: string | null, run: RunDetail | undefined, live: boolean) {
  const canvas = useCanvasDoc(wid, live);
  const cited = useMemo(() => new Set((run?.findings ?? []).flatMap((f) => f.panelIds)), [run]);
  const panels = (canvas.data?.panels ?? []).filter((p) => cited.has(p.panelId));
  return { canvas, panels, cited };
}

export function InvestigationArtifact({ wid, stage, hl, live }: { wid: string | null; stage: Stage; hl: Hl; live: boolean }) {
  const runId = stage.refs.runId ?? null;
  const working = stage.state === 'working';
  const run = useRunDoc(wid, runId, working);
  const tasks = useRunTasks(wid, runId, working && !run.data?.terminal, true);
  const progress = usePanelProgress(wid ?? '');
  const { canvas, panels } = usePanelsOfRun(wid, run.data, live || working);
  useOnChange(stage.state, () => {
    void run.refetch();
    void tasks.refetch();
    void canvas.refetch();
  });
  const question = tasks.data?.tasks.find((t) => t.role === 'composer')?.objective ?? quotedText(stage.steps.find((s) => s.key === 'question.ask')?.detail) ?? null;
  if (!runId) return working ? <SbCard><p className="sb-note">The investigation is being started.</p></SbCard> : <SbCard><Unknown what="Investigation run" /></SbCard>;
  if (run.isPending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (run.isError) return <ApiErrorState error={run.error} onRetry={() => run.refetch()} />;
  const rd = run.data;
  const rows = tasks.data?.tasks ?? [];
  const doneN = rows.filter((t) => TASK_DONE.has(t.status.toUpperCase())).length;
  const spent = rd.budget?.spent.usd;
  const markers = canvas.data?.markers ?? [];
  return (
    <div className="sb-stack">
      <SbCard
        testId="sb-run"
        label="Investigation run"
        title={question ?? 'The question is unknown'}
        badges={
          <>
            <RunStateChip state={rd.state} />
            <Badge outline>{rd.source}</Badge>
          </>
        }
        tools={wid ? <Link className="sb-link" href={`/w/${wid}/investigate?run=${runId}`}>Open the run</Link> : null}
        foot={
          <>
            <span className="mono">{rows.length ? `${doneN} of ${rows.length} agents done` : 'agents: unknown'}</span>
            <span className="mono">spent {typeof spent === 'number' ? usd(spent) : 'unknown'}</span>
            <span className="mono">updated {formatAge(rd.updatedAt)}</span>
          </>
        }
      >
        <RunSteps run={rd} />
        {rows.length > 0 && (
          <ul className="sb-agents">
            {rows.map((t) => {
              const done = TASK_DONE.has(t.status.toUpperCase());
              const failed = /FAIL|CANCEL/i.test(t.status);
              return (
                <li key={t.taskId} data-s={failed ? 'failed' : done ? 'done' : rd.terminal ? 'ended' : 'live'}>
                  <span className="sb-dot" aria-hidden="true" />
                  <span className="sb-agent-role">{t.role}</span>
                  <span className="sb-agent-obj">{t.objective}</span>
                  <span className="mono sb-agent-st">{t.status.toLowerCase()}</span>
                </li>
              );
            })}
          </ul>
        )}
      </SbCard>
      {panels.length > 0 ? (
        <div className="sb-grid" data-testid="sb-panels">
          {panels.map((p) => (
            <PanelCell key={p.panelId} wid={wid!} p={p} hl={hl} markers={markers} progress={progress[p.panelId]} cites={rd.findings.filter((f) => f.panelIds.includes(p.panelId)).length} />
          ))}
        </div>
      ) : !rd.terminal ? (
        <div className="sb-grid" aria-label="Charts are on their way">
          {[0, 1].map((i) => (
            <div key={i} className="sb-ghostchart" data-testid="sb-panel-skeleton">
              <span className="sb-shimmer" style={{ width: '46%' }} />
              <span className="sb-shimmer" style={{ width: '28%' }} />
              <div className="sb-ghostplot" aria-hidden="true" />
              <span className="sb-note">{progress && Object.keys(progress).length ? 'Querying…' : 'Waiting for the first query.'}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="sb-note">This run drew no charts.</p>
      )}
    </div>
  );
}

function PanelCell({ wid, p, hl, markers, progress, cites }: { wid: string; p: CanvasPanel; hl: Hl; markers: CanvasMarker[]; progress?: { status: 'QUERYING' | 'READY' | 'ERROR'; reason?: string }; cites: number }) {
  const key = panelKey(p.panelId);
  const on = hl.id === key;
  return (
    <div className="sb-pcell" id={`sb-panel-${p.panelId}`} data-hl={on ? 'true' : undefined} data-dim={hl.id && !on ? 'true' : undefined}>
      <PanelFrame
        wid={wid}
        panel={p}
        tools={cites > 0 ? <button type="button" className="sb-chip" aria-pressed={on} onClick={() => hl.pin(key)}>cited by {cites}</button> : undefined}
      >
        <PanelBody wid={wid} panel={p} height={Math.min(layoutHeight(p), 230)} progress={progress} markers={markers.filter((m) => m.panelId === p.panelId)} />
      </PanelFrame>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 3. findings */

export type FindingView = {
  id: string;
  statement: string;
  status: string;
  basis: string;
  skepticNotes: string[];
  limitations: string[];
  degraded?: boolean;
  cites: { id: string; title: string }[];
  facts: number;
};

export function fromRunFinding(f: Finding, titleOf: (panelId: string) => string): FindingView {
  return { id: f.id, statement: f.statement, status: f.status, basis: f.basis, skepticNotes: f.skepticNotes, limitations: f.limitations, degraded: f.skepticDegraded, cites: f.panelIds.map((id) => ({ id: panelKey(id), title: titleOf(id) })), facts: f.facts.length };
}

/** One finding in the card language: the statement with its numbers set heavier, the skeptic folded away, charts as chips. */
export function FindingStoryCard({ f, hl, index }: { f: FindingView; hl: Hl; index: number }) {
  const cited = f.cites.some((c) => c.id === hl.id);
  return (
    <SbCard
      testId="sb-finding"
      label={`Finding ${index + 1}`}
      hl={cited}
      badges={
        <>
          <Badge tone={FINDING_STATUS_TONE[f.status] ?? ''}>{FINDING_STATUS_LABEL[f.status] ?? f.status.replace(/_/g, ' ')}</Badge>
          <Badge outline title={f.basis === 'observation' ? 'Read directly from the result rows.' : 'A reading drawn from the rows, not stated in them.'}>{f.basis}</Badge>
        </>
      }
      foot={<span className="mono">{f.facts > 0 ? `${f.facts} number${f.facts === 1 ? '' : 's'} tied to result rows` : 'no numbers tied to result rows'}</span>}
    >
      <p className="sb-statement"><Num text={f.statement} /></p>
      {f.cites.length > 0 && (
        <div className="sb-chips" aria-label="Charts this finding cites">
          {f.cites.map((c) => (
            <button key={c.id} type="button" className="sb-chip" aria-pressed={hl.id === c.id} onMouseEnter={() => hl.hover(c.id)} onMouseLeave={() => hl.hover(null)} onFocus={() => hl.hover(c.id)} onBlur={() => hl.hover(null)} onClick={() => hl.pin(c.id)} title="Highlight this chart">
              {c.title}
            </button>
          ))}
        </div>
      )}
      {f.degraded && <p className="sb-note">The skeptic could not complete a full review of this finding; read its notes as partial.</p>}
      {f.skepticNotes.length > 0 && (
        <details className="sb-fold">
          <summary>What the skeptic said <span className="mono">{f.skepticNotes.length}</span></summary>
          <ul>{f.skepticNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </details>
      )}
      {f.limitations.length > 0 && (
        <details className="sb-fold">
          <summary>Limitations <span className="mono">{f.limitations.length}</span></summary>
          <ul>{f.limitations.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </details>
      )}
    </SbCard>
  );
}

export function FindingsArtifact({ wid, stage, hl, live }: { wid: string | null; stage: Stage; hl: Hl; live: boolean }) {
  const runId = stage.refs.runId ?? null;
  const run = useRunDoc(wid, runId, stage.state === 'working');
  const canvas = useCanvasDoc(wid, live);
  useOnChange(stage.state, () => void run.refetch());
  const titleOf = (id: string) => canvas.data?.panels.find((p) => p.panelId === id)?.title ?? 'Chart';
  if (!runId) return <SbCard><Unknown what="Investigation run" /></SbCard>;
  if (run.isPending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (run.isError) return <ApiErrorState error={run.error} onRetry={() => run.refetch()} />;
  const fs = run.data.findings;
  if (fs.length === 0)
    return (
      <SbCard>
        <p className="sb-note">{run.data.interpretation.state === 'unavailable' ? `The interpretation is unavailable${run.data.interpretation.reason ? `: ${run.data.interpretation.reason}` : '.'}` : 'The run wrote no findings.'}</p>
      </SbCard>
    );
  return (
    <div className="sb-grid sb-grid-wide" data-testid="sb-findings">
      {fs.map((f, i) => (
        <FindingStoryCard key={f.id} f={fromRunFinding(f, titleOf)} hl={hl} index={i} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 4. markers */

function MarkerCard({ wid, m, panel }: { wid: string; m: Marker; panel: CanvasPanel | null }) {
  const data = usePanelData(wid, panel?.queryRef?.hash, !!panel).data;
  const series = panel ? seriesOf(panel, data) : null;
  const at = markerAt(m.anchor);
  const t = at ? Date.parse(at) : NaN;
  return (
    <SbCard
      testId="sb-marker"
      label="Marker"
      title={panel?.title ?? 'Marker'}
      badges={
        <>
          <Badge tone={m.status === 'DRAFT' ? '' : 'info'}>{m.status.toLowerCase()}</Badge>
          <Badge outline>{m.anchorType.replace(/_/g, ' ')}</Badge>
        </>
      }
      foot={
        <>
          <span className="mono" title={at ?? undefined}>{at ? formatUtc(at, false) : 'date unknown'}</span>
          <span className="mono" title={m.markerId}>marker {shortHash(m.markerId, 8, 0)}</span>
        </>
      }
    >
      <div className="sb-marker-when">
        <span className="sb-date">{longDate(at)}</span>
        <span className="sb-note">{m.mode === 'replay' ? 'replay' : 'live data'}</span>
      </div>
      <p className="sb-reason"><Num text={markerTitle(m.question)} /></p>
      {series ? <MiniSeries series={series} markerAt={Number.isFinite(t) ? t : null} label={`${panel!.title} with the marker at ${longDate(at)}`} /> : panel ? <p className="sb-note">The chart behind this marker has no time series to draw.</p> : <p className="sb-note">The chart this marker sits on is not on the canvas, so it is shown without one.</p>}
    </SbCard>
  );
}

export function MarkersArtifact({ wid, stage, live }: { wid: string | null; stage: Stage; live: boolean }) {
  const list = useMarkerList(wid, true);
  const canvas = useCanvasDoc(wid, live);
  useOnChange(stage.state, () => void list.refetch());
  const all = list.data?.markers ?? [];
  const ids = stage.refs.markerIds;
  const own = useMemo(() => {
    if (ids) return all.filter((m) => ids.includes(m.markerId));
    const w = stage.steps[0];
    return createdWithin(all, (m) => m.timestamp, w?.startedAt ?? null, w?.finishedAt ?? null);
  }, [all, ids, stage.steps]);
  if (list.isPending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (list.isError) return <ApiErrorState error={list.error} onRetry={() => list.refetch()} />;
  return (
    <div className="sb-stack">
      {own.length > 0 ? (
        <div className="sb-grid" data-testid="sb-markers">
          {own.map((m) => (
            <MarkerCard key={m.markerId} wid={wid!} m={m} panel={canvas.data?.panels.find((p) => p.panelId === m.sourcePanelId) ?? null} />
          ))}
        </div>
      ) : stage.skipped.length === 0 ? (
        <SbCard><p className="sb-note">No markers were created.</p></SbCard>
      ) : null}
      <SkippedList items={stage.skipped} />
    </div>
  );
}

export function SkippedList({ items }: { items: { kind: string; reason: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="sb-skipped" data-testid="sb-skipped">
      {items.map((s, i) => (
        <li key={i}>
          <Badge outline>skipped {s.kind}</Badge>
          <span>{s.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------------ 5. monitors */

function evalLine(e: MonitorEvaluation | undefined): { text: string; tone: 'ok' | 'warn' | '' } {
  if (!e) return { text: 'not checked yet: a rule is checked when its source publishes new data', tone: '' };
  const s = e.status.replace(/_/g, ' ').toLowerCase();
  return { text: `${s}, ${formatAge(e.evaluatedAt)}`, tone: /trigger|fire|alert/.test(s) ? 'warn' : 'ok' };
}

function MonitorCard({ wid, r, panels, evals, triggerCount }: { wid: string; r: MonitorRule; panels: CanvasPanel[]; evals: MonitorEvaluation[]; triggerCount: number | null }) {
  const metric = metricIdsOf(r.condition)[0] ?? null;
  const panel = metric ? panelForMetric(panels, metric) : null;
  const data = usePanelData(wid, panel?.queryRef?.hash, !!panel).data;
  const series = panel && metric ? seriesOf(panel, data, metric) : null;
  const th = thresholdOf(r.condition);
  const last = [...evals].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
  const ev = evalLine(last);
  const labelOf = (id: string) => (panel && id === metric ? panel.title : metricWords(id));
  return (
    <SbCard
      testId="sb-monitor"
      label={`Monitor ${r.name}`}
      title={r.name}
      badges={
        <>
          <Badge tone={r.enabled ? 'ok' : ''}>{r.enabled ? 'armed' : 'disabled'}</Badge>
          <Badge outline>{r.action === 'investigate' ? 'investigates' : 'notifies'}</Badge>
        </>
      }
      tools={<Link className="sb-link" href={`/w/${wid}/monitors/${r.ruleId}`}>Open rule</Link>}
      foot={
        <>
          <span className="mono">{triggerCount === null ? 'triggers: unknown' : `${triggerCount} trigger${triggerCount === 1 ? '' : 's'}`}</span>
          <span className="mono">cooldown {Math.round(r.cooldownSeconds / 3600)} h</span>
          <span className="mono" title={r.ruleId}>rule {shortHash(r.ruleId, 8, 0)}</span>
        </>
      }
    >
      <p className="sb-watch">
        <span className="sb-watch-k">Watches</span>
        <span>{panel?.title ?? (metric ? metricWords(metric) : 'unknown metric')}</span>
        {metric && <span className="mono sb-dim" title="Metric id">{metric}</span>}
        <Badge outline title="Source">{r.sourceId}</Badge>
      </p>
      <p className="sb-cond"><Num text={monitorSentence(r.condition, labelOf)} /></p>
      {series ? (
        <MiniSeries series={series} threshold={th && th.metricId === metric ? { value: th.value, op: th.op } : null} label={`${panel!.title} with the alert line`} />
      ) : (
        <p className="sb-note">{panel ? 'The series this rule watches has no time axis to draw.' : 'No chart on the canvas plots this metric, so there is no series to draw.'}</p>
      )}
      <p className="sb-eval">
        <span className="sb-watch-k">Last check</span>
        <span className="mono" data-tone={ev.tone}>{ev.text}</span>
      </p>
    </SbCard>
  );
}

export function MonitorsArtifact({ wid, stage, live }: { wid: string | null; stage: Stage; live: boolean }) {
  const rules = useRuleList(wid, true);
  const evals = useEvaluationList(wid, true);
  const triggers = useTriggerList(wid, true);
  const canvas = useCanvasDoc(wid, live);
  useOnChange(stage.state, () => {
    void rules.refetch();
    void evals.refetch();
    void triggers.refetch();
  });
  const all = rules.data?.rules ?? [];
  const ids = stage.refs.monitorIds;
  const own = useMemo(() => {
    if (ids) return all.filter((r) => ids.includes(r.ruleId));
    const w = stage.steps[0];
    return createdWithin(all, (r) => r.createdAt, w?.startedAt ?? null, w?.finishedAt ?? null);
  }, [all, ids, stage.steps]);
  if (rules.isPending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (rules.isError) return <ApiErrorState error={rules.error} onRetry={() => rules.refetch()} />;
  return (
    <div className="sb-stack">
      {own.length > 0 ? (
        <div className="sb-grid" data-testid="sb-monitors">
          {own.map((r) => (
            <MonitorCard
              key={r.ruleId}
              wid={wid!}
              r={r}
              panels={canvas.data?.panels ?? []}
              evals={(evals.data?.evaluations ?? []).filter((e) => e.ruleId === r.ruleId)}
              triggerCount={triggers.data ? triggers.data.triggers.filter((t) => t.ruleId === r.ruleId).length : null}
            />
          ))}
        </div>
      ) : stage.skipped.length === 0 ? (
        <SbCard><p className="sb-note">No monitors were created.</p></SbCard>
      ) : null}
      <SkippedList items={stage.skipped} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 6. hypothesis */

export function HypothesisArtifact({ wid, stage }: { wid: string | null; stage: Stage }) {
  const list = useHypothesisList(wid, true);
  useOnChange(stage.state, () => void list.refetch());
  const all = list.data?.hypotheses ?? [];
  const id = stage.refs.hypothesisId;
  const own = useMemo(() => {
    if (id) return all.filter((h) => h.hypothesisId === id);
    const w = stage.steps[0];
    return createdWithin(all, (h) => h.createdAt, w?.startedAt ?? null, w?.finishedAt ?? null);
  }, [all, id, stage.steps]);
  if (list.isPending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (list.isError) return <ApiErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (own.length === 0)
    return (
      <div className="sb-stack">
        <SbCard><p className="sb-note">No hypothesis was created.</p></SbCard>
        <SkippedList items={stage.skipped} />
      </div>
    );
  return (
    <div className="sb-stack" data-testid="sb-hypotheses">
      {own.map((h) => (
        <SbCard
          key={h.hypothesisId}
          testId="sb-hypothesis"
          label="Hypothesis"
          title="Proposition"
          badges={
            <>
              <Badge tone={h.status === 'frozen' ? 'ok' : ''}>{h.status}</Badge>
              <Badge outline>version {h.version}</Badge>
            </>
          }
          tools={<Link className="sb-link" href={`/w/${wid}/hypotheses`}>Open hypotheses</Link>}
          foot={
            <>
              <span className="mono">{h.registered ? `registered ${h.registeredAt ? formatUtc(h.registeredAt, false) : ''}` : 'not frozen: it can still be edited'}</span>
              {h.registrationHash && <span className="mono" title={h.registrationHash}>hash {shortHash(h.registrationHash, 10, 4)}</span>}
              <span className="mono" title={h.hypothesisId}>hypothesis {shortHash(h.hypothesisId, 8, 0)}</span>
            </>
          }
        >
          <p className="sb-statement"><Num text={h.proposition} /></p>
          <dl className="sb-expect">
            <div><dt>Measured on</dt><dd>{h.target}</dd></div>
            <div><dt>Compared with</dt><dd>{h.benchmark}</dd></div>
          </dl>
          <div className="sb-wrong" data-testid="sb-falsification">
            <span className="sb-wrong-k">What would prove this wrong</span>
            <p>{h.falsification}</p>
          </div>
        </SbCard>
      ))}
    </div>
  );
}

export type { ReactNode };
