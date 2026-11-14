import { describe, expect, it } from "vitest";
import { GATES, GATE_PLANNED, UPSTREAM, buildSnapshot } from "../server/snapshot.ts";
import { tempPaths, testResult, writeEvidence, writeIndex } from "./fixtures.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const SPEC: [string, string, number][] = [
  ["G00", "BOOT", 3],
  ["G01", "K", 12],
  ["G02", "D", 18],
  ["G03", "S", 16],
  ["G04", "A", 20],
  ["G05", "C", 18],
  ["G06", "M", 16],
  ["G07", "Q", 22],
  ["G08", "W", 18],
  ["G09", "V", 18],
  ["G10", "B", 15],
  ["G11", "SEC", 22],
  ["G11", "PERF", 12],
  ["G12", "N", 12],
];
const idsOf = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
const full = (status = "IMPLEMENTED") =>
  SPEC.flatMap(([gate, prefix, n]) =>
    idsOf(prefix, n).map((testId) => ({
      testId,
      gate,
      status,
      // G06+ IDs are indexed as not required until accepted; they must still be counted
      required: ["G00", "G01", "G02", "G03", "G04", "G05"].includes(gate),
    })),
  );

describe("all gates G00-G12", () => {
  it("lists every gate with a name, planned count and ch.15 upstream, even with an empty index", () => {
    const p = tempPaths();
    writeIndex(p, []);
    const s = buildSnapshot(p, NOW);
    expect(s.gates.map((g) => g.gate)).toEqual([...GATES]);
    expect(s.gates).toHaveLength(13);
    expect(s.gates.find((g) => g.gate === "G06")).toMatchObject({
      name: "Monitoring",
      planned: 16,
      defined: 0,
      passed: 0,
      verdict: "PENDING",
    });
    expect(s.gates.find((g) => g.gate === "G12")?.name).toBe("Release");
    expect(UPSTREAM.G12).toEqual(["G11"]);
    expect(s.overall).toMatchObject({ planned: 222, defined: 0, passed: 0, gatesTotal: 13 });
  });

  it("G06-G12 count every indexed ID whether required or not; DEFINED is not implemented", () => {
    const p = tempPaths();
    writeIndex(p, [
      { testId: "M01", gate: "G06", status: "IMPLEMENTED", required: false },
      { testId: "M08", gate: "G06", status: "DEFINED", required: false },
      { testId: "Q11", gate: "G07", status: "DEFINED", required: false },
    ]);
    writeEvidence(p, testResult("M01", "PASS", ago(1000)));
    const s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G06")).toMatchObject({
      defined: 2,
      total: 2,
      implemented: 1,
      passed: 1,
      executed: 1,
      verdict: "PENDING",
    });
    expect(s.gates.find((g) => g.gate === "G07")).toMatchObject({ defined: 1, implemented: 0 });
    expect(s.tests.find((t) => t.testId === "M08")).toMatchObject({
      indexStatus: "DEFINED",
      implemented: false,
    });
    // milestone still covers only the required P00-P05 tests
    expect(s.milestone).toMatchObject({ label: "P00–P05", total: 0, passed: 0 });
  });

  it("a gate beyond G05 does not pass while planned IDs are missing, even if all indexed IDs pass", () => {
    const p = tempPaths();
    const all = full().filter((t) => t.testId !== "M16");
    writeIndex(p, all);
    for (const t of all) writeEvidence(p, testResult(t.testId, "PASS", ago(1000)));
    const s = buildSnapshot(p, NOW);
    const g6 = s.gates.find((g) => g.gate === "G06");
    expect(g6).toMatchObject({ defined: 15, planned: 16, passed: 15 });
    expect(g6?.verdict).not.toBe("PASS");
    expect(s.gates.find((g) => g.gate === "G10")?.verdict).not.toBe("PASS");
  });

  it("all gates PASS only with PASS evidence for every ID, and one non-passing non-required ID blocks the chain", () => {
    const p = tempPaths();
    const all = full();
    writeIndex(p, all);
    for (const t of all) writeEvidence(p, testResult(t.testId, "PASS", ago(1000)));
    let s = buildSnapshot(p, NOW);
    expect(s.gates.every((g) => g.verdict === "PASS")).toBe(true);
    expect(s.phases).toMatchObject({ completed: 13, current: "ALL_GATES_PASS" });
    expect(s.overall).toMatchObject({
      planned: 222,
      defined: 222,
      passed: 222,
      percent: 100,
      gatesPassed: 13,
    });
    expect(s.milestone).toMatchObject({ label: "P00–P05", passed: 87, total: 87, percent: 100 });
    expect(GATE_PLANNED.G11).toBe(34);

    // an ID with no evidence in G06 (required: false) must hold G06 and everything depending on it
    const q = tempPaths();
    writeIndex(q, all);
    for (const t of all) if (t.testId !== "M09") writeEvidence(q, testResult(t.testId, "PASS", ago(1000)));
    s = buildSnapshot(q, NOW);
    const verdicts = Object.fromEntries(s.gates.map((g) => [g.gate, g.verdict]));
    expect(verdicts.G06).toBe("PENDING");
    expect(verdicts.G10).not.toBe("PASS");
    expect(verdicts.G11).not.toBe("PASS");
    expect(verdicts.G12).not.toBe("PASS");
    expect(verdicts.G07).toBe("PASS");
    expect(verdicts.G09).toBe("PASS");
  });

  it("a passing later gate stays WAITING_UPSTREAM while its upstream gate fails", () => {
    const p = tempPaths();
    const all = full();
    writeIndex(p, all);
    for (const t of all)
      writeEvidence(p, testResult(t.testId, t.testId === "Q05" ? "FAIL" : "PASS", ago(1000)));
    const s = buildSnapshot(p, NOW);
    const v = Object.fromEntries(s.gates.map((g) => [g.gate, g.verdict]));
    expect(v.G07).toBe("FAIL");
    expect(v.G08).toBe("WAITING_UPSTREAM");
    expect(v.G09).toBe("WAITING_UPSTREAM");
    expect(s.gates.find((g) => g.gate === "G08")?.lockedBy).toEqual(["G07"]);
  });
});
