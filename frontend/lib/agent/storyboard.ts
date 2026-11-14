import { sumUsd } from '@/lib/credits/usd';
import type { Condition } from '@/lib/research/api';
import type { Proof } from '@/lib/near/api';
import type { StepRefs, Task, TaskStep } from './thread';

/**
 * Pure logic of the storyboard: the middle of the Agent page shows one stage per piece of work the agent did. A stage is
 * built from the steps of a task; one step can feed several stages (the automatic setup makes markers, monitors and a
 * hypothesis), and several steps can feed one stage (asking the question and waiting for the run).
 */

export type StageKind = 'workspace' | 'investigate' | 'findings' | 'markers' | 'monitors' | 'hypothesis' | 'capsule' | 'proof' | 'publish' | 'thesis' | 'thesislink' | 'compare' | 'report' | 'archive' | 'other';
export type StageState = 'waiting' | 'working' | 'done' | 'failed' | 'skipped';

export type Stage = {
  /** Stable within a task: the kind, or `other-<idx>` for a step the storyboard has no artifact for. */
  id: string;
  kind: StageKind;
  /** Plain words, not the planner's step title. */
  title: string;
  state: StageState;
  /** The task steps that own this stage, in order. */
  stepIdxs: number[];
  steps: TaskStep[];
  /** True when a step is paused on an approval the user has to give. */
  needsApproval: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** USD decimal strings; null when no step of the stage reported a cost, or when another stage of the same step carries it. */
  costUsd: string | null;
  refs: StepRefs;
  skipped: { kind: string; reason: string }[];
  error: { reasonCode: string; message: string; retryable: boolean } | null;
  progress: string | null;
};

export const STAGE_LABEL: Record<StageKind, string> = {
  workspace: 'Workspace',
  investigate: 'Investigate',
  findings: 'Findings',
  markers: 'Markers',
  monitors: 'Monitors',
  hypothesis: 'Hypothesis',
  capsule: 'Capsule',
  proof: 'Proof',
  publish: 'Publish',
  thesis: 'Thesis',
  thesislink: 'Public thesis',
  compare: 'Reproduction',
  report: 'Older format',
  archive: 'Archive',
  other: 'Step',
};

export const STAGE_TITLE: Record<StageKind, string> = {
  workspace: 'The workspace',
  investigate: 'The investigation',
  findings: 'What the agent found',
  markers: 'Markers on the charts',
  monitors: 'Monitors that keep watching',
  hypothesis: 'A hypothesis to test',
  capsule: 'The capsule',
  proof: 'Proof in secure hardware',
  publish: 'Publication',
  thesis: 'The thesis',
  thesislink: 'The public thesis page',
  compare: 'Original against reproduction',
  report: 'Workspace summary (older format)',
  archive: 'Archive the workspace',
  other: 'Step',
};

/** What a stage that has not happened yet will show, so a pending stage is a promise and not an empty box. */
export const STAGE_PROMISE: Record<StageKind, string> = {
  workspace: 'The workspace will appear here: the objective the agent works toward and where everything it makes is kept.',
  investigate: 'The investigation will appear here: the question, then each query and chart as it comes back.',
  findings: 'The findings will appear here: short statements, each tied to numbers and to the charts that show them.',
  markers: 'Markers will appear here: dates worth remembering, pinned on the chart they came from.',
  monitors: 'Monitors will appear here: rules that watch a metric and say when it crosses a line.',
  hypothesis: 'The hypothesis will appear here: a claim to test, and what would prove it wrong.',
  capsule: 'The capsule will appear here: a frozen copy of the run\u2019s results that anyone can re-check.',
  proof: 'The proof will appear here: the capsule re-run inside secure hardware, with the attestation it produced.',
  publish: 'The public page will appear here once the capsule is published.',
  thesis: 'The thesis will appear here: the verdict, the numbers behind it and a PDF you can share.',
  thesislink: 'The public link to the thesis will appear here once it is published.',
  compare: 'The comparison will appear here: what the original said, what the reproduction found, and whether they match.',
  report: 'The workspace summary will appear here: the whole workspace as a document you can open or download as a PDF.',
  archive: 'The workspace will be archived here.',
  other: 'The result of this step will appear here.',
};

