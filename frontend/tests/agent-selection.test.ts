import { describe, it, expect } from 'vitest';
import { answerFindingKey, chartHighlighted, chartKey, findingHighlighted, findingsCiting, missingCount, panelKey, selectAnswerChart, selectAnswerFinding, toggle } from '@/lib/agent/selection';
import { normalizeAnswer } from '@/lib/agent/types';

const a = normalizeAnswer({
  status: 'ok',
  charts: [
    { id: 'c1', title: 'A', kind: 'line', x: ['d1', 'd2', 'd3'], series: [{ name: 's', values: ['1', null, '3'] }] },
    { id: 'c2', title: 'B', kind: 'table', columns: ['x'], rows: [['1'], [null]] },
  ],
  findings: [
    { statement: 'one', chartIds: ['c1'] },
    { statement: 'two', chartIds: ['c1', 'c2', 'ghost'] },
  ],
});

describe('finding and chart selection', () => {
  it('selecting a finding highlights its existing charts only', () => {
    const s = selectAnswerFinding('t', a, 1);
    expect(s).toEqual({ type: 'finding', id: 't#1', charts: ['t:c1', 't:c2'] });
    expect(chartHighlighted(s, chartKey('t', 'c2'))).toBe(true);
    expect(chartHighlighted(s, chartKey('t', 'c9'))).toBe(false);
    expect(findingHighlighted(s, answerFindingKey('t', 1))).toBe(true);
  });
  it('selecting a chart highlights the findings that cite it', () => {
    expect(findingsCiting('t', a, 'c1')).toEqual(['t#0', 't#1']);
    const s = selectAnswerChart('t', a, 'c2');
    expect(findingHighlighted(s, 't#1')).toBe(true);
    expect(findingHighlighted(s, 't#0')).toBe(false);
    expect(chartHighlighted(s, 't:c2')).toBe(true);
  });
  it('selecting the same thing again clears it, and workspace panels use their own keys', () => {
    const s = selectAnswerChart('t', a, 'c1');
    expect(toggle(s, selectAnswerChart('t', a, 'c1'))).toBeNull();
    expect(toggle(s, selectAnswerChart('t', a, 'c2'))?.id).toBe('t:c2');
    expect(panelKey('abc')).toBe('p:abc');
    expect(chartHighlighted(null, 'x')).toBe(false);
  });
});

describe('missingCount', () => {
  it('counts gaps in series and null table cells without turning them into zero', () => {
    expect(missingCount(a.charts[0])).toEqual({ missing: 1, total: 3 });
    expect(missingCount(a.charts[1])).toEqual({ missing: 1, total: 2 });
  });
});
