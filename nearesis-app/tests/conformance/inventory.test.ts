import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../scripts/conformance.ts";
import { buildStatic } from "../../scripts/certify/build-inventory.ts";

const APP = resolve(import.meta.dirname, "..", "..");
const inv = JSON.parse(readFileSync(join(APP, "tests", "REQUIREMENTS_INVENTORY.json"), "utf8")) as {
  registry: Record<string, unknown>;
  requirements: {
    id: string;
    summary: string;
    code: string[];
    tests: string[];
    testFiles: string[];
    chapterSection: string;
  }[];
};

describe("requirement inventory", () => {
  it("is current: static fields equal what the seed, index and map produce", () => {
    const fresh = buildStatic();
    expect(inv.registry).toEqual(fresh.registry);
    expect(
      inv.requirements.map(({ id, code, tests, testFiles }) => ({ id, code, tests, testFiles })),
    ).toEqual(fresh.requirements.map(({ id, code, tests, testFiles }) => ({ id, code, tests, testFiles })));
  });

  it("resolves 222 canonical vs 223 indexed: A21 substitutes the historical A16", () => {
    expect(inv.registry).toMatchObject({
      canonicalBaseline: 222,
      indexed: 223,
      required: 222,
      exemptHistorical: ["A16"],
      substitutes: { A16: "A21" },
      additionsBeyondBaseline: ["A21"],
      authority: "ADR-20261110-004",
    });
    const r = evaluate("/nonexistent-evidence-dir");
    expect(r.summary.registry).toMatchObject({
      canonicalBaseline: 222,
      indexed: 223,
      required: 222,
      exemptHistorical: ["A16"],
      additionsBeyondBaseline: ["A21"],
    });
  });

  it("maps every requirement to code and to tests, with unique ids and short paraphrases", () => {
    const ids = inv.requirements.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of inv.requirements) {
      expect(q.code.length, q.id).toBeGreaterThan(0);
      expect(q.tests.length + q.testFiles.length, q.id).toBeGreaterThan(0);
      expect(q.chapterSection.length, q.id).toBeGreaterThan(3);
      expect(q.summary.length, q.id).toBeLessThanOrEqual(400);
    }
  });

  it("covers every indexed test, every chapter-24 row and every accepted ADR", () => {
    const covered = new Set(inv.requirements.flatMap((q) => q.tests));
    const index = JSON.parse(readFileSync(join(APP, "tests", "TEST_INDEX.json"), "utf8")) as {
      tests: { testId: string }[];
    };
    for (const t of index.tests) expect(covered.has(t.testId), t.testId).toBe(true);
    const ids = new Set(inv.requirements.map((q) => q.id));
    for (const n of [...Array(23)].map((_, i) => `F${String(i + 1).padStart(2, "0")}`))
      expect(ids.has(`REQ-CH24-${n}`), n).toBe(true);
    for (const n of [...Array(14)].map((_, i) => `L${String(i + 1).padStart(2, "0")}`))
      expect(ids.has(`REQ-CH24-${n}`), n).toBe(true);
    for (const adr of [
      "20261110-001",
      "20261110-002",
      "20261110-003",
      "20261110-004",
      "20261110-005",
      "20261111-001",
      "20261111-002",
      "20261111-003",
      "20261111-004",
      "20261111-005",
      "20261111-006",
      "20261112-001",
    ])
      expect(ids.has(`REQ-ADR-${adr}`), adr).toBe(true);
    for (let p = 0; p <= 12; p++) expect(ids.has(`REQ-CH15-P${String(p).padStart(2, "0")}`)).toBe(true);
    for (let s = 4; s <= 21; s++)
      expect(
        [...ids].some((i) => i.startsWith(`REQ-FMP${String(s).padStart(2, "0")}-`)),
        `final s${s}`,
      ).toBe(true);
  });

  it("conformance recomputes requirement status live and reports no inventory problems", () => {
    const r = evaluate("/nonexistent-evidence-dir");
    expect(r.inventoryProblems).toEqual([]);
    expect(r.summary.inventory.requirements).toBe(inv.requirements.length);
    expect(r.summary.inventory.unmapped).toBe(0);
    // No evidence anywhere: nothing may be certified except exempt-only requirements.
    for (const q of r.inventoryRequirements) if (q.status === "CERTIFIED") expect(q.id).toBe("REQ-T-A16");
    expect(r.certified).toBe(false);
  });
});
