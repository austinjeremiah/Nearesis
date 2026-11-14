import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readIndex, validateDeps, type IndexEntry } from "./validate-deps.ts";

const INDEX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "tests", "TEST_INDEX.json");
const real = (): IndexEntry[] => structuredClone(readIndex(INDEX));
const t = (testId: string, gate: string, dependsOn?: string[]): IndexEntry => ({ testId, gate, dependsOn });
const kinds = (x: IndexEntry[]) => validateDeps(x).map((p) => p.kind);

describe("validate-deps: synthetic graphs", () => {
  it("accepts an acyclic graph in gate order, including same-gate edges", () => {
    expect(
      validateDeps([t("K01", "G01", []), t("M01", "G06", ["K01"]), t("M02", "G06", ["M01", "K01"])]),
    ).toEqual([]);
  });
  it("detects a two-node cycle and names the path", () => {
    const p = validateDeps([t("Q12", "G07", ["Q13"]), t("Q13", "G07", ["Q12"])]);
    expect(p.map((x) => x.kind)).toEqual(["cycle"]);
    expect(p[0]!.detail).toMatch(/Q12 -> Q13 -> Q12|Q13 -> Q12 -> Q13/);
  });
  it("detects a longer cycle", () => {
    expect(kinds([t("A", "G07", ["B"]), t("B", "G07", ["C"]), t("C", "G07", ["A"])])).toEqual(["cycle"]);
  });
  it("detects an unknown ID", () => {
    expect(kinds([t("M01", "G06", ["ZZ99"])])).toEqual(["unknown_id"]);
  });
  it("detects a dependency on a later gate", () => {
    const p = validateDeps([t("M11", "G06", ["Q10"]), t("Q10", "G07", [])]);
    expect(p.map((x) => x.kind)).toEqual(["gate_order"]);
    expect(p[0]!.detail).toContain("later gate");
  });
  it("detects a self dependency, a duplicate ID, a bad gate and a missing or malformed dependsOn", () => {
    expect(kinds([t("M01", "G06", ["M01"])])).toContain("self_dependency");
    expect(kinds([t("M01", "G06", []), t("M01", "G06", [])])).toContain("duplicate_id");
    expect(kinds([t("M01", "6", [])])).toContain("bad_gate");
    expect(kinds([t("M01", "G06")])).toEqual(["missing_depends_on"]);
    expect(kinds([{ testId: "M01", gate: "G06", dependsOn: "K01" }])).toContain("bad_depends_on");
    expect(kinds([t("K01", "G01")])).toEqual([]); // dependsOn optional before G06
  });
});

describe("validate-deps: the real TEST_INDEX.json", () => {
  it("passes", () => {
    expect(validateDeps(real())).toEqual([]);
  });

  const reintroduced: [string, string][] = [
    ["Q12", "Q13"],
    ["Q16", "Q15"],
    ["Q16", "Q17"],
    ["V10", "B10"],
    ["V17", "SEC18"],
    ["SEC11", "N06"],
    ["SEC15", "N08"],
    ["SEC22", "N07"],
  ];
  it.each(reintroduced)("detects the removed edge %s -> %s again (cycle and gate order)", (from, to) => {
    const idx = real();
    const e = idx.find((x) => x.testId === from)!;
    e.dependsOn = [...(e.dependsOn as string[]), to];
    const k = kinds(idx);
    expect(k).toContain("cycle");
  });

  const forward: [string, string][] = [
    ["M11", "Q10"],
    ["Q13", "V06"],
    ["Q16", "V05"],
    ["Q21", "SEC06"],
    ["Q22", "V06"],
    ["W08", "V06"],
    ["W15", "SEC19"],
    ["W18", "SEC19"],
    ["V13", "SEC15"],
    ["V17", "SEC19"],
    ["B08", "SEC04"],
    ["PERF11", "N10"],
  ];
  it.each(forward)("detects the removed later-gate edge %s -> %s again", (from, to) => {
    const idx = real();
    const e = idx.find((x) => x.testId === from)!;
    e.dependsOn = [...(e.dependsOn as string[]), to];
    expect(kinds(idx)).toContain("gate_order");
  });

  it("detects an unknown ID injected into the real index", () => {
    const idx = real();
    idx.find((x) => x.testId === "M13")!.dependsOn = ["NOPE01"];
    expect(kinds(idx)).toContain("unknown_id");
  });
});
