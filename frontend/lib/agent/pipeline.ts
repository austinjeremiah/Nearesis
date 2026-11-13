import type { AgentSetup } from './types';

/**
 * The "create workspace and run end to end" pipeline (contract section 3). It is a plain async state machine over an
 * injected API surface, so the approval rule and the resume behaviour are unit-tested without a browser.
 * State is JSON: it is stored with the conversation so a reload can resume from the stored ids.
 */

export const STEP_IDS = ['workspace', 'question', 'approval_wait', 'approve', 'run', 'setup', 'summary'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABEL: Record<StepId, string> = {
  workspace: 'Create the workspace',
  question: 'Start the investigation',
  approval_wait: 'Wait for the plan approval',
  approve: 'Approve the canvas patch (cost 0)',
  run: 'Run the investigation to completion',
  setup: 'Add markers, monitors and a draft hypothesis',
  summary: 'Summarise',
};

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed' | 'stopped' | 'timeout';
export type PipelinePhase = 'running' | 'failed' | 'stopped' | 'timeout' | 'interrupted' | 'done';

export type PipelineFinding = { statement: string; basis: string; status: string; facts: number; skepticNotes: number };

export type PipelineState = {
  id: string;
  objective: string;
  /** One idempotency key per write, kept across retries so a retry never repeats a step that already happened. */
  keys: { workspace: string; question: string; setup: string };
  phase: PipelinePhase;
  workspaceId: string | null;
  runId: string | null;
  runState: string | null;
  interpretation: { state: string; reason: string | null } | null;
  steps: Record<StepId, { status: StepStatus; detail?: string }>;
  error: { step: StepId; message: string } | null;
  /** Set when an approval is not the one kind this pipeline may approve: the user decides. */
  stoppedOn: { approvalId: string; kind: string; costLimit: number | null; reason: string } | null;
  setup: AgentSetup | null;
  findings: PipelineFinding[];
  startedAt: number;
};

export type RunSnapshot = {
  state: string;
  failure?: unknown;
  findings?: { statement: string; basis: string; status: string; facts?: unknown[]; skepticNotes?: unknown[] }[];
  interpretation?: { state: string; reason: string | null } | null;
};
export type ApprovalSnapshot = { runId: string; approvals: { approvalId: string; actionHash: string; status: string; kind: string; costLimit: number | null }[] };

export type PipelineDeps = {
  createWorkspace: (objective: string, key: string) => Promise<{ workspaceId: string }>;
  ask: (wid: string, question: string, key: string) => Promise<{ runId: string }>;
  getRun: (runId: string) => Promise<RunSnapshot>;
  getApprovals: (runId: string) => Promise<ApprovalSnapshot>;
  decide: (runId: string, approvalId: string, actionHash: string) => Promise<unknown>;
  setup: (wid: string, runId: string, key: string) => Promise<AgentSetup>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
};

export const OVERALL_TIMEOUT_MS = 5 * 60_000;
/** After COMPLETE, how long to wait for the interpretation to leave "none" before going on without it. */
export const INTERPRETATION_GRACE_MS = 45_000;
const FAILED_RUN_STATES = new Set(['BLOCKED', 'BLOCKED_SOURCE', 'CANCELLED', 'PARTIAL']);

/** The only approval the pipeline may grant: the canvas patch that costs nothing. */
export function isAutoApprovable(a: { kind: string; costLimit: number | null }): boolean {
  return a.kind === 'canvas.apply_patch' && a.costLimit === 0;
}

export function pollDelay(elapsedMs: number): number {
  return elapsedMs < 30_000 ? 2_000 : 4_000;
}

export function newPipeline(objective: string, newKey: () => string, now: number): PipelineState {
  const steps = Object.fromEntries(STEP_IDS.map((s) => [s, { status: 'pending' as StepStatus }])) as PipelineState['steps'];
  return {
    id: newKey(),
    objective,
    keys: { workspace: newKey(), question: newKey(), setup: newKey() },
    phase: 'running',
    workspaceId: null,
    runId: null,
    runState: null,
    interpretation: null,
    steps,
    error: null,
    stoppedOn: null,
    setup: null,
    findings: [],
    startedAt: now,
  };
}

/** A stored pipeline that was running when the page closed: show it as interrupted so the user resumes it on purpose. */
export function markInterrupted(p: PipelineState): PipelineState {
  return p.phase === 'running' ? { ...p, phase: 'interrupted' } : p;
}

function reasonOf(failure: unknown): string | null {
  if (typeof failure === 'string') return failure;
  if (failure && typeof failure === 'object') {
    const f = failure as Record<string, unknown>;
    for (const k of ['reason', 'message', 'reasonCode', 'code']) if (typeof f[k] === 'string') return f[k] as string;
  }
  return null;
}

/**
 * Run (or resume) the pipeline from its first unfinished step. Every state change is reported through `onState`.
 * Returns when the pipeline is done, failed, stopped for the user, timed out, or aborted.
 */
export async function runPipeline(start: PipelineState, deps: PipelineDeps, onState: (s: PipelineState) => void, signal?: AbortSignal): Promise<PipelineState> {
  let st: PipelineState = { ...start, phase: 'running', error: null, stoppedOn: null };
  const set = (patch: Partial<PipelineState>, step?: StepId, status?: StepStatus, detail?: string) => {
    const steps = step ? { ...st.steps, [step]: { status: status ?? st.steps[step].status, ...(detail !== undefined ? { detail } : {}) } } : st.steps;
    st = { ...st, ...patch, steps };
    onState(st);
  };
  const done = (s: StepId) => st.steps[s].status === 'done' || st.steps[s].status === 'skipped';
  // A retry re-activates the step that failed; steps already done are never repeated.
  for (const s of STEP_IDS) if (['failed', 'timeout', 'stopped'].includes(st.steps[s].status)) st = { ...st, steps: { ...st.steps, [s]: { status: 'pending' } } };
  onState(st);
  let current: StepId = 'workspace';
  try {
    if (!st.workspaceId) {
      current = 'workspace';
      set({}, 'workspace', 'active');
      const r = await deps.createWorkspace(st.objective, st.keys.workspace);
      set({ workspaceId: r.workspaceId }, 'workspace', 'done');
    }
    if (!st.runId) {
      current = 'question';
      set({}, 'question', 'active');
      const r = await deps.ask(st.workspaceId!, st.objective, st.keys.question);
      set({ runId: r.runId }, 'question', 'done');
    }
    if (!done('run')) {
      const runId = st.runId!;
      const began = deps.now();
      let completeSeen: number | null = null;
      for (;;) {
        if (signal?.aborted) return st;
        current = done('approval_wait') ? (done('approve') ? 'run' : 'approve') : 'approval_wait';
        if (st.steps[current].status === 'pending') set({}, current, 'active');
        const run = await deps.getRun(runId);
        const findings: PipelineFinding[] = (run.findings ?? []).map((f) => ({
          statement: f.statement,
          basis: f.basis,
          status: f.status,
          facts: (f.facts ?? []).length,
          skepticNotes: (f.skepticNotes ?? []).length,
        }));
        set({ runState: run.state, interpretation: run.interpretation ?? st.interpretation, findings });

        if (FAILED_RUN_STATES.has(run.state)) {
          const why = reasonOf(run.failure);
          const message = `The run ended in ${run.state}${why ? `: ${why}` : ''}.`;
          set({ phase: 'failed', error: { step: current, message } }, current, 'failed', message);
          return st;
        }
        if (run.state === 'APPROVAL_NEEDED') {
          if (!done('approval_wait')) set({}, 'approval_wait', 'done');
          current = 'approve';
          if (st.steps.approve.status !== 'active') set({}, 'approve', 'active');
          const ap = await deps.getApprovals(runId);
          const pending = ap.approvals.filter((a) => a.status === 'pending');
          const bad = ap.runId !== runId ? pending[0] : pending.find((a) => !isAutoApprovable(a));
          if (bad) {
            const reason = ap.runId !== runId ? 'This approval does not belong to the run the pipeline started.' : `The pipeline only approves a canvas patch that costs nothing; this is ${bad.kind} with a cost limit of ${bad.costLimit ?? 'not set'}.`;
            set({ phase: 'stopped', stoppedOn: { approvalId: bad.approvalId, kind: bad.kind, costLimit: bad.costLimit, reason } }, 'approve', 'stopped', reason);
            return st;
          }
          for (const a of pending) {
            await deps.decide(runId, a.approvalId, a.actionHash);
            set({}, 'approve', 'done', `Approved ${a.kind}, cost limit 0.`);
          }
        } else if (run.state === 'COMPLETE') {
          if (!done('approval_wait')) set({}, 'approval_wait', 'skipped', 'The run did not need an approval.');
          if (!done('approve')) set({}, 'approve', 'skipped', 'Nothing to approve.');
          const interp = run.interpretation?.state ?? 'none';
          if (interp === 'ready' || interp === 'unavailable') {
            set({}, 'run', 'done', interp === 'ready' ? 'Complete, findings written.' : `Complete, but the findings could not be written${run.interpretation?.reason ? `: ${run.interpretation.reason}` : ''}.`);
            break;
          }
          completeSeen ??= deps.now();
          if (deps.now() - completeSeen > INTERPRETATION_GRACE_MS) {
            set({}, 'run', 'done', 'Complete. No findings were reported for this run.');
            break;
          }
        } else if (done('approve') && st.steps.run.status !== 'active') {
          set({}, 'run', 'active');
        }
        if (deps.now() - began > OVERALL_TIMEOUT_MS) {
          set({ phase: 'timeout' }, current, 'timeout', 'Still running after 5 minutes.');
          return st;
        }
        await deps.sleep(pollDelay(deps.now() - began), signal);
      }
    }
    if (!done('setup')) {
      current = 'setup';
      if (st.interpretation?.state === 'ready') {
        set({}, 'setup', 'active');
        const r = await deps.setup(st.workspaceId!, st.runId!, st.keys.setup);
        const made = r.markers.length + r.monitors.length + (r.hypothesis ? 1 : 0);
        set({ setup: r }, 'setup', 'done', `${made} created${r.skipped.length ? `, ${r.skipped.length} skipped with a reason` : ''}.`);
      } else {
        set({}, 'setup', 'skipped', 'No written findings, so there was nothing to base markers, monitors or a hypothesis on.');
      }
    }
    set({ phase: 'done' }, 'summary', 'done');
    return st;
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return st;
    const message = e instanceof Error ? e.message : 'The step failed.';
    set({ phase: 'failed', error: { step: current, message } }, current, 'failed', message);
    return st;
  }
}
