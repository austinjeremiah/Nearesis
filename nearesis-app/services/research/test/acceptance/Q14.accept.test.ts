import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q14 loss functions, uncertainty and paired forecast comparison", () => {
  const m = runCase("Q14", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    const q = fz.params.q14;
    // (a) MAE, bias and sMAPE equal hand-computed exact values within 1e-9; the zero rule gives no NaN
    for (const k of ["mae", "bias", "smape"] as const) {
      expect(Math.abs(m.metrics[k].got - m.metrics[k].handExact)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(m.metrics[k].got - m.metrics[k].referenceExact)).toBeLessThanOrEqual(1e-9);
      expect(Number.isFinite(m.metrics[k].got)).toBe(true);
    }
    // (b) DM statistic and p-value equal the independent reference; the i.i.d. variance gives a detectably different value
    expect(Math.abs(m.dm.production.statistic - m.dm.reference.statistic)).toBeLessThanOrEqual(
      q.dm.tolerance,
    );
    expect(Math.abs(m.dm.production.p_value - m.dm.reference.p_value)).toBeLessThanOrEqual(q.dm.tolerance);
    expect(Math.abs(m.dm.iid.statistic - m.dm.reference.statistic)).toBeGreaterThan(q.dm.tolerance);
    // (c) null rejection rate over the frozen seeds is inside the frozen band
    expect(m.null.seeds).toBe(q.nullSimulation.seeds.length);
    expect(m.null.rejections).toBeGreaterThanOrEqual(q.nullSimulation.band[0]);
    expect(m.null.rejections).toBeLessThanOrEqual(q.nullSimulation.band[1]);
    // (d) the 5-origin case returns INSUFFICIENT_DATA, not a p-value
    expect(m.fiveOrigin.status).toBe("INSUFFICIENT_DATA");
    expect(m.fiveOrigin.p_value).toBeNull();
    // (e) delta_MAE has an interval (frozen method and level) whose coverage is inside the frozen band
    expect(m.reportedInterval.interval.method).toBe(q.interval.method);
    expect(m.reportedInterval.interval.level).toBe(q.interval.level);
    expect(m.reportedInterval.interval.lo).not.toBeNull();
    expect(m.coverage.replicates).toBe(q.coverage.seeds.length);
    expect(m.coverage.rate).toBeGreaterThanOrEqual(q.coverage.band[0]);
    expect(m.coverage.rate).toBeLessThanOrEqual(q.coverage.band[1]);
    // (f) frozen reads: an edited or missing value is detected
    expect(m.tamper.editedBandDetected).toBe(true);
    expect(m.tamper.missingParamRaises).toBe(true);
  } finally {
    observe({
      testId: "Q14",
      fixtureHash: m.fixtureHash,
      observed: `metrics exact (MAE ${m.metrics.mae.got}, bias ${m.metrics.bias.got}, sMAPE ${m.metrics.smape.got}); DM t ${m.dm.production.statistic} vs reference ${m.dm.reference.statistic} (i.i.d. variance gives ${m.dm.iid.statistic}); null rejections ${m.null.rejections}/${m.null.seeds} vs frozen band [${m.null.band}] (i.i.d. variance control ${m.null.iidVarianceRejections}); 5 origins -> ${m.fiveOrigin.status}; interval coverage ${m.coverage.covered}/${m.coverage.replicates} = ${m.coverage.rate} vs band [${m.coverage.band}]`,
      evidence: m,
    });
  }
}, 600_000);
