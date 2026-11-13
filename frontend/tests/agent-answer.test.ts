import { describe, it, expect } from 'vitest';
import { buildHistory, chartPoints, normalizeAnswer, normalizeSetup } from '@/lib/agent/types';
import { capTurns, loadTurns, saveTurns, MAX_TURNS, STORAGE_KEY, type Turn } from '@/lib/agent/storage';
import { newPipeline } from '@/lib/agent/pipeline';

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

describe('conversation storage', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  const user = (i: number): Turn => ({ id: `u${i}`, kind: 'user', text: `q${i}`, at: i });
  it('caps the number of turns, keeping the newest', () => {
    const t = capTurns(Array.from({ length: MAX_TURNS + 10 }, (_, i) => user(i)));
    expect(t).toHaveLength(MAX_TURNS);
    expect(t[t.length - 1].id).toBe(`u${MAX_TURNS + 9}`);
  });
  it('round-trips, marks a running pipeline interrupted, and survives broken storage', () => {
    const s = mem();
    const p = newPipeline('obj', () => 'k', 1);
    saveTurns(s, [user(1), { id: 'p', kind: 'pipeline', pipeline: p, at: 2 }]);
    const back = loadTurns(s);
    expect(back).toHaveLength(2);
    expect(back[1].kind === 'pipeline' && back[1].pipeline.phase).toBe('interrupted');
    s.m.set(STORAGE_KEY, '{not json');
    expect(loadTurns(s)).toEqual([]);
    expect(() => saveTurns({ setItem: () => { throw new Error('quota'); }, removeItem: () => {} }, [user(1)])).not.toThrow();
    expect(loadTurns(null)).toEqual([]);
  });
  it('clears the key when the conversation is empty', () => {
    const s = mem();
    saveTurns(s, [user(1)]);
    saveTurns(s, []);
    expect(s.m.has(STORAGE_KEY)).toBe(false);
  });
});

import { CTX_KEY, loadContext, saveContext } from '@/lib/agent/storage';
describe('context storage', () => {
  it('remembers the selected workspace, defaults to quick answers, and keeps run turns', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    expect(loadContext(s)).toBe('quick');
    saveContext(s, '17cd0234-3625-49b9-9daa-97293bb3ecd7');
    expect(m.get(CTX_KEY)).toBe('17cd0234-3625-49b9-9daa-97293bb3ecd7');
    expect(loadContext(s)).toBe('17cd0234-3625-49b9-9daa-97293bb3ecd7');
    expect(loadContext(null)).toBe('quick');
    const run: Turn = { id: 'r', kind: 'run', workspaceId: 'w', runId: 'x', question: 'q', at: 1 };
    saveTurns(s, [run]);
    expect(loadTurns(s)).toEqual([run]);
  });
});
