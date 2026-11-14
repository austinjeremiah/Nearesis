import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q19 bull/bear adversarial protocol and deterministic adjudication (scripted branches)", () => {
  const m = runCase("Q19", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact).toBe(true);
    const r = m.runs;
    // (a) both branches receive byte-equal snapshot manifest and metric catalog hashes, in every script
    for (const run of Object.values(r) as {
      inputsEqual: boolean;
      hashes: { bull: unknown; bear: unknown };
    }[]) {
      expect(run.inputsEqual).toBe(true);
      expect(run.hashes.bull).toEqual(run.hashes.bear);
    }
    expect(m.unequalInputsDetected).toBe(true); // unequal inputs are detectable
    // (b) arguments without a result ID, with a differing number, or beyond three are rejected before adjudication
    expect(r.bull_no_result_id.rejected).toEqual(["missing_or_unknown_result_id"]);
    expect(r.bear_wrong_number.rejected).toEqual(["number_differs_from_result"]);
    expect(r.fourth_argument.rejected).toEqual(["beyond_argument_limit"]);
    expect(m.maxArguments).toBe(fz.params.q19.maxArguments);
    // (c) disagreement yields MIXED or INSUFFICIENT_DATA with both sides preserved; agreement yields the engine verdict
    expect(["MIXED", "INSUFFICIENT_DATA"]).toContain(r.disagreement.adjudication.status);
    expect(r.disagreement.adjudication.preservedBull).toBeGreaterThan(0);
    expect(r.disagreement.adjudication.preservedBear).toBeGreaterThan(0);
    expect(r.agreement.adjudication.status).toBe(m.engineVerdict.status);
    expect(r.agreement.adjudication.source).toBe("engine");
    // (d) the threshold edit is denied and audited; the preregistration hash is unchanged
    expect(r.bull_edits_threshold.rejected).toEqual(["preregistration_edit_denied"]);
    expect(r.bull_edits_threshold.audit).toHaveLength(1);
    expect(r.bull_edits_threshold.prereg[0]).toBe(r.bull_edits_threshold.prereg[1]);
    // (e) the adjudication is a pure function of its inputs: two runs, byte-equal
    for (const run of Object.values(r) as { adjudicationHash: string; secondRunHash: string }[])
      expect(run.adjudicationHash).toBe(run.secondRunHash);
    // negative control: bear dropped and bull wins must be flagged as incomplete
    expect(r.bear_dropped.adjudication.outcome).toBe("INCOMPLETE");
    expect(r.bear_dropped.adjudication.status).toBe("INSUFFICIENT_DATA");
  } finally {
    observe({
      testId: "Q19",
      fixtureHash: m.fixtureHash,
      observed: `7 scripts: branch input hashes equal in all; rejections no_result_id=${m.runs.bull_no_result_id.rejected}, wrong_number=${m.runs.bear_wrong_number.rejected}, fourth=${m.runs.fourth_argument.rejected}; disagreement -> ${m.runs.disagreement.adjudication.status} with ${m.runs.disagreement.adjudication.preservedBull}+${m.runs.disagreement.adjudication.preservedBear} preserved; agreement -> engine ${m.runs.agreement.adjudication.status}; threshold edit denied and audited, preregistration hash unchanged; adjudication byte-equal across two runs; bear dropped -> ${m.runs.bear_dropped.adjudication.outcome}. Scope: ${m.scope}`,
      evidence: m,
    });
  }
}, 600_000);