const STEP_STAGE: Record<string, StageKind[]> = {
  'workspace.create': ['workspace'],
  'workspace.use': ['workspace'],
  'workspace.archive': ['archive'],
  'question.ask': ['investigate'],
  'run.await': ['investigate', 'findings'],
  'setup.auto': ['markers', 'monitors', 'hypothesis'],
  'marker.create': ['markers'],
  'monitor.create': ['monitors'],
  'hypothesis.create': ['hypothesis'],
  'hypothesis.freeze': ['hypothesis'],
  'capsule.build': ['capsule'],
  'capsule.prove': ['proof'],
  'capsule.publish': ['publish'],
  'report.build': ['report'],
  'thesis.build': ['thesis'],
  'thesis.publish': ['thesislink'],
  'thesis.compare': ['compare'],
};

export const stageKindsOf = (key: string): StageKind[] => STEP_STAGE[key] ?? ['other'];

const mapStep = (s: TaskStep['state']): StageState => (s === 'pending' ? 'waiting' : s === 'running' || s === 'waiting_user' ? 'working' : s);

/** failed beats working beats done; all skipped is skipped; nothing started is waiting; some done and the rest not started is working. */
export function mergeStates(states: TaskStep['state'][]): StageState {
  if (states.length === 0) return 'waiting';
  if (states.includes('failed')) return 'failed';
  if (states.some((s) => s === 'running' || s === 'waiting_user')) return 'working';
  if (states.every((s) => s === 'skipped')) return 'skipped';
  if (states.every((s) => s === 'done' || s === 'skipped')) return 'done';
  if (states.every((s) => s === 'pending')) return 'waiting';
  return 'working';
}

/** The findings stage follows the run: it is skipped when the run did not finish, so it never claims findings that were not written. */
function findingsState(runStep: TaskStep): StageState {
  if (runStep.state === 'failed') return 'skipped';
  return mapStep(runStep.state);
}

function mergeRefs(steps: TaskStep[]): StepRefs {
  const out: StepRefs = {};
  for (const s of steps) {
    const r = s.result?.refs;
    if (!r) continue;
    for (const k of ['workspaceId', 'runId', 'capsuleId', 'proofId', 'publicationId', 'hypothesisId', 'thesisId'] as const) if (r[k]) out[k] = r[k];
    if (r.markerIds) out.markerIds = [...new Set([...(out.markerIds ?? []), ...r.markerIds])];
    if (r.monitorIds) out.monitorIds = [...new Set([...(out.monitorIds ?? []), ...r.monitorIds])];
    if (r.skipped) out.skipped = [...(out.skipped ?? []), ...r.skipped];
  }
  return out;
}

/** Old tasks have no refs but their setup step lists "Skipped marker" style items. Read the reasons from those. */
function skippedOf(steps: TaskStep[], kind: StageKind): { kind: string; reason: string }[] {
  const single = kind === 'markers' ? 'marker' : kind === 'monitors' ? 'monitor' : kind === 'hypothesis' ? 'hypothesis' : null;
  if (!single) return [];
  const out: { kind: string; reason: string }[] = [];
  for (const s of steps) {
    const r = s.result;
    if (!r) continue;
    if (r.refs.skipped) out.push(...r.refs.skipped.filter((x) => x.kind === single));
    else
      for (const i of r.items) {
        const m = /^skipped\s+(\w+)/i.exec(i.label);
        if (m && m[1]!.toLowerCase() === single) out.push({ kind: single, reason: i.value });
      }
  }
  return out;
}

