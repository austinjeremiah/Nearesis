'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Circle, Loader, Minus } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Button } from '@/components/nx/ui';
import { openCreditsPopup } from '@/lib/credits/refusal';
import { toMicro } from '@/lib/credits/usd';
import { doneCount, elapsedSeconds, formatUsdString, taskCostText, taskLive, TASK_LABEL } from '@/lib/agent/tasks';
import type { Task } from '@/lib/agent/thread';
import { STAGE_LABEL, STAGE_PROMISE, currentStage, failureMeaning, timeAgoShort, type Stage, type StageState } from '@/lib/agent/storyboard';
import { panelKey } from '@/lib/agent/selection';
import { useNow } from '../task-cards';
import { ApprovalNotice } from '../approval';
import { useStoryboardSync } from './sync';
import { pdfHref } from '@/lib/thesis/api';
import { approvalNeeded } from '@/lib/agent/approval';
import { CapsuleArtifact, CompareArtifact, GenericArtifact, ThesisArtifact, ThesisLinkArtifact, ProofArtifact, PublicationArtifact, ReportArtifact } from './artifacts-chain';
import { FindingsArtifact, HypothesisArtifact, InvestigationArtifact, MarkersArtifact, MonitorsArtifact, WorkspaceArtifact, type Hl } from './artifacts-work';
import { SbCard } from './parts';
import TestPlanBlock from '../test-plan';

export type ScrollRequest = { stageId: string; n: number } | null;

