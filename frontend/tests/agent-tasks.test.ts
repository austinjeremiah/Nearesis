import { describe, it, expect } from 'vitest';
import { normalizeCosts, normalizeMessage, normalizeTask, normalizeThreadDetail } from '@/lib/agent/thread';
import {
  consentBody,
  consentReady,
  elapsedSeconds,
  focusTask,
  formatElapsed,
  formatEntry,
  formatUsdString,
  needsPolling,
  pollDelay,
  pollReducer,
  safeHref,
  stepCostText,
  stepLine,
  taskCostText,
  costDetailText,
} from '@/lib/agent/tasks';

const step = (over: Record<string, unknown> = {}) => ({ idx: 0, key: 'workspace.create', title: 'Create the workspace', detail: 'd', state: 'pending', ...over });
const task = (over: Record<string, unknown> = {}) =>
  normalizeTask({
    id: 't1',
    threadId: 'th1',
    title: 'Research refunds',
    state: 'running',
    currentStep: 2,
    steps: [step({ state: 'done' }), step({ idx: 1, title: 'Ask', state: 'done' }), step({ idx: 2, title: 'Wait for the run', state: 'running', progress: 'Waiting for the run (EXECUTING)', startedAt: '2026-11-14T10:00:00.000Z' }), step({ idx: 3, state: 'pending' })],
    consent: { required: [{ key: 'spend_credits', label: 'Spend credits', detail: 'proof', maxUsd: '0.050000' }, { key: 'bogus', label: 'x', detail: '' }], given: [] },
    estimate: { creditsMaxUsd: '0.050000', modelUsdMax: '0.250000' },
    cost: { modelUsd: '0.003300', modelCalls: 2, creditsUsd: '0.001200', creditsHeldUsd: '0.000005', entries: [] },
    ...over,
  });
const detail = (messages: unknown[], tasks: unknown[]) => normalizeThreadDetail({ thread: { id: 'th1', title: 'T' }, messages, tasks });

describe('polling policy', () => {
  it('polls while a reply is pending or a task is running or waiting, and stops otherwise', () => {
    expect(needsPolling(undefined)).toBe(false);
    expect(needsPolling(detail([{ id: 'm', role: 'assistant', state: 'pending' }], []))).toBe(true);
    expect(needsPolling(detail([{ id: 'm', role: 'assistant', state: 'ready' }], [task()]))).toBe(true);
    expect(needsPolling(detail([], [task({ state: 'waiting_user' })]))).toBe(true);
    expect(needsPolling(detail([{ id: 'm', role: 'assistant', state: 'ready' }], [task({ state: 'completed' }), task({ state: 'proposed' }), task({ state: 'failed' })]))).toBe(false);
  });
  it('is 2 s when healthy and backs off to 30 s on consecutive errors', () => {
    const d = detail([], [task()]);
    expect(pollDelay(d, 0)).toBe(2000);
    expect(pollDelay(d, 1)).toBe(4000);
    expect(pollDelay(d, 3)).toBe(16000);
    expect(pollDelay(d, 9)).toBe(30000);
    expect(pollDelay(detail([], [task({ state: 'completed' })]), 0)).toBe(false);
    expect(pollDelay(undefined, 2)).toBe(false);
  });
  it('reducer counts consecutive failures and resets on success', () => {
    let s = { failures: 0, lastOkAt: null as number | null };
    s = pollReducer(s, { type: 'error' });
    s = pollReducer(s, { type: 'error' });
    expect(s.failures).toBe(2);
    s = pollReducer(s, { type: 'ok', at: 7 });
    expect(s).toEqual({ failures: 0, lastOkAt: 7 });
  });
});

describe('current step and focus', () => {
  it('names the step the agent is on with its live progress line', () => {
    expect(stepLine(task())).toBe('Step 3 of 4 · Waiting for the run (EXECUTING)');
  });
  it('shows the approval a waiting step needs, and nothing for a task that is not live', () => {
    const t = task({ steps: [step({ state: 'done' }), step({ idx: 1, title: 'Approve patch', state: 'waiting_user', waiting: { kind: 'approval', runId: 'r', approvalId: 'a', approvalKind: 'canvas.apply_patch', summary: 'Apply 3 panels', costLimit: '0' } })], state: 'waiting_user' });
    expect(stepLine(t)).toBe('Step 2 of 2 · Waiting for you: Apply 3 panels');
    expect(stepLine(task({ state: 'completed' }))).toBeNull();
    expect(stepLine(task({ state: 'proposed' }))).toBeNull();
  });
  it('focuses the live task, else the newest proposal', () => {
    const a = task({ id: 'a', state: 'completed' });
    const b = task({ id: 'b', state: 'proposed' });
    const c = task({ id: 'c', state: 'running' });
    expect(focusTask([a, b, c])?.id).toBe('c');
    expect(focusTask([a, b])?.id).toBe('b');
    expect(focusTask([])).toBeNull();
  });
});

describe('consent', () => {
  it('needs every required key ticked and sends only the required, ticked keys', () => {
    const t = task({ state: 'proposed' });
    expect(t.consent.required.map((c) => c.key)).toEqual(['spend_credits']); // unknown keys are dropped
    expect(consentReady(t, new Set())).toBe(false);
    expect(consentReady(t, new Set(['spend_credits']))).toBe(true);
    expect(consentBody(t, new Set(['spend_credits', 'archive_workspace']))).toEqual(['spend_credits']);
    expect(consentReady(task({ consent: { required: [], given: [] } }), new Set())).toBe(true);
  });
});

