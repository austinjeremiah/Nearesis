import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q01 known-lag synthetic signal: the signal model wins versus the baseline", () => {
  const m = runCase("Q01");
  expect(m.status).toBe("SUPPORTED");
  for (const k of ["intents", "combined"]) {
    expect(m[k].delta_mae).toBeGreaterThan(0);
    expect(m[k].relative_improvement).toBeGreaterThanOrEqual(m.minRel);
    expect(m[k].p_adjusted).toBeLessThan(m.q);
    expect(m[k].delta_mae_ci.lo).toBeGreaterThan(0);
  }
  expect(m.bestSingleLagAtH1).toBe(m.expectedBestLag); // y(t+1) depends on x(t+1-3): lag 2 at the origin
  expect(m.holdout.pass).toBe(true);
  expect(m.placebo.passed).toBe(true);
  // negative: the independent price predictor must not win, and long horizons are not claimed
  expect(m.price.fdr_reject).toBe(false);
  expect(Object.values(m.unsupportedHorizons).every((v) => v === false)).toBe(true);
  observe({
    testId: "Q01",
    fixtureHash: m.fixtureHash,
    observed: `SYNTHETIC known lag ${m.knownLag}: intents MAE ${m.intents.mae_candidate.toFixed(4)} vs baseline ${m.intents.mae_baseline.toFixed(4)} (${(m.intents.relative_improvement * 100).toFixed(1)}% better, adj p ${m.intents.p_adjusted.toExponential(2)}, n=${m.intents.n_origins}); best lag ${m.bestSingleLagAtH1}; holdout ${(m.holdout.relative_improvement * 100).toFixed(1)}% better; placebo p ${m.placebo.p_value.toFixed(3)}; price model not significant (adj p ${m.price.p_adjusted.toFixed(3)}); status ${m.status}`,
    evidence: { intents: m.intents, price: m.price, holdout: m.holdout, placebo: m.placebo },
  });
});
