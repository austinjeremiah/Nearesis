import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { canonicalHash, frozenChecks, loadFrozenDoc } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q16 preregistration is canonical, hashed and freezes the analysis", () => {
  const m = runCase("Q16", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    const { text } = loadFrozenDoc();
    // (a) independently computed SHA-256 of the canonical bytes (TypeScript implementation, built here from the rule in the artifact)
    expect(m.canonicalisation).toBe("crlf_cr_to_lf;unicode_nfc;utf8;trailing_whitespace_preserved");
    const nl = text.indexOf("\n");
    const variants: Record<string, string> = {
      original: text,
      identicalCopy: String(text),
      oneByteChange: text.slice(0, 2) + (text[2] !== "X" ? "X" : "Y") + text.slice(3),
      crlf: text.replace(/\n/g, "\r\n"),
      lf: text.replace(/\r\n/g, "\n"),
      nfc: text.normalize("NFC"),
      nfd: text.normalize("NFD"),
      trailingWhitespace: text.slice(0, nl) + " " + text.slice(nl),
      thresholdDigit: text.replace('"minRelativeImprovement": 0.02', '"minRelativeImprovement": 0.03'),
    };
    expect(m.containsNonAscii).toBe(true);
    for (const [k, v] of Object.entries(variants)) {
      expect(m.hashes[k]).toBe(canonicalHash(v));
    }
    // (b) canonically equivalent inputs hash equal; every substantive change differs from the original and from each other
    for (const k of ["identicalCopy", "crlf", "lf", "nfc", "nfd"])
      expect(m.hashes[k]).toBe(m.hashes.original);
    const changed = ["oneByteChange", "trailingWhitespace", "thresholdDigit"].map((k) => m.hashes[k]);
    expect(new Set([...changed, m.hashes.original]).size).toBe(4);
    // (c) a manifest differing on any frozen field is labelled post-hoc and cannot be pre_registered
    expect(m.runs.bound.label).toBe("pre_registered");
    for (const [run, field] of [
      ["changedThreshold", "thresholds"],
      ["changedLagGrid", "lagGrid"],
      ["changedTestFamily", "testFamily"],
    ] as const) {
      expect(m.runs[run].label).toBe("post-hoc registration");
      expect(m.runs[run].strength).toBe("exploratory");
      expect(m.runs[run].diffs).toContain(field);
    }
    // (d) the logged lag grid and every grid-search choice appear; a choice absent from the preregistration is flagged
    expect(m.runs.bound.gridSearchChoices).toEqual(fz.params.experiment.lagGrid);
    expect(m.runs.bound.unregisteredChoices).toEqual([]);
    expect(m.runs.changedLagGrid.gridSearchChoices).toContain(9);
    expect(m.runs.changedLagGrid.unregisteredChoices).toEqual([9]);
    // (e) a freeze after the evaluation forces the post-hoc label
    expect(m.runs.freezeAfterEvaluation.label).toBe("post-hoc registration");
    // (f) every parameter class of the freeze rule is present; a missing one invalidates the freeze; an edit after results is post-hoc
    expect(m.allRequiredPresent).toBe(true);
    expect(m.missingParameter.intact).toBe(false);
    expect(
      m.missingParameter.violations.some((v: string) => v.startsWith("required parameter missing")),
    ).toBe(true);
    expect(m.editedAfterFreeze.resultsExistedBeforeEdit).toBe(true);
    expect(m.editedAfterFreeze.label).toBe("post-hoc registration");
    expect(m.manifestMatchesDefault).toBe(true);
  } finally {
    observe({
      testId: "Q16",
      fixtureHash: m.fixtureHash,
      observed: `canonical hash ${m.hashes.original} matches the independent TypeScript SHA-256; CRLF, LF, NFC and NFD forms hash equal; one-byte, trailing-whitespace and threshold-digit changes each differ; changed threshold, lag grid and test family -> ${m.runs.changedThreshold.label}, strength ${m.runs.changedThreshold.strength}; lag 9 flagged unregistered=${JSON.stringify(m.runs.changedLagGrid.unregisteredChoices)}; freeze-after-evaluation -> ${m.runs.freezeAfterEvaluation.label}; ${m.requiredParameters.length} required parameter paths present`,
      evidence: {
        hashes: m.hashes,
        runs: m.runs,
        missingParameter: m.missingParameter,
        editedAfterFreeze: m.editedAfterFreeze,
        requiredParameters: m.requiredParameters,
        canonicalisation: m.canonicalisation,
      },
    });
  }
}, 600_000);
