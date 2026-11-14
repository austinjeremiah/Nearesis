import { describe, it, expect } from 'vitest';
import { buildHistory, chartPoints, normalizeAnswer, normalizeSetup } from '@/lib/agent/types';

// Fixtures live only in tests: the shapes follow AGENT_TAB_CONTRACT.md section 1.
const ANSWER = {
  answerId: '6b3f1c1e-0000-4000-8000-000000000001',
  status: 'ok',
  summary: 'Swaps rose between the two dates.',
  charts: [
    { id: 'c1', title: 'Daily swaps', kind: 'line', unit: 'swaps', x: ['2026-08-15', '2026-08-16', '2026-08-17'], series: [{ name: 'swaps', values: ['10', null, '12.5'] }], columns: [], rows: [], source: 'intents', window: { from: '2026-08-15', to: '2026-08-17' }, coverage: '2/3 days', metricVersion: 'intents.v1', caveats: ['one day missing'] },
    { id: 'c2', title: 'Top routes', kind: 'table', unit: null, x: [], series: [], columns: ['route', 'volume'], rows: [['a>b', '5'], ['c>d', null]], source: 'intents', window: null, coverage: null, metricVersion: null, caveats: [] },
  ],
  findings: [{ statement: 'Up.', basis: 'observation', status: 'supported', chartIds: ['c1'], facts: [{ value: '12.5', unit: 'swaps' }], limitations: ['l'], skepticNotes: ['n'], skepticVerdict: 'holds' }],
  limitations: [],
  steps: [{ tool: 'intents.trend', label: 'Read the daily trend', outcome: 'ok', ms: 120 }],
  cannotAnswerReason: null,
  suggestedWorkspaceObjective: 'Study swap volume.',
  cost: { usd: 0.012, modelCalls: 2 },
  elapsedMs: 8200,
};

describe('normalizeAnswer', () => {
  it('keeps decimal strings and null gaps exactly', () => {
    const a = normalizeAnswer(ANSWER);
    expect(a.charts[0].series[0].values).toEqual(['10', null, '12.5']);
    expect(chartPoints(a.charts[0])[0].points.map((p) => p.y)).toEqual(['10', null, '12.5']);
    expect(a.charts[1].rows[1]).toEqual(['c>d', null]);
    expect(a.findings[0].skepticVerdict).toBe('holds');
  });
  it('pads a short series with gaps, never zeros', () => {
    const a = normalizeAnswer({ ...ANSWER, charts: [{ ...ANSWER.charts[0], series: [{ name: 's', values: ['1'] }] }] });
    expect(chartPoints(a.charts[0])[0].points.map((p) => p.y)).toEqual(['1', null, null]);
  });
  it('cannot_answer carries the reason and unknown cost stays unknown', () => {
    const a = normalizeAnswer({ status: 'cannot_answer', cannotAnswerReason: 'No data for that.', summary: null });
    expect(a.status).toBe('cannot_answer');
    expect(a.cannotAnswerReason).toBe('No data for that.');
    expect(a.cost.usd).toBeNull();
    expect(a.elapsedMs).toBeNull();
    expect(a.charts).toEqual([]);
  });
  it('treats an unknown status as cannot_answer rather than inventing an answer', () => {
    expect(normalizeAnswer({ status: 'weird' }).status).toBe('cannot_answer');
  });
  it('normalises the setup response', () => {
    const s = normalizeSetup({ markers: [{ id: 'm', title: 'Peak', reason: 'r' }], monitors: [], hypothesis: { id: 'h', title: 'T' }, skipped: [{ kind: 'monitor', reason: 'none fit' }], cost: { usd: 0, modelCalls: 0 } });
    expect(s.markers).toHaveLength(1);
    expect(s.hypothesis?.id).toBe('h');
    expect(s.skipped[0].kind).toBe('monitor');
    expect(normalizeSetup({}).hypothesis).toBeNull();
  });
});

describe('buildHistory', () => {
  it('sends at most the last 6 turns, trimmed to 2000 characters', () => {
    const turns = Array.from({ length: 5 }, (_, i) => [
      { kind: 'user', text: `q${i}` },
      { kind: 'answer', answer: normalizeAnswer({ ...ANSWER, summary: 'x'.repeat(3000) }) },
    ]).flat();
    const h = buildHistory(turns);
    expect(h).toHaveLength(6);
    expect(h[h.length - 1].role).toBe('assistant');
    expect(h[h.length - 1].text.length).toBe(2000);
  });
  it('uses the cannot-answer reason when there is no summary and skips pipelines', () => {
    const h = buildHistory([{ kind: 'pipeline' }, { kind: 'answer', answer: normalizeAnswer({ status: 'cannot_answer', cannotAnswerReason: 'why' }) }]);
    expect(h).toEqual([{ role: 'assistant', text: 'why' }]);
  });
});
