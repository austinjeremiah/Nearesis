import { normalizeAnswer, type AgentAnswer } from './types';

/**
 * Wire shapes of the server-side agent (threads, messages, tasks, costs) and tolerant normalisers. A missing value stays
 * unknown (null or empty); a missing amount is never turned into zero. Amounts are USD decimal strings with
 * up to 6 places.
 */

export type ConsentKey = 'spend_credits' | 'publish_public' | 'freeze_hypothesis' | 'archive_workspace';
export type TaskState = 'proposed' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
export type StepState = 'pending' | 'running' | 'waiting_user' | 'done' | 'failed' | 'skipped';
export type MessageKind = 'text' | 'answer' | 'plan' | 'result' | 'notice';

export type Thread = { id: string; title: string; workspaceId: string | null; updatedAt: string | null; preview: string; activeTaskId: string | null };

/** `original`, `reproduced` and `delta` are carried by the rows of a thesis comparison. */
export type ResultItem = { label: string; value: string; href: string | null; original?: string; reproduced?: string; delta?: string };
/** One cost line. Amounts are USD decimal strings; `detail` may carry the NEAR amount and the rate it was converted at. */
export type CostEntry = { label: string; unit: 'usd'; amount: string | null; txHash: string | null; detail: Record<string, unknown> | null };

/** Ids of what a finished step produced. Every field is optional: tasks finished before the server sent refs have none. */
export type StepRefs = {
  workspaceId?: string;
  runId?: string;
  capsuleId?: string;
  proofId?: string;
  publicationId?: string;
  hypothesisId?: string;
  thesisId?: string;
  markerIds?: string[];
  monitorIds?: string[];
  skipped?: { kind: string; reason: string }[];
};

export type TaskStep = {
  idx: number;
  key: string;
  title: string;
  detail: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null;
  result: { summary: string; items: ResultItem[]; refs: StepRefs } | null;
  waiting: { kind: string; runId: string; approvalId: string; approvalKind: string; summary: string; costLimit: string | null } | null;
  /** `creditsUsd` is the on-chain part (OutLayer, gas); what the account is charged for the step is model + on-chain. */
  cost: { modelUsd: string | null; modelCalls: number | null; creditsUsd: string | null; entries: CostEntry[] };
  error: { reasonCode: string; message: string; retryable: boolean } | null;
};

export type ConsentRequirement = { key: ConsentKey; label: string; detail: string; maxUsd: string | null };

export type Task = {
  id: string;
  threadId: string;
  workspaceId: string | null;
  title: string;
  state: TaskState;
  currentStep: number;
  steps: TaskStep[];
  consent: { required: ConsentRequirement[]; given: string[] };
  estimate: { creditsMaxUsd: string | null; modelUsdMax: string | null };
  cost: { modelUsd: string | null; modelCalls: number | null; creditsUsd: string | null; creditsHeldUsd: string | null; entries: CostEntry[] };
  links: { workspaceId: string | null; runId: string | null; capsuleId: string | null; proofId: string | null; publicationId: string | null; reportUrl: string | null; thesisId: string | null };
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  state: 'pending' | 'ready' | 'failed';
  createdAt: string | null;
  kind: MessageKind;
  text: string | null;
  answer: AgentAnswer | null;
  taskId: string | null;
  /** Result rows of a `result` message; null when the server sent none. */
  rows: ResultItem[] | null;
  cost: { modelUsd: string | null; modelCalls: number | null };
  error: { reasonCode: string; message: string } | null;
};

export type ThreadDetail = { thread: Thread; messages: ThreadMessage[]; tasks: Task[] };

export type CostRow = { id: string; at: string | null; threadId: string | null; taskId: string | null; stepIdx: number | null; stepKey: string | null; label: string; unit: 'usd'; amount: string | null; txHash: string | null; detail: Record<string, unknown> | null };
export type Costs = { totals: { modelUsd: string | null; modelCalls: number | null; onChainUsd: string | null; totalUsd: string | null }; items: CostRow[] };

type R = Record<string, unknown>;
const obj = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const arr = (v: unknown): R[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.find((x) => x === v) ?? d);
/** An amount: a decimal string (a bare number is accepted and stringified), else unknown. */
const amount = (v: unknown): string | null => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null);