/** Task links fill in ids that the steps' refs do not carry (a task finished before the server sent refs). */
function withLinks(refs: StepRefs, kind: StageKind, links: Task['links']): StepRefs {
  const o = { ...refs };
  if (!o.workspaceId && links.workspaceId) o.workspaceId = links.workspaceId;
  if (kind === 'investigate' || kind === 'findings') o.runId ??= links.runId ?? undefined;
  if (kind === 'capsule' || kind === 'publish' || kind === 'proof') o.capsuleId ??= links.capsuleId ?? undefined;
  if (kind === 'proof') o.proofId ??= links.proofId ?? undefined;
  if (kind === 'publish') o.publicationId ??= links.publicationId ?? undefined;
  if (kind === 'thesis') o.thesisId ??= links.thesisId ?? undefined;
  return o;
}

/**
 * The stages of a task, in the order the work happens. A task that has only some steps has only those stages. A step with
 * a key the storyboard does not know becomes its own generic stage rather than disappearing.
 */
export function buildStages(task: Task | null | undefined): Stage[] {
  if (!task) return [];
  const byId = new Map<string, Stage>();
  const order: string[] = [];
  const derivedFrom = new Map<string, number>(); // stage id -> step idx whose cost it would repeat
  for (const step of task.steps) {
    const kinds = stageKindsOf(step.key);
    kinds.forEach((kind, n) => {
      const id = kind === 'other' ? `other-${step.idx}` : kind;
      let st = byId.get(id);
      if (!st) {
        st = { id, kind, title: kind === 'other' ? step.title : STAGE_TITLE[kind], state: 'waiting', stepIdxs: [], steps: [], needsApproval: false, startedAt: null, finishedAt: null, costUsd: null, refs: {}, skipped: [], error: null, progress: null };
        byId.set(id, st);
        order.push(id);
      }
      st.stepIdxs.push(step.idx);
      st.steps.push(step);
      // The second and third stage of one step show the step's cost once, on the first.
      if (n > 0) derivedFrom.set(id, step.idx);
    });
  }
  const placed = placeThesis(order.map((id) => byId.get(id)!));
  // Every result is a thesis. A task that builds one does not also show the older workspace summary stage; a task from
  // before theses (a report step and no thesis step) still shows it, titled as the older format, so old conversations work.
  const stages = placed.some((s) => s.kind === 'thesis') ? placed.filter((s) => s.kind !== 'report') : placed;
  for (const st of stages) {
    const own = st.steps;
    st.state = st.kind === 'findings' ? findingsState(own[own.length - 1]!) : mergeStates(own.map((s) => s.state));
    st.needsApproval = own.some((s) => s.state === 'waiting_user');
    st.startedAt = own.map((s) => s.startedAt).filter((x): x is string => !!x).sort()[0] ?? null;
    st.finishedAt = st.state === 'done' || st.state === 'failed' || st.state === 'skipped' ? own.map((s) => s.finishedAt).filter((x): x is string => !!x).sort().reverse()[0] ?? null : null;
    const costs = own.filter((s) => derivedFrom.get(st.id) !== s.idx).map((s) => sumUsd(s.cost.modelUsd, s.cost.creditsUsd)).filter((x): x is string => x !== null);
    st.costUsd = costs.length ? sumUsd(...costs) : null;
    st.refs = withLinks(mergeRefs(own), st.kind, task.links);
    st.skipped = skippedOf(own, st.kind);
    const failed = own.find((s) => s.state === 'failed');
    st.error = failed?.error ?? (failed ? { reasonCode: 'UNKNOWN', message: 'The step failed.', retryable: true } : null);
    const live = own.find((s) => s.state === 'running' || s.state === 'waiting_user');
    st.progress = live ? (live.state === 'waiting_user' ? (live.waiting?.summary ?? 'Waiting for your approval.') : live.progress) : null;
  }
  return stages;
}

