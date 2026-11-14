import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment } from 'react';
import { AnswerBody, AnswerMeta, ChartBody, ChartMeta } from '@/components/nx/agent/answer-card';
import { normalizeAnswer } from '@/lib/agent/types';

const answer = normalizeAnswer({
  answerId: 'a',
  status: 'partial',
  summary: 'Volume rose.',
  charts: [
    { id: 'c1', title: 'Daily swaps', kind: 'line', unit: 'swaps', x: ['d1', 'd2'], series: [{ name: 's', values: ['1', null] }], source: 'intents', window: { from: '2026-08-01', to: '2026-08-02' }, coverage: '1/2 days', metricVersion: 'v1', caveats: ['gap on d2'] },
    { id: 'c2', title: 'Routes', kind: 'table', columns: ['route', 'vol'], rows: [['a>b', null]], source: 'intents', caveats: [] },
  ],
  findings: [{ statement: 'It rose.', basis: 'inference', status: 'mixed', chartIds: ['c1'], facts: [{ value: '1', unit: null }], limitations: ['small sample'], skepticNotes: ['check'], skepticVerdict: 'weakened' }],
  limitations: ['Only 2 days.'],
  steps: [{ tool: 't', label: 'Read the trend', outcome: 'error', ms: 5 }],
  cost: { usd: null, modelCalls: 1 },
  suggestedWorkspaceObjective: 'x',
});

