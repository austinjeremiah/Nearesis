import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q10 claim vs computed output: every narrative numeric claim matches the actual result", () => {
  const m = runCase("Q10");
  expect(m.verifyOk.ok).toBe(true);
  expect(m.verifyOk.unmatched).toEqual([]);
  expect(m.numericTokens).toBeGreaterThanOrEqual(8);
  expect(m.tamperedDetected).toBe(true); // negative: an altered number is rejected
  expect(m.extraClaimDetected).toBe(true); // negative: an invented number is rejected
  // independent check in TS: the displayed headline numbers equal the facts to displayed precision
  expect(m.narrative).toContain(m.facts.mae_baseline.toFixed(4));
  expect(m.narrative).toContain(m.facts.mae_candidate.toFixed(4));
  expect(m.narrative).toContain(`${m.facts.relative_improvement_pct.toFixed(1)}%`);
  observe({
    testId: "Q10",
    fixtureHash: m.fixtureHash,
    observed: `${m.numericTokens} numeric tokens in the generated narrative all match result facts; altered number ${m.tamperedUnmatched.join(",")} rejected; invented 88.8% rejected`,
    evidence: { narrative: m.narrative, facts: m.facts },
  });
}, 600_000);
