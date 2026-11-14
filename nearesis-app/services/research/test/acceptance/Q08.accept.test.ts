import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q08 multiple comparisons: preregistered test family with an FDR policy", () => {
  const m = runCase("Q08");
  expect(m.familySize).toBe(9);
  expect(m.artifactFamilyM).toBe(9);
  expect(m.familyDeclaredBeforeRun).toBe(true);
  expect(m.fdr).toEqual({ method: "benjamini_hochberg", q: 0.05 });
  expect(m.bhMatchesStatsmodels).toBe(true);
  expect(m.adjustedNeverBelowRaw).toBe(true);
  expect(m.artifactAdjustedGeRaw).toBe(true);
  expect(m.nullFamilyAnyRejectRate).toBeLessThanOrEqual(0.07); // 4000 all-null families, q=0.05
  expect(m.tamperedFamilyAccepted).toBe(false); // negative: shrinking the family post hoc breaks the frozen hash
  expect(m.verdictAfterFamilyTamper).toBe("NOT_REPRODUCIBLE");
  observe({
    testId: "Q08",
    fixtureHash: m.fixtureHash,
    observed: `family of ${m.familySize} (3 candidates x 3 horizons) under BH q=0.05 frozen in the preregistration hash; BH equals statsmodels fdr_bh; adjusted >= raw; all-null family any-reject rate ${m.nullFamilyAnyRejectRate} over 4000 draws; altered family -> verdict ${m.verdictAfterFamilyTamper}`,
    evidence: m,
  });
}, 600_000);
