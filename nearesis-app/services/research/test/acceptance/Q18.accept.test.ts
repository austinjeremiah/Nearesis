import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q18 robustness matrix completeness", () => {
  const m = runCase("Q18", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    const named = [
      "window_30d",
      "window_90d",
      "window_180d",
      "top_1pct_accounts_removed",
      "top_5pct_accounts_removed",
      "outlier_days_excluded",
      "stablecoin_only_routes",
      "non_stablecoin_routes",
      "pre_oct27_regime",
      "post_oct27_regime",
      "public_vs_confidential",
      "segment_targets",
    ];
    // (a) the variant list comes from the frozen file and includes every ch.02 variant as a row
    expect(m.variantsFrozen).toEqual(fz.params.q18.variants);
    for (const v of named) expect(m.rowNames).toContain(v);
    expect(m.rowNames).toHaveLength(named.length);
    // (b) the 180-day window and the absent route class are NOT_COMPUTABLE with a reason; nothing is zero-filled
    expect(m.rows.window_180d.status).toBe("NOT_COMPUTABLE");
    expect(m.rows.stablecoin_only_routes.status).toBe("NOT_COMPUTABLE");
    for (const r of Object.values(m.notComputable) as string[]) expect(r.length).toBeGreaterThan(10);
    expect(m.zeroFilled).toEqual([]);
    // (c) estimates under each computed variant sit beside the primary; a sign flip caps the headline at MIXED or lower
    expect(m.primaryStatus).toBe("OK");
    const computed = Object.values(m.rows).filter((r) => (r as { status: string }).status === "OK") as {
      estimates: unknown[];
    }[];
    expect(computed.length).toBeGreaterThanOrEqual(6);
    for (const r of computed) expect(r.estimates.length).toBeGreaterThan(0);
    expect(m.signFlipConstructed.flips.length).toBeGreaterThan(0);
    expect(m.signFlipConstructed.headlineBefore).toBe("SUPPORTED");
    expect(["MIXED", "UNSUPPORTED", "INSUFFICIENT_DATA", "NOT_REPRODUCIBLE"]).toContain(
      m.signFlipConstructed.headlineAfter,
    );
    expect(m.signFlipNotComputableOnly.headlineAfter).toBe("SUPPORTED"); // NOT_COMPUTABLE cells are never a flip
    if (m.signFlipRealMatrix.flips.length > 0)
      expect(m.signFlipRealMatrix.headlineAfter).not.toBe("SUPPORTED");
    // (d) a variant removed from the configuration fails validation instead of silently shrinking the matrix
    expect(m.removedVariantValidation.failed).toBe(true);
    expect(m.removedVariantValidation.missing).toEqual(["window_90d"]);
  } finally {
    observe({
      testId: "Q18",
      fixtureHash: m.fixtureHash,
      observed: `${m.rowNames.length} matrix rows from the frozen list; NOT_COMPUTABLE with reasons: ${Object.keys(m.notComputable).join(", ")}; zero-filled cells ${m.zeroFilled.length}; real matrix sign flips ${m.signFlipRealMatrix.flips.length} (headline ${m.signFlipRealMatrix.headlineBefore} -> ${m.signFlipRealMatrix.headlineAfter}); constructed flip ${m.signFlipConstructed.headlineBefore} -> ${m.signFlipConstructed.headlineAfter}; matrix with window_90d removed -> validation ${m.removedVariantValidation.failed ? "failed" : "passed"}`,
      evidence: m,
    });
  }
}, 600_000);