export function normalizeThread(raw: unknown): Thread {
  const r = obj(raw);
  return { id: str(r.id) ?? '', title: str(r.title) ?? 'Untitled', workspaceId: str(r.workspaceId), updatedAt: str(r.updatedAt), preview: str(r.preview) ?? '', activeTaskId: str(r.activeTaskId) };
}

const STEP_STATES = ['pending', 'running', 'waiting_user', 'done', 'failed', 'skipped'] as const;
const TASK_STATES = ['proposed', 'running', 'waiting_user', 'completed', 'failed', 'cancelled'] as const;
const CONSENT_KEYS = ['spend_credits', 'publish_public', 'freeze_hypothesis', 'archive_workspace'] as const;

function normalizeEntries(v: unknown): CostEntry[] {
  return arr(v).map((x) => ({
    label: str(x.label) ?? '',
    unit: 'usd' as const,
    // An entry in another unit (an API that predates USD credits) is unknown, never mislabelled as dollars.
    amount: x.unit === undefined || x.unit === 'usd' ? amount(x.amount) : null,
    txHash: str(x.txHash),
    detail: x.detail && typeof x.detail === 'object' && !Array.isArray(x.detail) ? (x.detail as R) : null,
  }));
}

function normalizeItems(v: unknown): ResultItem[] {
  const text = (x: unknown) => str(x) ?? (num(x) !== null ? String(num(x)) : undefined);
  return arr(v).map((i) => {
    const out: ResultItem = { label: str(i.label) ?? str(i.what) ?? '', value: text(i.value) ?? '', href: str(i.href) };
    for (const k of ['original', 'reproduced', 'delta'] as const) {
      const t = text(i[k]);
      if (t !== undefined) out[k] = t;
    }
    return out;
  });
}

/** Tolerant: a field of the wrong type is dropped, never guessed. An empty id list stays an empty list. */
export function normalizeRefs(raw: unknown): StepRefs {
  const r = obj(raw);
  const out: StepRefs = {};
  for (const k of ['workspaceId', 'runId', 'capsuleId', 'proofId', 'publicationId', 'hypothesisId', 'thesisId'] as const) {
    const v = str(r[k]);
    if (v) out[k] = v;
  }
  for (const k of ['markerIds', 'monitorIds'] as const) {
    if (Array.isArray(r[k])) out[k] = (r[k] as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '');
  }
  if (Array.isArray(r.skipped)) out.skipped = arr(r.skipped).map((x) => ({ kind: str(x.kind) ?? 'item', reason: str(x.reason) ?? 'No reason was given.' }));
  return out;
}

function normalizeStep(raw: unknown, i: number): TaskStep {
  const r = obj(raw);
  const res = r.result && typeof r.result === 'object' ? obj(r.result) : null;
  const w = r.waiting && typeof r.waiting === 'object' ? obj(r.waiting) : null;
  const c = obj(r.cost);
  const e = r.error && typeof r.error === 'object' ? obj(r.error) : null;
  return {
    idx: num(r.idx) ?? i,
    key: str(r.key) ?? '',
    title: str(r.title) ?? str(r.key) ?? `Step ${i + 1}`,
    detail: str(r.detail) ?? '',
    state: oneOf(r.state, STEP_STATES, 'pending'),
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    progress: str(r.progress),
    result: res ? { summary: str(res.summary) ?? '', items: normalizeItems(res.items), refs: normalizeRefs(res.refs) } : null,
    waiting: w ? { kind: str(w.kind) ?? 'approval', runId: str(w.runId) ?? '', approvalId: str(w.approvalId) ?? '', approvalKind: str(w.approvalKind) ?? 'approval', summary: str(w.summary) ?? '', costLimit: str(w.costLimit) } : null,
    cost: {
      modelUsd: amount(c.modelUsd),
      modelCalls: num(c.modelCalls),
      creditsUsd: amount(c.creditsUsd),
      entries: normalizeEntries(c.entries),
    },
    error: e ? { reasonCode: str(e.reasonCode) ?? 'UNKNOWN', message: str(e.message) ?? 'The step failed.', retryable: e.retryable !== false } : null,
  };
}

