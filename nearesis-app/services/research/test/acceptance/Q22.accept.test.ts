import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q22 THESIS.md claim table, counterevidence and falsification", () => {
  const m = runCase("Q22", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact).toBe(true);
    const sections = [
      "Executive claim",
      "What would change our mind",
      "Sample and sources",
      "Methods",
      "Primary benchmark",
      "Evidence for",
      "Evidence against",
      "Confounders and blind spots",
      "Long-term economic mechanisms",
      "Verdict per claim",
      "Reproduction",
      "Unable to compute",
      "Source index",
      "Changes since previous version",
    ];
    expect(fz.params.q22.sections).toEqual(sections);
    for (const k of ["signal", "nosignal"]) {
      const f = m.fixtures[k];
      // (a) the 14 sections present in order
      expect(f.sections).toEqual(sections);
      // (b)-(d) the validator (claim fields, counterevidence by result ID, causal-language scan) accepts the generated document
      expect(f.failures).toEqual([]);
      expect(f.valid).toBe(true);
      expect(f.claimRows).toBeGreaterThan(0);
    }
    // (b) the no-signal executive claim carries no bullish assertion and the verdict is not SUPPORTED
    expect(m.fixtures.nosignal.status).not.toBe("SUPPORTED");
    expect(m.fixtures.nosignal.executiveClaim.toLowerCase()).not.toMatch(/improved|bullish|rally|guaranteed/);
    // (d) the scan corpus and allowlist are the frozen ones
    expect(m.causalCorpus.terms).toEqual(fz.params.q22.causalTerms);
    expect(m.causalCorpus.allowlist).toEqual(fz.params.q22.causalAllowlist);
    // (e) each edited copy is rejected naming the failing rule
    expect(m.edited.droppedSection.rules).toContain("missing_section");
    expect(m.edited.emptyCounterexample.rules).toContain("claim_field_empty");
    expect(m.edited.emptyFalsification.rules).toContain("claim_field_empty");
    expect(m.edited.causalLanguage.rules).toContain("causal_language");
    expect(m.edited.emptyEvidenceAgainst.rules).toContain("empty_section");
    expect(m.edited.outOfOrder.rules).toContain("section_order");
    for (const v of Object.values(m.edited) as { ok: boolean }[]) expect(v.ok).toBe(false);
    expect(m.bullishEditOnNoSignal.ok).toBe(false);
    expect(m.bullishEditOnNoSignal.rules).toContain("unsupported_bullish_claim");
  } finally {
    observe({
      testId: "Q22",
      fixtureHash: m.fixtureHash,
      observed: `known-lag (${m.fixtures.signal.status}) and no-signal (${m.fixtures.nosignal.status}) THESIS.md: 14 sections in order, ${m.fixtures.signal.claimRows} claim rows with all six fields, validator failures ${m.fixtures.signal.failures.length}+${m.fixtures.nosignal.failures.length}; edited copies rejected: ${Object.entries(
        m.edited,
      )
        .map(([k, v]) => `${k}=${(v as { rules: string[] }).rules.join("+")}`)
        .join("; ")}; bullish edit on no-signal rejected=${!m.bullishEditOnNoSignal.ok}`,
      evidence: m,
    });
  }
}, 600_000);
