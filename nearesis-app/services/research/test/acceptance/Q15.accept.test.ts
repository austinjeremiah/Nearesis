import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q15 verdict engine: thresholds frozen, two axes, no override", () => {
  const m = runCase("Q15", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    // (a) all 12 frozen table rows return the expected (status, strength) pair, as separate fields
    expect(m.table).toHaveLength(12);
    expect(fz.params.q15.verdictTable).toHaveLength(12);
    for (const r of m.table) {
      expect(r.got).toEqual(r.expected);
    }
    expect(m.separateAxes).toBe(true);
    // (b) the single-spike series cannot exceed exploratory and cannot be SUPPORTED
    expect(m.spike.spikeDependent).toBe(true);
    expect(m.spike.relativeImprovementWithoutTopDay).toBeLessThan(m.spike.threshold);
    expect(m.spikeGrade.evidenceStrength).toBe("exploratory");
    expect(m.spikeGrade.status).not.toBe("SUPPORTED");
    expect(m.cleanSpike.spikeDependent).toBe(false);
    // (c) scripted LLM text and a hand-edited verdict are ignored or rejected; the stored verdict equals the engine's
    expect(m.sealed.commentaryEffect).toBe("none");
    expect(m.sealed.status).toBe("UNSUPPORTED");
    expect(m.handEdit.rejected).toBe(true);
    expect(m.inputsTamper.rejected).toBe(true);
    expect(m.naiveLlmVerdict).toBe("SUPPORTED"); // a build that read the LLM text would differ from the engine and so FAIL (c)
    // (d) a threshold changed after the freeze is rejected and the original verdict stands
    expect(m.thresholdChange.rejected).toBe(true);
    expect(m.originalVerdictAfter).toEqual({
      status: "UNSUPPORTED",
      evidenceStrength: "pre_registered",
      registrationLabel: "pre_registered",
    });
    // (e) a table edited after results exist is post-hoc and pre_registered strength is refused
    expect(m.tableEditedAfterResults.intact).toBe(false);
    expect(m.tableEditedAfterResults.label).toBe("post-hoc registration");
    expect(m.tableEditedAfterResults.strength).toBe("exploratory");
  } finally {
    observe({
      testId: "Q15",
      fixtureHash: m.fixtureHash,
      observed: `${m.table.filter((r: { ok: boolean }) => r.ok).length}/12 frozen table rows matched; single-spike series: relative improvement ${m.spike.relativeImprovement.toFixed(4)} falls to ${m.spike.relativeImprovementWithoutTopDay.toFixed(4)} without the top day -> ${m.spikeGrade.status}/${m.spikeGrade.evidenceStrength}; LLM text effect ${m.sealed.commentaryEffect}; hand-edited verdict rejected=${m.handEdit.rejected}; post-freeze threshold change rejected=${m.thresholdChange.rejected}; table edited after results -> ${m.tableEditedAfterResults.label}/${m.tableEditedAfterResults.strength}`,
      evidence: m,
    });
  }
}, 600_000);