export function normalizeTask(raw: unknown): Task {
  const r = obj(raw);
  const consent = obj(r.consent);
  const est = obj(r.estimate);
  const cost = obj(r.cost);
  const links = obj(r.links);
  return {
    id: str(r.id) ?? '',
    threadId: str(r.threadId) ?? '',
    workspaceId: str(r.workspaceId),
    title: str(r.title) ?? 'Task',
    state: oneOf(r.state, TASK_STATES, 'proposed'),
    currentStep: num(r.currentStep) ?? 0,
    steps: (Array.isArray(r.steps) ? r.steps : []).map(normalizeStep),
    consent: {
      required: arr(consent.required).flatMap((c) => {
        const key = CONSENT_KEYS.find((k) => k === c.key);
        return key ? [{ key, label: str(c.label) ?? key, detail: str(c.detail) ?? '', maxUsd: amount(c.maxUsd) }] : [];
      }),
      given: (Array.isArray(consent.given) ? consent.given : []).filter((x): x is string => typeof x === 'string'),
    },
    estimate: { creditsMaxUsd: amount(est.creditsMaxUsd), modelUsdMax: amount(est.modelUsdMax) },
    cost: { modelUsd: amount(cost.modelUsd), modelCalls: num(cost.modelCalls), creditsUsd: amount(cost.creditsUsd), creditsHeldUsd: amount(cost.creditsHeldUsd), entries: normalizeEntries(cost.entries) },
    links: { workspaceId: str(links.workspaceId), runId: str(links.runId), capsuleId: str(links.capsuleId), proofId: str(links.proofId), publicationId: str(links.publicationId), reportUrl: str(links.reportUrl), thesisId: str(links.thesisId) },
    createdAt: str(r.createdAt),
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
  };
}

export function normalizeMessage(raw: unknown): ThreadMessage {
  const r = obj(raw);
  const c = obj(r.cost);
  const e = r.error && typeof r.error === 'object' ? obj(r.error) : null;
  const kind = oneOf(r.kind, ['text', 'answer', 'plan', 'result', 'notice'] as const, 'text');
  const rowsRaw = r.rows ?? (r.result && typeof r.result === 'object' ? obj(r.result).items : undefined) ?? r.items;
  return {
    id: str(r.id) ?? '',
    role: r.role === 'user' ? 'user' : 'assistant',
    state: oneOf(r.state, ['pending', 'ready', 'failed'] as const, 'ready'),
    createdAt: str(r.createdAt),
    kind,
    text: str(r.text),
    answer: r.answer && typeof r.answer === 'object' ? normalizeAnswer(r.answer) : null,
    taskId: str(r.taskId),
    rows: Array.isArray(rowsRaw) ? normalizeItems(rowsRaw) : null,
    cost: { modelUsd: amount(c.modelUsd), modelCalls: num(c.modelCalls) },
    error: e ? { reasonCode: str(e.reasonCode) ?? 'UNKNOWN', message: str(e.message) ?? 'The agent could not answer.' } : null,
  };
}

export function normalizeThreadDetail(raw: unknown): ThreadDetail {
  const r = obj(raw);
  return { thread: normalizeThread(r.thread), messages: arr(r.messages).map(normalizeMessage), tasks: arr(r.tasks).map(normalizeTask) };
}

export function normalizeCosts(raw: unknown): Costs {
  const r = obj(raw);
  const t = obj(r.totals);
  return {
    totals: { modelUsd: amount(t.modelUsd), modelCalls: num(t.modelCalls), onChainUsd: amount(t.onChainUsd), totalUsd: amount(t.totalUsd) },
    items: arr(r.items).map((x, i) => ({
      id: str(x.id) ?? `c${i}`,
      at: str(x.at),
      threadId: str(x.threadId),
      taskId: str(x.taskId),
      stepIdx: num(x.stepIdx),
      stepKey: str(x.stepKey),
      label: str(x.label) ?? 'cost',
      unit: 'usd' as const,
      // An entry in another unit (an API that predates USD credits) is unknown, never mislabelled as dollars.
      amount: x.unit === undefined || x.unit === 'usd' ? amount(x.amount) : null,
      txHash: str(x.txHash),
      detail: x.detail && typeof x.detail === 'object' && !Array.isArray(x.detail) ? (x.detail as R) : null,
    })),
  };
}
