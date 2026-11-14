import { describe, expect, it } from "vitest";
import { baselineIds, BASELINE, evaluate } from "../../scripts/conformance.ts";

describe("Build Bible conformance checker", () => {
  it("knows exactly the 222 canonical acceptance tests across G00-G12", () => {
    const ids = baselineIds();
    expect(ids.size).toBe(222);
    expect(Object.keys(BASELINE)).toHaveLength(13);
    expect(ids.get("PERF12")).toBe("G11");
    expect(ids.get("A20")).toBe("G04");
    expect(ids.has("A21")).toBe(false);
  });

  it("accounts for every baseline test and never certifies with missing evidence", () => {
    const r = evaluate("/nonexistent-evidence-dir");
    expect(r.summary.baselineAccounted).toBe(222);
    expect(r.certified).toBe(false);
    const states = new Set(r.tests.filter((t) => t.baseline && t.required).map((t) => t.state));
    expect(states.has("CERTIFIED")).toBe(false);
    for (const g of r.gates) expect(g.pass).toBe(false);
  });

  it("does not let a baseline test opt out without a named successor", () => {
    const r = evaluate("/nonexistent-evidence-dir");
    const a16 = r.tests.find((t) => t.testId === "A16");
    expect(a16?.state).toBe("EXEMPT");
    const n05 = r.tests.find((t) => t.testId === "N05");
    expect(n05?.required).toBe(true);
    expect(n05?.state).not.toBe("EXEMPT");
  });

  it("maps every chapter-24 requirement to code paths and indexed tests", () => {
    const r = evaluate("/nonexistent-evidence-dir");
    expect(r.requirements).toHaveLength(37);
    for (const q of r.requirements) {
      expect(q.unknownTests).toEqual([]);
      expect(q.missingCode).toEqual([]);
    }
  });
});
