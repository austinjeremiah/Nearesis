/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  averagePath,
  buildForecast,
  firstCrossing,
  forecastLog,
  mulberry32,
  quantile,
  widthCurve,
} from "./forecast.ts";
import type { SeriesInput } from "./forecast.ts";

// Synthetic TEST fixtures only: nothing here is real data.
const START = "2025-11-10";
const N = 369;
const days = Array.from({ length: N }, (_, i) => addDays(START, i));
const mk = (id: string, values: (number | null)[], transform: "log1p" | "logit" = "log1p"): SeriesInput => ({
  id,
  label: id,
  unit: "u",
  transform,
  days,
  values,
});
const FAST = { paths: 200 };
const cfg = { trailing: 180, phi: 0.9 };

describe("models", () => {
  it("the trend model forecasts a pure linear trend exactly (on the transformed scale)", () => {
    const y = Array.from({ length: 300 }, (_, i) => 2 + 0.01 * i);
    const f = forecastLog("trend", y, 299, 60, cfg);
    f.forEach((v, k) => expect(v).toBeCloseTo(2 + 0.01 * (299 + k + 1), 9));
    const d = forecastLog("drift", y, 299, 60, cfg);
    d.forEach((v, k) => expect(v).toBeCloseTo(2 + 0.01 * (299 + k + 1), 9));
    expect(forecastLog("naive", y, 299, 3, cfg)).toEqual([y[299], y[299], y[299]]);
  });
  it("a growing series is forecast by a trend-type model, which beats naive at 90 days", () => {
    const values = days.map((_, i) => Math.expm1(6 + 0.006 * i));
    const r = buildForecast({ series: [mk("g", values)] }, FAST) as any;
    const s = r.series.g;
    expect(s.chosenModel).not.toBe("naive");
    const row = (m: string) => s.backtest.table.find((t: any) => t.model === m && t.horizon === 90);
    expect(row(s.chosenModel).mae).toBeLessThan(row("naive").mae);
    expect(row(s.chosenModel).skill).toBeGreaterThan(0.1);
  });
  it("naive wins on random walks in expectation", () => {
    let naive = 0;
    let trend = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      let y = 8;
      const values = days.map(() => {
        y += (rnd() - 0.5) * 0.12;
        return Math.expm1(y);
      });
      const s = (buildForecast({ series: [mk("w", values)] }, { paths: 20 }) as any).series.w;
      const get = (m: string) => s.backtest.table.find((t: any) => t.model === m && t.horizon === 90).mae;
      naive += get("naive");
      trend += get("trend");
    }
    expect(naive / 25).toBeLessThan(trend / 25);
  });
});

