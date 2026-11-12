import { describe, expect, it } from "vitest";
import { ChartData, ResultTruncation } from "@nearesis/contracts";
import { boundChartRows, DEFAULT_MAX_CHART_ROWS } from "../src/index.ts";

describe("max-rows rule for chart data", () => {
  it("leaves a result within the bound untouched and carries no truncation metadata", () => {
    const r = boundChartRows({ count: 500, rowAt: (i) => [i, i * 2] as [number, number], yAt: (i) => i });
    expect(r.rows).toHaveLength(500);
    expect(r.truncation).toBeUndefined();
    expect(r.downsampling).toEqual({ method: "none", originalPoints: 500 });
  });

  it("downsamples a 5-million-point series without materialising it, keeps spikes and gaps, and labels it", () => {
    const N = 5_000_000;
    const SPIKE = 3_333_333;
    const GAP = 1_234_567;
    const y = (i: number): number | null => (i === GAP ? null : i === SPIKE ? 1e9 : Math.sin(i / 1000));
    const t0 = performance.now();
    const r = boundChartRows({ count: N, rowAt: (i) => [i, y(i)] as [number, number | null], yAt: y });
    const ms = performance.now() - t0;
    expect(r.rows.length).toBeLessThanOrEqual(DEFAULT_MAX_CHART_ROWS);
    expect(r.rows.some((x) => x[0] === SPIKE)).toBe(true); // the spike survives
    expect(r.rows.some((x) => x[1] === null)).toBe(true); // the gap survives, not filled
    expect(r.downsampling).toEqual({ method: "min_max_bucket", originalPoints: N });
    expect(ResultTruncation.parse(r.truncation)).toMatchObject({
      truncated: true,
      reason: "MAX_ROWS",
      method: "min_max_bucket",
      requestedRows: N,
      returnedRows: r.rows.length,
      maxRows: DEFAULT_MAX_CHART_ROWS,
    });
    expect(ms).toBeLessThan(5000);
    // rows stay ordered by x
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i]![0]).toBeGreaterThan(r.rows[i - 1]![0]);
  });

  it("truncates a non-series result to its first rows and says so", () => {
    const r = boundChartRows({ count: 25_000, rowAt: (i) => [`row${i}`], maxRows: 1000 });
    expect(r.rows).toHaveLength(1000);
    expect(r.rows[0]).toEqual(["row0"]);
    expect(r.truncation).toMatchObject({
      method: "truncate",
      requestedRows: 25_000,
      returnedRows: 1000,
      maxRows: 1000,
    });
  });

  it("the truncation block is part of the ChartData contract (additive, optional)", () => {
    const base = {
      panelId: "11111111-1111-4111-8111-111111111111",
      queryHash: "a".repeat(64),
      dataRevision: 1,
      columns: [{ name: "x", unit: null }],
      rows: [[1]],
      downsampling: { method: "min_max_bucket", originalPoints: 5_000_000 },
      freshness: "fresh",
      sourceWatermark: null,
    };
    expect(ChartData.safeParse(base).success).toBe(true);
    const r = boundChartRows({ count: 20_000, rowAt: (i) => [i], maxRows: 100 });
    expect(ChartData.safeParse({ ...base, truncation: r.truncation }).success).toBe(true);
  });
});
