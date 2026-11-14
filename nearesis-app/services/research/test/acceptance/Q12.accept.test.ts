import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q12 targets at 1, 7 and 14 days, organic and unadjusted, reported separately", () => {
  const m = runCase("Q12", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact).toBe(true);
    // (a) 4 families x 3 horizons = 12 target series (each in organic and unadjusted form), all equal to the golden values
    expect(m.familyHorizonSeries).toBe(fz.params.q12.families.length * fz.params.q12.horizons.length);
    expect(m.familyHorizonSeries).toBe(12);
    expect(m.variantSeries).toBe(24);
    expect(m.mismatchedVsGolden).toEqual([]);
    // (b) organic and unadjusted are distinct entries; the control that treats unclassified as organic is caught
    expect(Object.values(m.organicDiffersFromUnadjusted).every(Boolean)).toBe(true);
    expect(m.negativeControlMismatches).toBeGreaterThan(0);
    // (c) every result has its own estimate, uncertainty and verdict; the combined request is labelled non-primary with all components
    expect(m.resultCount).toBe(24);
    expect(m.resultsHaveEstimateUncertaintyVerdict).toBe(true);
    expect(m.combined.label).toBe("non_primary");
    expect(m.combined.primary).toBe(false);
    expect(m.combined.componentCount).toBe(24);
    // (d) untransformed values beside log1p
    expect(m.untransformedBesideLog).toBe(true);
    // (e) the value at t uses only data defined for t+h: later rows do not move it, the t+h rows do
    expect(m.futureRowsUnchanged.length).toBeGreaterThan(0);
    expect(m.futureRowsUnchanged.every(Boolean)).toBe(true);
    expect(m.targetDayRowChangesValue.every(Boolean)).toBe(true);
  } finally {
    observe({
      testId: "Q12",
      fixtureHash: m.fixtureHash,
      observed: `${m.familyHorizonSeries} family-horizon series (${m.variantSeries} with organic/unadjusted variants), ${m.mismatchedVsGolden.length} mismatches vs independent golden; unclassified-as-organic control mismatches ${m.negativeControlMismatches}/12 organic series; ${m.resultCount} results each with estimate, interval and verdict; combined result labelled ${m.combined.label} with ${m.combined.componentCount} components; rows after t+h changed nothing (${m.futureRowsUnchanged.length} series checked)`,
      evidence: { ...m, sampleResult: m.sampleResult },
    });
  }
}, 600_000);