describe('time and cost formatting', () => {
  it('computes elapsed time and refuses to invent it', () => {
    expect(elapsedSeconds('2026-11-14T10:00:00.000Z', Date.parse('2026-11-14T10:01:05.000Z'))).toBe(65);
    expect(elapsedSeconds('2026-11-14T10:00:00.000Z', 0, '2026-11-14T10:00:09.000Z')).toBe(9);
    expect(elapsedSeconds(null, 1)).toBeNull();
    expect(elapsedSeconds('nope', 1)).toBeNull();
    expect(formatElapsed(65)).toBe('1 min 05 s');
    expect(formatElapsed(9)).toBe('9 s');
    expect(formatElapsed(null)).toBe('unknown');
  });
  it('formats USD decimal strings exactly and unknown as unknown', () => {
    expect(formatUsdString('0.003300')).toBe('$0.0033');
    expect(formatUsdString('1.000000')).toBe('$1.00');
    expect(formatUsdString('0')).toBe('$0.00');
    expect(formatUsdString('0.1234567')).toBe('$0.123456+');
    expect(formatUsdString(null)).toBe('unknown');
    expect(formatUsdString('abc')).toBe('unknown');
  });
  it('formats an entry in USD; an entry in another unit (old API) is unknown, not dollars', () => {
    expect(formatEntry({ amount: '0.5' })).toBe('$0.50');
    expect(formatEntry({ amount: null })).toBe('unknown');
    const c = normalizeCosts({ items: [{ id: 'a', unit: 'yoctoNEAR', amount: '5', label: 'proof' }, { id: 'b', unit: 'usd', amount: '0.0042', label: 'model' }, { id: 'c', amount: '0.01', label: 'x' }] });
    expect(c.items.map((i) => i.amount)).toEqual([null, '0.0042', '0.01']);
  });
  it('step cost is model + on-chain in USD, exact, and unknown when a part is unknown', () => {
    const t = task({ steps: [step({ state: 'done', cost: { modelUsd: '0.001000', modelCalls: 1, creditsUsd: '0.000010', entries: [{ label: 'proof gas', unit: 'usd', amount: '0.00001', txHash: 'abc', detail: { tokensBurntYocto: '2000000000000000000000', nearUsdRate: '5.1', rateDate: '2026-11-13' } }] } }), step({ idx: 1, state: 'done' }), step({ idx: 2, state: 'done', cost: { modelUsd: '0.001000' } })] });
    expect(stepCostText(t.steps[0])).toEqual({ model: '$0.001', onChain: '$0.00001', total: '$0.00101', hasAny: true });
    expect(stepCostText(t.steps[1])).toEqual({ model: 'unknown', onChain: 'unknown', total: 'unknown', hasAny: false });
    expect(stepCostText(t.steps[2]).total).toBe('unknown');
    expect(t.steps[0].cost.entries[0].txHash).toBe('abc');
    expect(costDetailText(t.steps[0].cost.entries[0].detail)).toBe('0.002 NEAR at $5.1 per NEAR on 2026-11-13');
    expect(costDetailText(null)).toBeNull();
  });
  it('task cost shows model, on-chain, total and a non-zero hold', () => {
    expect(taskCostText(task())).toEqual({ model: '$0.0033', onChain: '$0.0012', total: '$0.0045', held: '$0.000005' });
    expect(taskCostText(task({ cost: { modelUsd: '0.5', creditsHeldUsd: '0.000000' } }))).toEqual({ model: '$0.50', onChain: 'unknown', total: 'unknown', held: null });
  });
  it('reads the USD consent limit and estimate', () => {
    const t = task();
    expect(t.consent.required[0].maxUsd).toBe('0.050000');
    expect(t.estimate.creditsMaxUsd).toBe('0.050000');
    // the old shape (yocto) leaves them unknown
    const o = normalizeTask({ id: 'o', consent: { required: [{ key: 'spend_credits', label: 'x', maxYocto: '5' }] }, estimate: { creditsMaxYocto: '5' } });
    expect(o.consent.required[0].maxUsd).toBeNull();
    expect(o.estimate.creditsMaxUsd).toBeNull();
  });
});

describe('links and normalisation', () => {
  it('allows only same-origin app paths', () => {
    expect(safeHref('/w/1/report')).toBe('/w/1/report');
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('https://evil.example')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  it('tolerates missing fields without turning them into zero', () => {
    const t = normalizeTask({ id: 'x', steps: [{ key: 'k' }] });
    expect(t.state).toBe('proposed');
    expect(t.estimate).toEqual({ creditsMaxUsd: null, modelUsdMax: null });
    expect(t.cost.modelUsd).toBeNull();
    expect(t.steps[0].cost.modelUsd).toBeNull();
    expect(t.steps[0].cost.modelCalls).toBeNull();
    const m = normalizeMessage({ id: 'm', role: 'assistant', kind: 'result', text: 'Found', result: { items: [{ label: 'WS', value: 'a', href: '/w/a' }] } });
    expect(m.rows).toEqual([{ label: 'WS', value: 'a', href: '/w/a' }]);
    expect(m.cost).toEqual({ modelUsd: null, modelCalls: null });
    const c = normalizeCosts({ totals: { modelUsd: '0.5' }, items: [{ id: 'c1', unit: 'yoctoNEAR', amount: '5', label: 'proof' }] });
    expect(c.totals).toEqual({ modelUsd: '0.5', modelCalls: null, onChainUsd: null, totalUsd: null });
    expect(c.items[0].amount).toBeNull();
    const n = normalizeCosts({ totals: { modelUsd: '0.5', modelCalls: 3, onChainUsd: '0.25', totalUsd: '0.75' }, items: [] });
    expect(n.totals).toEqual({ modelUsd: '0.5', modelCalls: 3, onChainUsd: '0.25', totalUsd: '0.75' });
  });
});
