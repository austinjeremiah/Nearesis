import { describe, expect, it } from "vitest";
import {
  candidatesOf,
  chooseForQuestion,
  expectedSignOf,
  planFor,
  relatednessOf,
  roundHalfEven,
  scaleSeries,
  statementOf,
  tokensOf,
  validateProposal,
} from "../src/index.ts";
import type { Candidate, RunPanel } from "../src/index.ts";

const day = (i: number): string =>
  new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
const N = 45;
const idx = Array.from({ length: N }, (_, i) => i);
const panel = (
  hash: string,
  title: string,
  cols: Array<[string, string]>,
  rows: (i: number) => unknown[],
): RunPanel => ({
  hash,
  title,
  body: {
    chart: {
      columns: [{ name: "period", unit: null }, ...cols.map(([name, unit]) => ({ name, unit }))],
      rows: idx.map((i) => [day(i), ...rows(i)]),
    },
  },
});
const swaps = (i: number): number => 1000 + i * 12 + ((i * 7) % 13) * 20;
const refunded = (i: number): number => 15 + ((i * 11) % 17);
const A = panel(
  "a".repeat(64),
  "Daily refund rate trend",
  [
    ["swaps", "swaps"],
    ["success", "swaps"],
    ["refunded", "swaps"],
    ["refundRate", "ratio"],
  ],
  (i) => [swaps(i), swaps(i) - refunded(i), refunded(i), (refunded(i) / swaps(i)).toFixed(6)],
);
const ACC = panel(
  "b".repeat(64),
  "Daily accounts",
  [
    ["activeAccounts", "accounts"],
    ["newAccounts", "accounts"],
    ["returningAccounts", "accounts"],
  ],
  (i) => {
    const n = 40 + ((i * 5) % 9);
    const r = 100 + ((i * 3) % 14);
    return [n + r, n, r];
  },
);
const cands = (...p: RunPanel[]): Candidate[] => candidatesOf(p).candidates;
const by = (c: Candidate[], col: string): Candidate => c.find((x) => x.column === col)!;

describe("part-whole and mechanical relations (heuristic)", () => {
  const c = cands(A, ACC);
  it("a status subset of a total is part of the whole, in either order", () => {
    expect(relatednessOf(by(c, "swaps"), by(c, "success"), c)).toMatchObject({
      status: "mechanical",
      code: "PART_OF_WHOLE",
    });
    expect(relatednessOf(by(c, "success"), by(c, "swaps"), c).code).toBe("PART_OF_WHOLE");
    expect(relatednessOf(by(c, "swaps"), by(c, "refunded"), c).code).toBe("PART_OF_WHOLE");
  });
  it("new accounts against active accounts is part of the whole; new against returning is not", () => {
    expect(relatednessOf(by(c, "activeAccounts"), by(c, "newAccounts"), c).code).toBe("PART_OF_WHOLE");
    expect(relatednessOf(by(c, "newAccounts"), by(c, "returningAccounts"), c).status).toBe("independent");
  });
  it("identical series, and a series against a copy within one percent", () => {
    const copy = panel("c".repeat(64), "Copy", [["swapsAgain", "swaps"]], (i) => [swaps(i)]);
    const near = panel("d".repeat(64), "Near", [["swapsNear", "swaps"]], (i) => [swaps(i) + 1]);
    const all = cands(A, copy, near);
    expect(relatednessOf(by(all, "swaps"), by(all, "swapsAgain"), all).code).toBe("IDENTICAL_SERIES");
    expect(relatednessOf(by(all, "swaps"), by(all, "swapsNear"), all).code).toBe("NEAR_DUPLICATE_SERIES");
  });
  it("a ratio against its numerator is mechanical; against its denominator it only carries a note", () => {
    expect(relatednessOf(by(c, "refunded"), by(c, "refundRate"), c).code).toBe("RATIO_OF_PREDICTOR");
    const den = relatednessOf(by(c, "swaps"), by(c, "refundRate"), c);
    expect(den.status).toBe("independent");
    expect(den.notes[0]).toMatch(/denominator/);
  });
  it("a known-USD volume is a part of all volume", () => {
    const v = panel(
      "e".repeat(64),
      "Volume",
      [
        ["volumeUsd", "USD"],
        ["volumeUsdKnown", "USD"],
      ],
      (i) => [1000 + i * 30, 700 + i * 20],
    );
    const all = cands(v);
    expect(relatednessOf(by(all, "volumeUsd"), by(all, "volumeUsdKnown"), all).code).toBe("PART_OF_WHOLE");
  });
});

