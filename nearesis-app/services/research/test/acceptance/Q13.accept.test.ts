import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q13 mechanical overlap between predictor and target blocks the claim", () => {
  const m = runCase("Q13", "accept_cases_g07");
  try {
    expect(frozenChecks(m).pythonUsedThisDocument).toBe(true);
    // (a) blocked status with reason_code and the shared row-ID count; never SUPPORTED or MIXED
    expect(["SUPPORTED", "MIXED"]).not.toContain(m.overlap.status);
    expect(m.overlap.status).toBe("NOT_REPRODUCIBLE");
    expect(m.overlap.reason_code).toBe("mechanical_overlap");
    expect(m.overlap.shared_row_count).toBeGreaterThan(0);
    // (b) the publication gate refuses it
    expect(m.gateOverlap.ok).toBe(false);
    // (c) the disjoint variant is not blocked by this detector
    expect(m.disjoint.reason_code).toBeNull();
    expect(m.disjoint.shared_row_count).toBe(0);
    expect(m.gateDisjoint.ok).toBe(true);
    // (d) row identity, not correlation: the disjoint series is highly correlated and still not blocked
    expect(m.correlationDisjoint).toBeGreaterThan(0.9);
    // negative control: a correlation > 0.9 detector blocks the disjoint variant, so it would FAIL (d)
    expect(m.naiveCorrelationDetectorBlocks.disjoint).toBe(true);
  } finally {
    observe({
      testId: "Q13",
      fixtureHash: m.fixtureHash,
      observed: `overlap variant -> ${m.overlap.status}/${m.overlap.reason_code} with ${m.overlap.shared_row_count} shared row IDs, gate ok=${m.gateOverlap.ok}; disjoint variant (corr ${m.correlationDisjoint.toFixed(4)}) -> ${m.disjoint.status}, reason_code ${m.disjoint.reason_code}, gate ok=${m.gateDisjoint.ok}; correlation-only control would block disjoint=${m.naiveCorrelationDetectorBlocks.disjoint}`,
      evidence: m,
    });
  }
}, 600_000);
