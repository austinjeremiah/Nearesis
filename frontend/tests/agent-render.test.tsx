import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment } from 'react';
import { AnswerBody, AnswerMeta, ChartBody, ChartMeta } from '@/components/nx/agent/answer-card';
import { PipelineCard } from '@/components/nx/agent/pipeline-card';
import { normalizeAnswer } from '@/lib/agent/types';
import { newPipeline } from '@/lib/agent/pipeline';

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

describe('pipeline card', () => {
  it('shows a retry with the API reason on failure', () => {
    const p = newPipeline('obj', () => 'k', 0);
    const failed = { ...p, phase: 'failed' as const, workspaceId: 'w', error: { step: 'setup' as const, message: 'budget ceiling reached' } };
    const h = renderToStaticMarkup(createElement(PipelineCard, { p: failed, onResume: () => {}, onRetry: () => {} }));
    expect(h).toContain('budget ceiling reached');
    expect(h).toContain('agent-retry');
  });
});