describe("the question-matching chooser", () => {
  it("'do busy days have more refunds' tests swap count against the refund RATE, with the outcome last", () => {
    const c = cands(A, ACC);
    const r = chooseForQuestion(c, "Do busy NEAR Intents days have more refunds?")!;
    expect(r.x.column).toBe("swaps");
    expect(r.y.column).toBe("refundRate");
    expect(r.expectedSign).toBe("positive");
    expect(r.why).toMatch(/matches/);
  });
  it("'new versus returning accounts' tests new against returning, never against the active total", () => {
    const r = chooseForQuestion(cands(A, ACC), "How do new accounts compare with returning accounts?")!;
    expect([r.x.column, r.y.column]).toEqual(["newAccounts", "returningAccounts"]);
    expect(r.expectedSign).toBe("either");
  });
  it("finds nothing for an unrelated question, and for pairs with fewer than 30 shared days", () => {
    expect(chooseForQuestion(cands(A, ACC), "Zebra migration patterns")).toBeNull();
    expect(chooseForQuestion(cands(A), "Do busy days have more refunds?", 1000)).toBeNull();
  });
  it("reads tokens with camelCase, plurals and tenses", () => {
    expect(tokensOf("refundRate Refunded refunds")).toEqual(["refund", "rate", "refund", "refund"]);
    expect(expectedSignOf("Do quiet days have fewer refunds?")).toBe("negative");
    expect(expectedSignOf("Is X related to Y")).toBe("either");
    // a topic word is not a direction: "user growth" asks for no sign
    expect(
      expectedSignOf("Investigate NEAR user growth: compare daily new accounts against returning accounts"),
    ).toBe("either");
    expect(expectedSignOf("Do busy days have fewer refunds?")).toBe("either");
    expect(statementOf({ column: "swaps" }, { column: "refundRate" }, "moves_with", 0, "positive")).toBe(
      "Days with higher swaps have higher refund rate.",
    );
    expect(statementOf({ column: "swaps" }, { column: "refundRate" }, "leads", 7, "negative")).toBe(
      "Days with higher swaps are followed 7 days later by lower refund rate.",
    );
  });
  it("planFor records the plan with lag and the relation", () => {
    const c = cands(A);
    const p = planFor(by(c, "swaps"), by(c, "refundRate"), {
      chosenBy: "planner",
      why: "w",
      lagDays: 3,
      expectedSign: "negative",
    });
    expect(p).toMatchObject({ relation: "leads", lagDays: 3, expectedSign: "negative", chosenBy: "planner" });
    expect(p.x).toMatchObject({
      panel: "a".repeat(64),
      column: "swaps",
      panelTitle: "Daily refund rate trend",
    });
  });
});

describe("a pair proposed by a model is validated against the real candidates", () => {
  const c = cands(A, ACC);
  const A_ = "a".repeat(64);
  it("accepts real ids and refuses invented ones, the same series, part-of-whole pairs and bad lags", () => {
    expect(
      validateProposal(
        { x: { panelHash: A_, column: "swaps" }, y: { panelHash: A_, column: "refundRate" } },
        c,
      ).ok,
    ).toBe(true);
    expect(
      validateProposal({ x: { panelHash: A_, column: "swaps" }, y: { panelHash: A_, column: "nope" } }, c),
    ).toMatchObject({ ok: false });
    expect(
      validateProposal({ x: { panelHash: A_, column: "swaps" }, y: { panelHash: A_, column: "swaps" } }, c),
    ).toMatchObject({ ok: false });
    const pw = validateProposal(
      { x: { panelHash: A_, column: "swaps" }, y: { panelHash: A_, column: "success" } },
      c,
    );
    expect(pw).toMatchObject({ ok: false });
    expect(
      validateProposal(
        { x: { panelHash: A_, column: "swaps" }, y: { panelHash: A_, column: "refundRate" }, lagDays: 99 },
        c,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("rounding of long decimals", () => {
  it("rounds half to even and records nothing for values that fit exactly", () => {
    const d = (s: string) => ({
      neg: false,
      int: s.split(".")[0]!,
      frac: (s.split(".")[1] ?? "").replace(/0+$/, ""),
    });
    expect(roundHalfEven(d("0.0000025"), 6)).toEqual(d("0.000002"));
    expect(roundHalfEven(d("0.0000035"), 6)).toEqual(d("0.000004"));
    expect(roundHalfEven(d("1.9999995"), 6)).toEqual(d("2"));
    expect(roundHalfEven(d("0.12345678"), 6)).toEqual(d("0.123457"));
    expect(roundHalfEven(d("0.1234"), 6)).toEqual(d("0.1234"));
    const exact = scaleSeries("p", ["1.5", "2.25"]);
    expect(exact).toMatchObject({ places: 2, rounding: null });
    expect(exact.scaled).toEqual([150n, 225n]);
    // many decimals but still fits after exact scaling: stays exact, so a capsule that already exists keeps its bytes
    expect(scaleSeries("p", ["0.12345678", "0.2"]).rounding).toBeNull();
  });
  it("a price with eighteen decimals is rounded to six, scaled, and the rounding is recorded", () => {
    const price = ["3.123456789012345678", "3.1234565", "3.1234575", "-0.5"];
    const r = scaleSeries("price", price);
    expect(r.places).toBe(6);
    expect(r.scaled).toEqual([3_123_457n, 3_123_456n, 3_123_458n, -500_000n]);
    expect(r.rounding).toEqual({ decimalsKept: 6, maxAbsRoundingDifference: "0.0000005" });
    expect(() => scaleSeries("big", ["1000000000000000.5", "3"])).toThrow(/above 1e15/);
    expect(() => scaleSeries("huge", ["1000000000000000000000.1234567", "3"])).toThrow(/even rounded/);
  });
});