/** The thesis is the task's main output: it follows the capsule, proof and publication, and comes before the older workspace summary. */
function placeThesis(stages: Stage[]): Stage[] {
  const moving = stages.filter((s) => s.kind === 'thesis' || s.kind === 'thesislink');
  if (moving.length === 0) return stages;
  const rest = stages.filter((s) => !moving.includes(s));
  let at = -1;
  rest.forEach((s, i) => {
    if (s.kind === 'capsule' || s.kind === 'proof' || s.kind === 'publish') at = i;
  });
  if (at < 0) {
    const r = rest.findIndex((s) => s.kind === 'report');
    at = r < 0 ? rest.length - 1 : r - 1;
  }
  return [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
}

export const stageOfStep = (stages: Stage[], stepIdx: number): Stage | undefined => stages.find((s) => s.stepIdxs.includes(stepIdx));

/** The stage the agent is on: the first one working, else the first failed, else null. */
export function currentStage(stages: Stage[]): Stage | null {
  return stages.find((s) => s.state === 'working') ?? stages.find((s) => s.state === 'failed') ?? null;
}

/** What a failed step means for the person reading it. */
export function failureMeaning(reasonCode: string): string {
  switch (reasonCode) {
    case 'CREDITS_EXHAUSTED':
    case 'INSUFFICIENT_CREDITS':
      return 'Your credits ran out before this step could start. Nothing was charged for it.';
    case 'PROOF_PROVIDER_DISABLED':
      return 'The secure-hardware provider is switched off on this server, so the proof could not run.';
    case 'ALREADY_PROVED':
      return 'This capsule already has a proof, so a second one was not started.';
    default:
      return 'This step stopped. The stages before it are unaffected, and the ones after it did not run.';
  }
}

/* -------------------------------------------------------------------------------------------------- monitors */

/** `live.near_tx_count` reads as "near tx count": the prefix names the data layer, not the metric. */
export function metricWords(metricId: string): string {
  const base = metricId.includes('.') ? metricId.slice(metricId.indexOf('.') + 1) : metricId;
  return base.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim() || metricId;
}

const OP_WORDS: Record<string, string> = { gt: 'rise above', gte: 'reach or pass', lt: 'fall below', lte: 'fall to or below', eq: 'equal', ne: 'differ from' };

export function formatThreshold(v: number): string {
  return Number.isFinite(v) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(v) : 'unknown';
}

function words(c: Condition, labelOf: (id: string) => string): string {
  switch (c.kind) {
    case 'compare':
      return `${labelOf(c.metricId)} ${OP_WORDS[c.op] ?? c.op} ${formatThreshold(c.value)}`;
    case 'zscore':
      return `${labelOf(c.metricId)} moves more than ${formatThreshold(c.absoluteGt)} standard deviations from its ${c.windowDays}-day average`;
    case 'not':
      return `it is not true that ${words(c.term, labelOf)}`;
    default: {
      const parts = (c.terms ?? []).map((t) => words(t, labelOf));
      return parts.length ? parts.join(c.kind === 'and' ? ', and ' : ', or ') : 'its condition is empty';
    }
  }
}

/** "alerts when daily swaps fall below 20,223". `labelOf` lets the caller supply a nicer metric name (a panel title). */
export function monitorSentence(c: Condition, labelOf: (id: string) => string = metricWords): string {
  return `alerts when ${words(c, labelOf)}`;
}

/** The first plain comparison in a condition, the one a sparkline can draw as a dashed line. */
export function thresholdOf(c: Condition): { metricId: string; op: string; value: number } | null {
  if (c.kind === 'compare') return { metricId: c.metricId, op: c.op, value: c.value };
  if (c.kind === 'and' || c.kind === 'or') for (const t of c.terms ?? []) {
    const r = thresholdOf(t);
    if (r) return r;
  }
  if (c.kind === 'not') return thresholdOf(c.term);
  return null;
}

export function metricIdsOf(c: Condition): string[] {
  if (c.kind === 'compare' || c.kind === 'zscore') return [c.metricId];
  if (c.kind === 'not') return metricIdsOf(c.term);
  return (c.terms ?? []).flatMap(metricIdsOf);
}

/* -------------------------------------------------------------------------------------------------- proof */

export type PipeState = 'done' | 'active' | 'pending' | 'failed';
export type PipeStep = { key: 'submitted' | 'ran' | 'attestation' | 'quote'; label: string; state: PipeState };

const PIPE: { key: PipeStep['key']; label: string }[] = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'ran', label: 'Ran in secure hardware' },
  { key: 'attestation', label: 'Attestation fetched' },
  { key: 'quote', label: 'Quote verified' },
];