describe("backtest", () => {
  it("never uses days after the origin (leak test)", () => {
    const rnd = mulberry32(7);
    const base = days.map((_, i) => 1000 + 3 * i + rnd() * 200);
    const D = 250;
    const garbage = base.map((v, i) => (i > D ? v * 50 + 12345 : v));
    const a = buildForecast({ series: [mk("s", base)] }, FAST) as any;
    const b = buildForecast({ series: [mk("s", garbage)] }, FAST) as any;
    const oa = a.series.s.backtest.origins_detail.filter((o: any) => o.index <= D);
    const ob = b.series.s.backtest.origins_detail.filter((o: any) => o.index <= D);
    expect(oa.length).toBeGreaterThan(3);
    oa.forEach((o: any, i: number) => {
      for (const h of Object.keys(o.horizons)) {
        const x = o.horizons[h];
        const z = ob[i].horizons[h];
        if (!z) continue;
        for (const m of ["naive", "drift", "trend", "damped", "median"]) expect(z[m]).toBe(x[m]);
      }
    });
    // origins whose targets are all inside the unchanged part also have identical actuals
    const whole = oa.filter((o: any) => o.index + 90 <= D);
    whole.forEach((o: any) => {
      const z = ob.find((q: any) => q.index === o.index);
      expect(z.horizons["90"].actual).toBe(o.horizons["90"].actual);
    });
  });
  it("is deterministic: the same input gives an identical file", () => {
    const rnd = mulberry32(3);
    const v = days.map((_, i) => 500 + i + rnd() * 80);
    const w = days.map((_, i) => 900 - i + rnd() * 80);
    const input = { series: [mk("a", v), mk("b", w)], crossover: { a: "a", b: "b" } };
    expect(JSON.stringify(buildForecast(input, FAST))).toBe(JSON.stringify(buildForecast(input, FAST)));
  });
  it("bands are monotone: the 80% band contains the 50% band, which contains the centre", () => {
    const rnd = mulberry32(11);
    const v = days.map((_, i) => 5000 + 10 * i + rnd() * 1500);
    const s = (buildForecast({ series: [mk("m", v)] }, FAST) as any).series.m;
    for (let k = 0; k < 365; k++) {
      expect(s.path.band80Lo[k]).toBeLessThanOrEqual(s.path.band50Lo[k]);
      expect(s.path.band50Lo[k]).toBeLessThanOrEqual(s.path.central[k]);
      expect(s.path.central[k]).toBeLessThanOrEqual(s.path.band50Hi[k]);
      expect(s.path.band50Hi[k]).toBeLessThanOrEqual(s.path.band80Hi[k]);
    }
    const w = widthCurve(
      [
        { h: 30, w: 0.1 },
        { h: 90, w: 0.3 },
      ],
      365,
    );
    w.forEach((x, k) => k && expect(x).toBeGreaterThanOrEqual(w[k - 1]!));
    expect(w[364]).toBeCloseTo(0.3 * Math.sqrt(365 / 90), 9);
    expect(s.checkpoints.map((c: any) => c.date)).toEqual(["2027-02-13", "2027-05-13", "2027-11-13"]);
  });
  it("does not zero-fill missing days: a hole lowers nothing", () => {
    const v: (number | null)[] = days.map(() => 1000);
    for (let i = 100; i < 140; i++) v[i] = null;
    const s = (buildForecast({ series: [mk("h", v)] }, FAST) as any).series.h;
    expect(s.missingDays.length).toBe(40);
    expect(s.last30).toBe(1000);
    expect(s.path.central[0]).toBeCloseTo(1000, 3);
  });
  it("works on shares with the logit transform", () => {
    const v = days.map((_, i) => 0.1 + 0.0008 * i);
    const s = buildForecast(
      { series: [mk("p", v, "logit")], threshold: { id: "p", value: 0.5 } },
      FAST,
    ) as any;
    expect(s.series.p.horizons[2].central).toBeGreaterThan(0.3);
    expect(s.series.p.horizons[2].band80[1]).toBeLessThan(1);
    expect(s.derived.p_threshold.centralDate).not.toBeNull();
  });
});

describe("derived quantities", () => {
  it("detects a crossover between a rising and a falling series", () => {
    const rnd = mulberry32(5);
    const up = days.map((_, i) => 500 + 10 * i + rnd() * 50);
    const down = days.map((_, i) => 12000 - 10 * i + rnd() * 50);
    const r = buildForecast(
      { series: [mk("up", up), mk("down", down)], crossover: { a: "up", b: "down" } },
      FAST,
    ) as any;
    const c = r.derived.crossover;
    expect(c.aboveAtLastDay).toBe(false);
    expect(c.centralHorizon).not.toBeNull();
    expect(c.centralDate).toBe(addDays(r.lastDay, c.centralHorizon));
    expect(c.within12Months).toBeGreaterThan(0.5);
    expect(c.within6Months).toBeLessThanOrEqual(c.within12Months);
  });
  it("reports no crossover for a series that stays far below", () => {
    const rnd = mulberry32(9);
    const lo = days.map(() => 100 + rnd() * 5);
    const hi = days.map(() => 100000 + rnd() * 5);
    const c = (
      buildForecast({ series: [mk("lo", lo), mk("hi", hi)], crossover: { a: "lo", b: "hi" } }, FAST) as any
    ).derived.crossover;
    expect(c.centralDate).toBeNull();
    expect(c.within12Months).toBe(0);
  });
  it("firstCrossing, averagePath, quantile and addMonths behave", () => {
    expect(firstCrossing([1, 2, 3, 4], [5, 5, 2, 9])).toBe(3);
    expect(firstCrossing([1, 2], 5)).toBeNull();
    expect(averagePath([2, 4, null], [10], 2)).toEqual([10]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(addMonths("2026-11-13", 6)).toBe("2027-05-13");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });
  it("sums the next 365 daily levels for the total", () => {
    const v = days.map(() => 1000);
    const t = (buildForecast({ series: [mk("t", v)], total: "t" }, FAST) as any).derived.t_12m;
    expect(t.centralTotal).toBeCloseTo(365000, 0);
    expect(t.p10).toBeLessThanOrEqual(t.p90);
  });
});
