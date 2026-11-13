import type { AgentAnswer } from './types';

/**
 * Linking findings and charts. A chart is addressed by a key: `<turnId>:<chartId>` for a quick-answer chart and
 * `p:<panelId>` for a workspace panel. A finding is addressed by `<turnId>#<index>` or `f:<findingId>`.
 */
export type Selection =
  | { type: 'finding'; id: string; charts: string[] }
  | { type: 'chart'; id: string; findings: string[] }
  | null;

export const chartKey = (turnId: string, chartId: string) => `${turnId}:${chartId}`;
export const panelKey = (panelId: string) => `p:${panelId}`;
export const answerFindingKey = (turnId: string, i: number) => `${turnId}#${i}`;
export const runFindingKey = (id: string) => `f:${id}`;

export function selectAnswerFinding(turnId: string, a: AgentAnswer, i: number): Selection {
  const f = a.findings[i];
  if (!f) return null;
  return { type: 'finding', id: answerFindingKey(turnId, i), charts: f.chartIds.filter((c) => a.charts.some((x) => x.id === c)).map((c) => chartKey(turnId, c)) };
}

export function findingsCiting(turnId: string, a: AgentAnswer, chartId: string): string[] {
  return a.findings.flatMap((f, i) => (f.chartIds.includes(chartId) ? [answerFindingKey(turnId, i)] : []));
}

export function selectAnswerChart(turnId: string, a: AgentAnswer, chartId: string): Selection {
  return { type: 'chart', id: chartKey(turnId, chartId), findings: findingsCiting(turnId, a, chartId) };
}

/** Select again to clear. */
export const toggle = (cur: Selection, next: Selection): Selection => (cur && next && cur.type === next.type && cur.id === next.id ? null : next);

export const chartHighlighted = (sel: Selection, key: string) => !!sel && ((sel.type === 'finding' && sel.charts.includes(key)) || (sel.type === 'chart' && sel.id === key));
export const findingHighlighted = (sel: Selection, id: string) => !!sel && ((sel.type === 'finding' && sel.id === id) || (sel.type === 'chart' && sel.findings.includes(id)));

/** Gaps in a chart: how many values are missing (drawn as gaps or "—", never as zero). */
export function missingCount(c: { kind: string; series: { values: (string | null)[] }[]; x: string[]; rows: (string | null)[][] }): { missing: number; total: number } {
  if (c.kind === 'table') {
    const all = c.rows.flat();
    return { missing: all.filter((v) => v === null).length, total: all.length };
  }
  let missing = 0;
  let total = 0;
  for (const s of c.series) {
    for (let i = 0; i < c.x.length; i++) {
      total++;
      if ((s.values[i] ?? null) === null) missing++;
    }
  }
  return { missing, total };
}