/**
 * Where a proof is in its four stages. Each stage is done only on evidence the proof carries (a request id, an output
 * hash, the hardware measurements, an accepting decision). While running, the first stage without evidence is active;
 * when the proof stopped without finishing, that stage is the one that failed and the rest stay pending.
 */
export function proofPipeline(p: Proof | null | undefined): PipeStep[] {
  const done: boolean[] = p
    ? [
        true,
        !!p.outputSha256 || p.state === 'verified' || p.state === 'not_attested' || (p.state === 'failed' && !!p.verification.mrTd),
        !!p.verification.mrTd || !!p.verification.rtmr3 || p.state === 'verified',
        p.state === 'verified' && p.verification.decision !== 'reject',
      ]
    : [false, false, false, false];
  // A later stage with evidence means the earlier ones happened.
  for (let i = done.length - 2; i >= 0; i--) if (done[i + 1]) done[i] = true;
  const first = done.indexOf(false);
  return PIPE.map((s, i) => {
    if (done[i]) return { ...s, state: 'done' as const };
    if (!p || i !== first) return { ...s, state: 'pending' as const };
    return { ...s, state: p.state === 'running' ? ('active' as const) : ('failed' as const) };
  });
}

/* -------------------------------------------------------------------------------------------------- text bits */

/** A marker's one-line title: the question without the "From the assistant's investigation" lead-in. */
export function markerTitle(question: string | null | undefined): string {
  const q = (question ?? '').trim();
  if (!q) return 'Marker';
  return q.replace(/^from the assistant['\u2019]s investigation:\s*/i, '').trim() || 'Marker';
}

export function markerAt(a: { kind?: string; at?: string; start?: string; end?: string } | null | undefined): string | null {
  if (!a) return null;
  return a.at ?? a.start ?? null;
}

/** Split a sentence into plain text and the numbers in it, so the numbers can be set heavier. */
export function emphasiseNumbers(text: string): { text: string; num: boolean }[] {
  const out: { text: string; num: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?|\d[\d,]*(?:\.\d+)?%?/g)) {
    // A date reads as one token of context, not three numbers.
    if (/^\d{4}-/.test(m[0])) continue;
    const at = m.index!;
    if (at > last) out.push({ text: text.slice(last, at), num: false });
    out.push({ text: m[0], num: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), num: false });
  return out;
}

/** Items created inside a step's time window: the fallback for a task that has no refs. */
export function createdWithin<T>(items: T[], at: (x: T) => string | null | undefined, from: string | null, to: string | null, slackMs = 2000): T[] {
  if (!from) return [];
  const a = Date.parse(from) - slackMs;
  const b = (to ? Date.parse(to) : Date.now()) + slackMs;
  return items.filter((x) => {
    const t = Date.parse(at(x) ?? '');
    return Number.isFinite(t) && t >= a && t <= b;
  });
}

export function timeAgoShort(sec: number | null): string {
  if (sec === null) return 'unknown';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
}

/** The question a step's plain-language detail quotes ("Starts a live investigation of "…" with…"). */
export function quotedText(detail: string | null | undefined): string | null {
  const m = /["“]([^"”]{3,})["”]/.exec(detail ?? '');
  return m ? m[1]!.trim() : null;
}

/** Findings status in the words a reader uses. */
export const FINDING_STATUS_LABEL: Record<string, string> = { supported: 'supported', mixed: 'mixed', insufficient_data: 'insufficient data', cannot_compute: 'cannot compute', contradicted: 'contradicted', unverified: 'unverified' };
export const FINDING_STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = { supported: 'ok', mixed: 'warn', insufficient_data: 'info', cannot_compute: 'info', contradicted: 'bad', unverified: 'warn' };

/* -------------------------------------------------------------------------------------------------- thesis */

export const THESIS_TONE: Record<string, 'ok' | 'bad' | 'info' | 'warn'> = { SUPPORTED: 'ok', NOT_SUPPORTED: 'bad', MIXED: 'info', INSUFFICIENT_DATA: 'warn' };
export const THESIS_VERDICT_LABEL: Record<string, string> = { SUPPORTED: 'supported', NOT_SUPPORTED: 'not supported', MIXED: 'mixed', INSUFFICIENT_DATA: 'insufficient data' };

export type ThesisView = {
  hypothesis: string | null;
  verdict: string | null;
  headline: string | null;
  charts: number | null;
  claims: number | null;
  n: number | null;
  window: string | null;
  pearson: number | null;
  lag7: number | null;
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** What the tile shows, read tolerantly from a `nearesis.thesis.v1` document. Anything absent stays null (shown as unknown). */
export function thesisView(doc: unknown): ThesisView {
  const d = rec(doc);
  const v = rec(d.verdict);
  const t = d.test === undefined || d.test === null ? null : rec(d.test);
  const lag = t && Array.isArray(t.lag) ? t.lag.map(rec).find((x) => fin(x.days) === 7) : undefined;
  const w = t?.window;
  const wo = rec(w);
  const window = typeof w === 'string' ? w : typeof wo.from === 'string' && typeof wo.to === 'string' ? `${wo.from.slice(0, 10)} to ${wo.to.slice(0, 10)}` : null;
  return {
    hypothesis: typeof d.hypothesis === 'string' ? d.hypothesis : null,
    verdict: typeof v.status === 'string' ? v.status : null,
    headline: typeof v.headline === 'string' ? v.headline : null,
    charts: Array.isArray(d.charts) ? d.charts.length : null,
    claims: Array.isArray(d.claims) ? d.claims.length : null,
    n: t ? fin(t.n) : null,
    window,
    pearson: t ? fin(t.pearson) : null,
    lag7: lag ? fin(lag.value) : null,
  };
}

export type CompareRow = { what: string; original: string | null; reproduced: string | null; delta: string | null };
export type CompareOutcome = 'match' | 'drift' | 'different' | 'unknown';

/** Comparison rows from a step's result items. Without separate fields, "original | reproduced | delta" in the value is split. */
export function compareRows(items: { label: string; value: string; original?: string; reproduced?: string; delta?: string }[]): CompareRow[] {
  return items.map((i) => {
    if (i.original !== undefined || i.reproduced !== undefined || i.delta !== undefined) return { what: i.label, original: i.original ?? null, reproduced: i.reproduced ?? null, delta: i.delta ?? null };
    // the agent writes "original X; reproduced Y; delta Z" (a missing value reads "not available", a missing delta is left out)
    const m = /^original\s+(.*?);\s*reproduced\s+(.*?)(?:;\s*delta\s+(.*))?$/i.exec(i.value.trim());
    if (m) {
      const v = (x: string | undefined) => (x === undefined || /^not available$/i.test(x.trim()) ? null : x.trim());
      return { what: i.label, original: v(m[1]), reproduced: v(m[2]), delta: v(m[3]) };
    }
    const parts = i.value.split(/\s*(?:\||\u2192|->)\s*/);
    return parts.length >= 2 ? { what: i.label, original: parts[0] || null, reproduced: parts[1] || null, delta: parts[2] || null } : { what: i.label, original: null, reproduced: i.value || null, delta: null };
  });
}

export function compareOutcome(summary: string | null | undefined): CompareOutcome {
  const s = (summary ?? '').toLowerCase();
  if (/\bmatch/.test(s)) return 'match';
  if (/\bdrift/.test(s)) return 'drift';
  if (/\bdifferent|differ/.test(s)) return 'different';
  return 'unknown';
}

export const thesisPathOf = (items: { href: string | null }[] | undefined, prefix: string): string | null => items?.find((i) => i.href?.startsWith(prefix))?.href ?? null;
