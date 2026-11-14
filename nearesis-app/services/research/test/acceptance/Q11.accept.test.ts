import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q11 rolling-origin evaluation fits transforms on training data only", () => {
  const m = runCase("Q11", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    // the values used come from the frozen file (checked here against an independent parse of the document)
    expect(m.frozenValuesUsed).toEqual({
      horizon: fz.params.q11.horizon,
      lagGrid: fz.params.q11.lagGrid,
      minTrainingLength: fz.params.q11.minTrainingLength,
      minValidOrigins: fz.params.q11.minValidOrigins,
    });
    // (a) zero fits read beyond their origin, over all origins and fit calls
    expect(m.fitCalls).toBeGreaterThan(0);
    expect(m.violations).toBe(0);
    // (b) chronological, non-overlapping scored points; validOrigins equals the independent recount
    expect(m.chronological).toBe(true);
    expect(m.recountInputs.fixtureEndsBeforeRegimeSplit).toBe(true);
    expect(m.validOrigins).toBe(m.recountedOrigins);
    expect(m.validOrigins).toBeGreaterThanOrEqual(fz.params.q11.minValidOrigins);
    // (c) below the frozen minimum is INSUFFICIENT_DATA; an edited or incomplete frozen file is refused
    expect(m.short.status).toBe("INSUFFICIENT_DATA");
    expect(m.short.validOrigins).toBeLessThan(m.short.minValidOrigins);
    expect(m.refusals.editedAfterFreeze.refused).toBe(true);
    expect(m.refusals.missingParameter.refused).toBe(true);
    // (d) random k-fold is refused with a structured error
    expect(m.kfold.refused).toBe(true);
    expect(m.kfold.error).toBe("random_cross_validation_prohibited");
    // (e) the full-series-scaler control is caught by (a)
    expect(m.negativeControl.violations).toBeGreaterThan(0);
  } finally {
    observe({
      testId: "Q11",
      fixtureHash: m.fixtureHash,
      observed: `validOrigins ${m.validOrigins} (independent recount ${m.recountedOrigins}); ${m.fitCalls} fit calls, ${m.violations} read beyond origin; full-series scaler control: ${m.negativeControl.violations}/${m.negativeControl.fitCalls} violations; 150-day fixture ${m.short.validOrigins} origins < ${m.short.minValidOrigins} -> ${m.short.status}; k-fold -> ${m.kfold.error}; frozen file intact=${m.frozen.intact}`,
      evidence: { ...m, accessLogSample: m.accessLogSample },
    });
  }
}, 600_000);
