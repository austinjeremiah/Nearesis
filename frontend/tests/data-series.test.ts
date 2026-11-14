import { describe, expect, it } from 'vitest';
import { periodChange, tailMean, tailSum } from '@/components/nx/data/series';

const days = (n: number, f: (i: number) => number | null, start = Date.UTC(2026, 0, 1)) =>
  Array.from({ length: n }, (_, i) => ({ x: new Date(start + i * 86_400_000).toISOString().slice(0, 10), y: f(i) }));

describe('periodChange', () => {
  it('compares the last n days with the n before', () => {
    const r = periodChange(days(4, (i) => (i < 2 ? 10 : 15)), 2);
    expect(r).toEqual({ current: 30, previous: 20, pct: 50, days: 2 });
  });
  it('is unavailable when a value is unknown, a day is missing or too few days exist', () => {
    expect(periodChange(days(4, (i) => (i === 1 ? null : 5)), 2)).toBeNull();
    const gap = days(4, () => 5);
    gap.splice(2, 1);
    expect(periodChange([...gap, { x: '2026-01-09', y: 5 }], 2)).toBeNull();
    expect(periodChange(days(3, () => 5), 2)).toBeNull();
  });
  it('excludes incomplete days and gives no percentage over a zero base', () => {
    expect(periodChange(days(4, () => 5), 2, new Set(['2026-01-04']))).toBeNull();
    expect(periodChange(days(4, (i) => (i < 2 ? 0 : 3)), 2)?.pct).toBeNull();
  });
});

describe('tail helpers', () => {
  it('ignore unknown values and never return a zero for none', () => {
    expect(tailMean(days(3, (i) => (i === 0 ? null : 4)), 3)).toEqual({ mean: 4, count: 2 });
    expect(tailSum(days(2, () => null), 2)).toBeNull();
  });
});
