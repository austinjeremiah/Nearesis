import { formatNear, isYocto } from '@/lib/near/units';
import type { CostEntry, CostRow, Task, TaskStep, ThreadDetail } from './thread';

/** Pure state logic for the Agent tab: polling policy, the current-step line, consent, elapsed time and cost text. */

export const POLL_MS = 2000;
export const POLL_MAX_MS = 30_000;

export const taskLive = (t: Pick<Task, 'state'>) => t.state === 'running' || t.state === 'waiting_user';

/** Poll while any reply is still being written or any task is running or waiting for the user. */
export function needsPolling(d: ThreadDetail | undefined | null): boolean {
  if (!d) return false;
  return d.messages.some((m) => m.state === 'pending') || d.tasks.some(taskLive);
}

/**
 * Delay before the next poll: 2 s when healthy, doubling per consecutive failure up to 30 s; false to stop.
 * After a failure the poller keeps retrying (with back-off) only while the last known state needed polling.
 */
export function pollDelay(d: ThreadDetail | undefined | null, failures: number): number | false {
  if (!needsPolling(d)) return false;
  if (failures === 0) return POLL_MS;
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.min(failures, 5));
}

/** Consecutive-failure counter for the poller. */
export type PollState = { failures: number; lastOkAt: number | null };
export type PollEvent = { type: 'ok'; at: number } | { type: 'error' };
export function pollReducer(s: PollState, e: PollEvent): PollState {
  return e.type === 'ok' ? { failures: 0, lastOkAt: e.at } : { ...s, failures: s.failures + 1 };
}

/** The task the page is about: the running or waiting one, else the newest not yet started proposal, else the newest. */
export function focusTask(tasks: Task[]): Task | null {
  return tasks.find(taskLive) ?? [...tasks].reverse().find((t) => t.state === 'proposed') ?? tasks[tasks.length - 1] ?? null;
}

export function currentStep(t: Task): TaskStep | null {
  return t.steps.find((s) => s.state === 'running' || s.state === 'waiting_user') ?? t.steps[t.currentStep] ?? null;
}

/** "Step 3 of 7 · Waiting for the run": the running step's live progress line, else its title. */
export function stepLine(t: Task): string | null {
  if (!taskLive(t) || t.steps.length === 0) return null;
  const s = currentStep(t);
  if (!s) return null;
  const n = Math.min(s.idx + 1, t.steps.length);
  const what = s.state === 'waiting_user' ? `Waiting for you: ${s.waiting?.summary || s.title}` : s.progress || s.title;
  return `Step ${n} of ${t.steps.length} · ${what}`;
}

export const STEP_LABEL: Record<TaskStep['state'], string> = { pending: 'Not started', running: 'Running', waiting_user: 'Waiting for you', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
export const TASK_LABEL: Record<Task['state'], string> = { proposed: 'Proposed', running: 'Running', waiting_user: 'Waiting for you', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export function doneCount(t: Task): number {
  return t.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
}

/** Every required consent key must be ticked; a plan with no requirements can start straight away. */
export function consentReady(t: Task, ticked: ReadonlySet<string>): boolean {
  return t.consent.required.every((c) => ticked.has(c.key));
}
/** The consent keys sent to the start call: exactly the ticked ones that the plan asks for. */
export const consentBody = (t: Task, ticked: ReadonlySet<string>): string[] => t.consent.required.filter((c) => ticked.has(c.key)).map((c) => c.key);

/** Whole seconds between two instants; unknown when the start is missing or malformed. */
export function elapsedSeconds(startedAt: string | null, now: number, finishedAt: string | null = null): number | null {
  if (!startedAt) return null;
  const a = Date.parse(startedAt);
  const b = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 1000));
}
export function formatElapsed(sec: number | null): string {
  if (sec === null) return 'unknown';
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return `${m} min ${String(sec % 60).padStart(2, '0')} s`;
}

/** A USD decimal string with at least 2 and at most 6 places, never rounded through a float. "unknown" when not a decimal. */
export function formatUsdString(v: string | null | undefined): string {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) return 'unknown';
  const [w, f = ''] = v.split('.');
  const frac = f.slice(0, 6).replace(/0+$/, '').padEnd(2, '0');
  const lost = /[1-9]/.test(f.slice(6));
  return `$${w}.${frac}${lost ? '+' : ''}`;
}

/** NEAR credits for display: costs round up so a charge is never understated. */
export const formatCredits = (y: string | null | undefined) => (isYocto(y) ? `${formatNear(y, { round: 'up' })} NEAR` : 'unknown');

export function formatEntry(e: Pick<CostEntry, 'unit' | 'amount'>): string {
  return e.unit === 'yoctoNEAR' ? formatCredits(e.amount) : formatUsdString(e.amount);
}

export const nearblocksTx = (hash: string) => `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;

/** Per-step cost summary; an unknown amount reads "unknown", never zero. */
export function stepCostText(s: TaskStep): { usd: string; credits: string; hasAny: boolean } {
  const hasAny = s.cost.modelUsd !== null || s.cost.creditsYocto !== null || s.cost.entries.length > 0;
  return { usd: formatUsdString(s.cost.modelUsd), credits: formatCredits(s.cost.creditsYocto), hasAny };
}

/** Exact sum of the credit rows; null when any credit amount is unknown. */
export function sumCreditRows(rows: Pick<CostRow, 'unit' | 'amount'>[]): string | null {
  let t = 0n;
  for (const r of rows) {
    if (r.unit !== 'yoctoNEAR') continue;
    if (!isYocto(r.amount)) return null;
    t += BigInt(r.amount);
  }
  return t.toString();
}

/** Same-origin links only: the server may send an app path, never an arbitrary URL. */
export function safeHref(href: string | null): string | null {
  return href && href.startsWith('/') && !href.startsWith('//') ? href : null;
}

export const reportPdfHref = (wid: string) => `/api/report/${encodeURIComponent(wid)}/pdf`;
export const reportPageHref = (wid: string) => `/w/${encodeURIComponent(wid)}/report`;