const STATE_WORD: Record<StageState, string> = { waiting: 'Waiting', working: 'Working', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
const TASK_TONE = { proposed: 'info', running: 'accent', waiting_user: 'warn', completed: 'ok', failed: 'bad', cancelled: '' } as const;

function StateIcon({ state, size = 14 }: { state: StageState; size?: number }) {
  const p = { size, 'aria-hidden': true } as const;
  return state === 'done' ? <Check {...p} /> : state === 'working' ? <Loader {...p} className="ag-spin" /> : state === 'failed' ? <AlertTriangle {...p} /> : state === 'skipped' ? <Minus {...p} /> : <Circle {...p} />;
}

function StateBadge({ stage }: { stage: Stage }) {
  if (stage.state === 'working' && stage.needsApproval) return <Badge tone="warn">Needs your approval</Badge>;
  const tone = stage.state === 'done' ? 'ok' : stage.state === 'working' ? 'accent' : stage.state === 'failed' ? 'bad' : '';
  return <Badge tone={tone} outline={stage.state === 'waiting' || stage.state === 'skipped'}>{STATE_WORD[stage.state]}</Badge>;
}

/* ------------------------------------------------------------------------------------------------- pieces of a stage */

function PromiseNote({ stage }: { stage: Stage }) {
  return (
    <div className="sb-promise" data-testid="sb-promise">
      <p>{STAGE_PROMISE[stage.kind]}</p>
    </div>
  );
}

function WorkingNote({ stage }: { stage: Stage }) {
  return (
    <div className="sb-working" data-testid="sb-working" role="status">
      <span className="ag-pulse" aria-hidden="true" />
      <div>
        <p className="sb-working-line">{stage.progress ?? (stage.needsApproval ? 'Waiting for your approval in the chat.' : 'Working on it…')}</p>
        <p className="sb-note">{STAGE_PROMISE[stage.kind]}</p>
      </div>
    </div>
  );
}

function FailBand({ stage }: { stage: Stage }) {
  const e = stage.error;
  if (!e) return null;
  return (
    <div className="sb-failband" role="alert" data-testid="sb-failed">
      <div className="sb-failband-head">
        <AlertTriangle size={16} aria-hidden="true" />
        <span className="mono sb-failband-code">{e.reasonCode}</span>
      </div>
      <p className="sb-failband-msg">{e.message}</p>
      <p className="sb-note">{failureMeaning(e.reasonCode)}{e.retryable ? ' You can retry it from the timeline.' : ''}</p>
      {e.reasonCode === 'CREDITS_EXHAUSTED' && <Button variant="primary" onClick={() => openCreditsPopup()}>Request more credits</Button>}
    </div>
  );
}

function SkippedNote({ stage }: { stage: Stage }) {
  const why = stage.steps.map((s) => s.result?.summary).find(Boolean);
  return (
    <div className="sb-promise" data-testid="sb-skipped-stage">
      <p>{stage.kind === 'findings' ? 'No findings were written because the run did not finish.' : why || 'This step was skipped.'}</p>
    </div>
  );
}

function Artifact({ stage, wid, hl, live, task }: { stage: Stage; wid: string | null; hl: Hl; live: boolean; task: Task }) {
  switch (stage.kind) {
    case 'testplan':
      return <TestPlanStage task={task} />;
    case 'workspace':
      return <WorkspaceArtifact wid={wid} />;
    case 'investigate':
      return <InvestigationArtifact wid={wid} stage={stage} hl={hl} live={live} />;
    case 'findings':
      return <FindingsArtifact wid={wid} stage={stage} hl={hl} live={live} />;
    case 'markers':
      return <MarkersArtifact wid={wid} stage={stage} live={live} />;
    case 'monitors':
      return <MonitorsArtifact wid={wid} stage={stage} live={live} />;
    case 'hypothesis':
      return <HypothesisArtifact wid={wid} stage={stage} />;
    case 'capsule':
      return <CapsuleArtifact wid={wid} stage={stage} />;
    case 'proof':
      return <ProofArtifact stage={stage} />;
    case 'publish':
      return <PublicationArtifact stage={stage} />;
    case 'thesis':
      return <ThesisArtifact stage={stage} />;
    case 'thesislink':
      return <ThesisLinkArtifact stage={stage} />;
    case 'compare':
      return <CompareArtifact stage={stage} />;
    case 'report':
      return <ReportArtifact wid={wid} stage={stage} />;
    default:
      return <GenericArtifact stage={stage} />;
  }
}

function TestPlanStage({ task }: { task: Task }) {
  const sync = useStoryboardSync();
  return <TestPlanBlock task={task} variant="story" onEditInChat={sync?.onReviewApproval} />;
}

/** Does the artifact have what it needs to load, or must a working stage show its live note instead? */
function artifactReady(stage: Stage, wid: string | null): boolean {
  const r = stage.refs;
  switch (stage.kind) {
    case 'testplan':
      return true;
    case 'workspace':
    case 'report':
    case 'markers':
    case 'monitors':
    case 'hypothesis':
      return !!wid && stage.state !== 'working';
    case 'thesis':
      return !!r.thesisId && stage.state !== 'working';
    case 'thesislink':
    case 'compare':
      return stage.state !== 'working';
    case 'investigate':
      return !!r.runId;
    case 'findings':
      return !!r.runId && stage.state !== 'working';
    case 'capsule':
    case 'publish':
      return !!r.capsuleId && stage.state !== 'working';
    case 'proof':
      return !!r.proofId || !!r.capsuleId || stage.state === 'working';
    default:
      return true;
  }
}

function StageSection({ task, stage, index, total, wid, hl, live, now, active, justRevealed }: { task: Task; stage: Stage; index: number; total: number; wid: string | null; hl: Hl; live: boolean; now: number; active: boolean; justRevealed: boolean }) {
  const sec = elapsedSeconds(stage.startedAt, now, stage.state === 'working' ? null : stage.finishedAt);
  const cost = stage.costUsd === null ? null : toMicro(stage.costUsd) === 0n ? 'no cost' : formatUsdString(stage.costUsd);
  // A step that failed made nothing of its own; only the run and the proof have a live object worth showing beside the reason.
  const runsArtifact = stage.kind === 'testplan' || stage.state !== 'waiting' && stage.state !== 'skipped' && (stage.state !== 'failed' || stage.kind === 'investigate' || stage.kind === 'proof');
  const ready = artifactReady(stage, wid);
  return (
    <li id={`stage-${stage.id}`} className="sb-stage" data-testid="sb-stage" data-kind={stage.kind} data-state={stage.state} data-active={active ? 'true' : undefined} data-new={justRevealed ? 'true' : undefined} aria-label={`Step ${index + 1} of ${total}: ${stage.title}, ${STATE_WORD[stage.state].toLowerCase()}`}>
      <div className="sb-spine" aria-hidden="true">
        <span className="sb-node" data-s={stage.state}>
          {stage.state === 'waiting' || stage.state === 'working' ? <span className="sb-node-n">{index + 1}</span> : <StateIcon state={stage.state} size={15} />}
        </span>
      </div>
      <div className="sb-stage-main">
        <header className="sb-stage-head">
          <div className="sb-stage-titles">
            <h3 className="sb-stage-title">{stage.title}</h3>
            <StateBadge stage={stage} />
          </div>
          <p className="sb-stage-meta mono">
            {stage.kind === 'testplan' ? <span>{stage.state === 'done' ? 'locked' : 'not locked yet'}</span> : stage.startedAt ? <span title="Time on this step">{timeAgoShort(sec)}</span> : <span>not started</span>}
            {cost && <span title="Model spend plus on-chain cost for this step">{cost}</span>}
          </p>
        </header>
        {stage.why && <p className="why sb-why" data-testid="stage-why">Why: {stage.why}</p>}
        <div className="sb-stage-body">
          {stage.state === 'waiting' && stage.kind !== 'testplan' && <PromiseNote stage={stage} />}
          {stage.state === 'skipped' && <SkippedNote stage={stage} />}
          {stage.state === 'failed' && <FailBand stage={stage} />}
          {runsArtifact && (ready ? <Artifact stage={stage} wid={wid} hl={hl} live={live} task={task} /> : stage.state === 'working' ? <WorkingNote stage={stage} /> : null)}
          {stage.state === 'working' && ready && stage.progress && stage.kind !== 'investigate' && <p className="sb-note" role="status">{stage.progress}</p>}
        </div>
      </div>
    </li>
  );
}

/** The end of the work: the thesis the task made, to open or download. */
function Outcome({ stages }: { stages: Stage[] }) {
  const thesis = stages.find((s) => s.kind === 'thesis' && s.state === 'done' && s.refs.thesisId);
  if (!thesis) return null;
  const id = encodeURIComponent(thesis.refs.thesisId!);
  return (
    <div className="sb-outcome" data-testid="sb-outcome">
      <Link className="sb-btn sb-btn-primary" href={`/thesis/${id}`} data-testid="sb-outcome-thesis">Open the thesis</Link>
      <a className="sb-btn" href={pdfHref(thesis.refs.thesisId!)} download data-testid="sb-outcome-pdf">Download thesis PDF</a>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- the storyboard */

/**
 * The middle of the Agent page for a task: a sticky rail of the stages and one designed section per stage, each with the
 * real object the agent made, loaded by id. It follows the running stage once, and never fights the viewer's scrolling.
 */
export default function Storyboard({
  task,
  stages,
  wid,
  activeStageId,
  onActiveStage,
  request,
}: {
  task: Task;
  stages: Stage[];
  wid: string | null;
  activeStageId: string | null;
  onActiveStage: (id: string) => void;
  request: ScrollRequest;
}) {
  const live = taskLive(task);
  const now = useNow(live);
  const scroller = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  const lockUntil = useRef(0);
  const userMoved = useRef(false);
  const autoDone = useRef<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const hl: Hl = useMemo(() => ({ id: hover ?? pinned, hover: setHover, pin: (id) => setPinned((p) => (p === id ? null : id)) }), [hover, pinned]);
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Highlighting a chart brings it into view.
  useEffect(() => {
    if (!pinned || !pinned.startsWith('p:')) return;
    document.getElementById(`sb-panel-${pinned.slice(2)}`)?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [pinned, reduce]);
  void panelKey;

  const scrollToStage = useCallback(
    (id: string, smooth = true) => {
      const box = scroller.current;
      const el = document.getElementById(`stage-${id}`);
      if (!box || !el) return;
      lockUntil.current = Date.now() + 800;
      box.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: smooth && !reduce ? 'smooth' : 'auto' });
      onActiveStage(id);
    },
    [onActiveStage, reduce],
  );

  // The timeline asked for a stage.
  useEffect(() => {
    if (request) scrollToStage(request.stageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n]);

  // New task: forget that the viewer scrolled.
  useEffect(() => {
    userMoved.current = false;
    autoDone.current = null;
  }, [task.id]);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const moved = () => {
      userMoved.current = true;
    };
    for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.addEventListener(ev, moved, { passive: true });
    return () => {
      for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.removeEventListener(ev, moved);
    };
  }, []);

  // Which stage is at the top while scrolling.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (Date.now() < lockUntil.current) return;
        const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
        let id: string | null = null;
        for (const s of stages) {
          const el = document.getElementById(`stage-${s.id}`);
          if (el && el.offsetTop <= box.scrollTop + 140) id = s.id;
        }
        if (atEnd && stages.length) id = stages[stages.length - 1]!.id;
        if (id) onActiveStage(id);
      });
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      box.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [stages, onActiveStage]);

  // The working stage scrolls into view once, and only until the viewer takes over.
  const cur = currentStage(stages);
  const curKey = cur && cur.state === 'working' ? `${task.id}:${cur.id}` : null;
  useEffect(() => {
    if (!curKey || autoDone.current === curKey) return;
    autoDone.current = curKey;
    if (!userMoved.current) scrollToStage(cur!.id);
    else onActiveStage(cur!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey]);

  // The active pill stays visible when the rail itself scrolls sideways.
  useEffect(() => {
    const r = rail.current;
    const pill = r?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!r || !pill) return;
    const a = pill.offsetLeft - 20;
    const b = pill.offsetLeft + pill.offsetWidth + 20;
    if (a < r.scrollLeft) r.scrollLeft = a;
    else if (b > r.scrollLeft + r.clientWidth) r.scrollLeft = b - r.clientWidth;
  }, [activeStageId]);

  // First stage active until the viewer moves.
  useEffect(() => {
    if (!activeStageId && stages[0]) onActiveStage(stages[0].id);
  }, [activeStageId, stages, onActiveStage]);

  // Tell screen readers when a stage changes state, not on every progress tick.
  const prev = useRef<Map<string, StageState> | null>(null);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const now2 = new Map(stages.map((s) => [s.id, s.state] as const));
    if (prev.current) {
      const changed = stages.filter((s) => prev.current!.get(s.id) !== s.state && prev.current!.has(s.id));
      const last = changed[changed.length - 1];
      if (last) setAnnounce(`${last.title}: ${STATE_WORD[last.state].toLowerCase()}`);
    }
    prev.current = now2;
  }, [stages]);

  // A stage that has just appeared (a task that grows) reveals itself; the first paint does not animate.
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current) for (const s of stages) if (!seen.current.has(s.id)) fresh.add(s.id);
  useEffect(() => {
    seen.current = new Set(stages.map((s) => s.id));
  }, [stages]);

  const tc = taskCostText(task);
  const syncCtx = useStoryboardSync();
  const approval = useMemo(() => approvalNeeded(task), [task]);
  const done = doneCount(task);
  const total = task.steps.length;
  const costZero = toMicro(task.cost.modelUsd ?? '') === 0n && toMicro(task.cost.creditsUsd ?? '') === 0n;
  return (
    <section className="sb" aria-label="Storyboard" data-testid="agent-storyboard" data-task-state={task.state}>
      <nav className="sb-rail" ref={rail} aria-label="Stages of this task" data-testid="sb-rail">
        <ol>
          {stages.map((s) => (
            <li key={s.id}>
              <button type="button" className="sb-pill" data-s={s.state} aria-current={activeStageId === s.id ? 'step' : undefined} onClick={() => scrollToStage(s.id)} title={`${s.title}: ${STATE_WORD[s.state].toLowerCase()}`}>
                <span className="sb-pill-dot" aria-hidden="true" />
                {STAGE_LABEL[s.kind] === 'Step' ? s.title : STAGE_LABEL[s.kind]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="sb-scroll" ref={scroller} tabIndex={-1}>
        <header className="sb-hero">
          <div className="sb-hero-row">
            <h2 className="sb-hero-title">{task.title}</h2>
            <Badge tone={TASK_TONE[task.state]}>{TASK_LABEL[task.state]}</Badge>
          </div>
          <p className="sb-hero-meta mono">
            <span>{done} of {total} steps done</span>
            <span>{costZero ? 'no cost so far' : `${tc.total} spent`}</span>
            {task.links.workspaceId && <Link className="sb-link" href={`/w/${task.links.workspaceId}/overview`}>Open workspace</Link>}
          </p>
          <div className="sb-meter" aria-hidden="true"><span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
          <Outcome stages={stages} />
          {approval && syncCtx ? (
            <ApprovalNotice approval={approval} onReview={syncCtx.onReviewApproval} variant="storyboard" />
          ) : (
            task.state === 'proposed' && <p className="sb-note">This is the plan. Nothing runs until you press Start in the chat; the stages fill in as it goes.</p>
          )}
        </header>
        <ol className="sb-stages">
          {stages.map((s, i) => (
            <StageSection key={s.id} task={task} stage={s} index={i} total={stages.length} wid={s.refs.workspaceId ?? wid} hl={hl} live={live} now={now} active={activeStageId === s.id} justRevealed={fresh.has(s.id)} />
          ))}
        </ol>
        {stages.length === 0 && <p className="sb-note">This task has no steps yet.</p>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
    </section>
  );
}

export type { ReactNode };