describe('answer rendering', () => {
  const html = renderToStaticMarkup(createElement(AnswerBody, { a: answer }));
  it('shows summary, provenance, caveats, finding badges and the steps line', () => {
    expect(html).toContain('Volume rose.');
    expect(html).toContain('skeptic: weakened');
    expect(html).toContain('Limitations (1)');
    expect(html).toContain('Skeptic notes (1)');
    expect(html).toContain('What the agent did');
    expect(html).toContain('Read the trend');
    expect(html).toContain('5 ms');
    expect(html).toContain('Charts in the canvas');
    expect(html).toContain('partial answer');
  });
  it('keeps the charts out of the chat and offers chips instead', () => {
    expect(html).not.toContain('agent-chart"');
    expect(html).toContain('Daily swaps');
  });
  it('renders chart provenance and a null table cell as an em dash, not 0', () => {
    const c = renderToStaticMarkup(createElement(Fragment, null, ...answer.charts.map((x) => createElement('div', { key: x.id }, createElement(ChartBody, { c: x }), createElement(ChartMeta, { c: x })))));
    expect(c).toContain('gap on d2');
    expect(c).toContain('1/2 days');
    expect(c).toContain('—');
    expect(c).not.toMatch(/>0</);
  });
  it('unknown cost renders as a dash', () => {
    expect(renderToStaticMarkup(createElement(AnswerMeta, { a: answer }))).toContain('— · 1 model call(s) · —');
  });
  it('cannot_answer shows the reason plainly', () => {
    const h = renderToStaticMarkup(createElement(AnswerBody, { a: normalizeAnswer({ status: 'cannot_answer', cannotAnswerReason: 'No staking data is indexed; swaps and accounts are.' }) }));
    expect(h).toContain('No staking data is indexed');
    expect(h).toContain('agent-cannot-answer');
  });
  it('withholds a missing summary honestly', () => {
    const h = renderToStaticMarkup(createElement(AnswerBody, { a: { ...answer, summary: null } }));
    expect(h).toContain('agent-no-summary');
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanCard, TaskTimeline } from '@/components/nx/agent/task-cards';
import { normalizeTask } from '@/lib/agent/thread';

const wrap = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));
const mk = (over: Record<string, unknown>) =>
  normalizeTask({
    id: 't1',
    threadId: 'th',
    workspaceId: 'w1',
    title: 'Prove a capsule',
    state: 'proposed',
    steps: [
      { idx: 0, key: 'capsule.build', title: 'Build the capsule', detail: 'from run r1', state: 'pending' },
      { idx: 1, key: 'capsule.prove', title: 'Prove it', detail: 'OutLayer', state: 'pending' },
    ],
    consent: { required: [{ key: 'spend_credits', label: 'Spend credits', detail: 'For the proof job.', maxUsd: '0.050000' }], given: [] },
    estimate: { creditsMaxUsd: '0.050000', modelUsdMax: '0.100000' },
    ...over,
  });

describe('plan card', () => {
  it('lists numbered steps, estimates in USD, and a consent checkbox with the max amount of credits; Start is disabled', () => {
    const h = wrap(createElement(PlanCard, { task: mk({}) }));
    expect(h).toContain('Build the capsule');
    expect(h).toContain('$0.05');
    expect(h).toContain('up to $0.05 of your credits');
    expect(h).not.toContain('NEAR');
    expect(h).toContain('$0.10');
    expect(h).toContain('Spend credits');
    expect(h).toContain('type="checkbox"');
    expect(h).toMatch(/<button[^>]*disabled[^>]*data-testid="plan-start"|data-testid="plan-start"[^>]*disabled/);
  });
  it('shows unknown estimates as unknown', () => {
    const h = wrap(createElement(PlanCard, { task: mk({ estimate: {} }) }));
    expect(h).toContain('unknown');
  });
});

describe('task timeline', () => {
  const running = mk({
    state: 'running',
    startedAt: '2026-11-14T10:00:00.000Z',
    steps: [
      { idx: 0, key: 'capsule.build', title: 'Build the capsule', state: 'done', startedAt: '2026-11-14T10:00:00.000Z', finishedAt: '2026-11-14T10:00:05.000Z', result: { summary: 'Built', items: [{ label: 'Capsule', value: 'c1', href: '/w/w1/capsules/c1' }] }, cost: { modelUsd: '0.002000', modelCalls: 1, creditsUsd: '0.000500', entries: [{ label: 'gas', unit: 'usd', amount: '0.0005', txHash: 'HASH123456', detail: { tokensBurntYocto: '1000000000000000000000', nearUsdRate: '5', rateDate: '2026-11-13' } }] } },
      { idx: 1, key: 'capsule.prove', title: 'Prove it', state: 'running', startedAt: '2026-11-14T10:00:05.000Z', progress: 'Waiting for the proof job' },
    ],
  });
  it('marks the running step, its progress line, result links, cost and tx link', () => {
    const h = wrap(createElement(TaskTimeline, { task: running }));
    expect(h).toContain('aria-current="step"');
    expect(h).toContain('Waiting for the proof job');
    expect(h).toContain('Step 2 of 2 · Waiting for the proof job');
    expect(h).toContain('href="/w/w1/capsules/c1"');
    expect(h).toContain('$0.0005');
    expect(h).toContain('$0.0025');
    expect(h).toContain('0.001 NEAR at $5 per NEAR on 2026-11-13');
    expect(h).toContain('https://testnet.nearblocks.io/txns/HASH123456');
    expect(h).toContain('Cancel task');
    expect(h).not.toContain('/api/report/');
    expect(h).not.toMatch(/PDF report|Open report/);
  });
  it('a finished task offers the thesis, never the report', () => {
    const t = mk({ state: 'completed', workspaceId: 'w1', links: { workspaceId: 'w1', thesisId: 'th1' }, steps: [] });
    const h = wrap(createElement(TaskTimeline, { task: t }));
    expect(h).toContain('href="/thesis/th1/document"');
    expect(h).toContain('Download thesis PDF');
    expect(h).toContain('/api/thesis/th1/pdf');
    expect(h).not.toMatch(/report/i);
  });
  it('a finished task with no thesis offers one primary Build thesis button', () => {
    const t = mk({ state: 'completed', workspaceId: 'w1', links: { workspaceId: 'w1' }, steps: [] });
    const h = wrap(createElement(TaskTimeline, { task: t }));
    expect(h).toContain('Build thesis');
    expect(h).not.toMatch(/report/i);
  });
  it('shows a waiting approval with Approve and Reject, and a failed step with reason and Retry', () => {
    const w = mk({ state: 'waiting_user', steps: [{ idx: 0, key: 'run.await', title: 'Wait', state: 'waiting_user', waiting: { kind: 'approval', runId: 'r', approvalId: 'a', approvalKind: 'canvas.apply_patch', summary: 'Apply panels', costLimit: '1.5' } }] });
    const h = wrap(createElement(TaskTimeline, { task: w }));
    expect(h).toContain('Approve');
    expect(h).toContain('Reject');
    expect(h).toContain('canvas.apply_patch');
    expect(h).toContain('$1.50');
    const f = mk({ state: 'failed', steps: [{ idx: 0, key: 'capsule.prove', title: 'Prove', state: 'failed', error: { reasonCode: 'INSUFFICIENT_CREDITS', message: 'Not enough credits', retryable: true } }] });
    const hf = wrap(createElement(TaskTimeline, { task: f }));
    expect(hf).toContain('INSUFFICIENT_CREDITS');
    expect(hf).toContain('Not enough credits');
    expect(hf).toContain('step-retry');
    expect(hf).not.toContain('Cancel task');
  });
  it('a step failed for credits shows the message and a button that opens the popup', () => {
    const f = mk({ state: 'failed', steps: [{ idx: 0, key: 'capsule.prove', title: 'Prove', state: 'failed', error: { reasonCode: 'CREDITS_EXHAUSTED', message: 'You have used your credits. Write to connect@kaushikh.xyz to request more access.', retryable: false } }] });
    const hf = wrap(createElement(TaskTimeline, { task: f }));
    expect(hf).toContain('You have used your credits.');
    expect(hf).toContain('step-credits-request');
    expect(hf).not.toContain('step-retry');
  });
});
