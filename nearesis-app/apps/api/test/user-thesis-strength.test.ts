import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandOf, strengthOf } from "../src/user-thesis/strength.ts";

const none = { verified: 0, reproduced: 0 };
const pts = (s: ReturnType<typeof strengthOf>): Record<string, number> =>
  Object.fromEntries(s.parts.map((p) => [p.key, p.points]));

/** A document as built before the test plan, the interval and the second rule existed. */
const oldDoc = {
  schema: "nearesis.thesis.v1",
  origin: { kind: "workspace" },
  verdict: { status: "MIXED", headline: "MIXED", comparison: { summary: "", rows: [] } },
  test: { rule: "relationship-v1", n: 70, pearson: "0.62", coverage: { complete: true } },
  verification: { capsule: { status: "reproduced" }, outlayer: null },
};
const fullDoc = {
  schema: "nearesis.thesis.v1",
  origin: { kind: "workspace" },
  verdict: { status: "SUPPORTED", headline: "SUPPORTED" },
  test: {
    rule: "relationship-v2",
    n: 200,
    coverage: { complete: true },
    plan: {
      statement: "Swaps move with volume.",
      lockedAt: "2026-11-14T10:00:00.000Z",
      sha256: "ab".repeat(32),
      chosenBy: "user",
    },
    interval: { lo: "0.31", hi: "0.58" },
  },
  verification: {
    capsule: { status: "reproduced" },
    outlayer: { status: "verified", requestId: "r", txHash: "t" },
  },
};
const reference = JSON.parse(
  readFileSync(join(__dirname, "../../../thesis/archive/intents-vs-price-v1/build/thesis.json"), "utf8"),
);
reference.origin = { kind: "reference" };

describe("strengthOf", () => {
  it("scores a thesis built before the plan and the interval: those parts are 0 with an honest detail", () => {
    const s = strengthOf(oldDoc, none, []);
    expect(pts(s)).toEqual({
      plan_locked: 0,
      days_of_data: 10,
      coverage_complete: 10,
      valid_test: 0,
      interval_or_not_supported: 0,
      capsule_verifies: 10,
      outlayer_proof: 0,
      independently_verified: 0,
      reproduced: 0,
      challenges_answered: 5,
    });
    expect(s.score).toBe(35);
    expect(s.band).toBe("thin");
    expect(s.parts.find((p) => p.key === "plan_locked")!.detail).toContain("without a test plan");
    expect(s.parts.find((p) => p.key === "days_of_data")!.detail).toContain("70 aligned days");
    expect(s.parts.reduce((a, p) => a + p.max, 0)).toBe(100);
  });

  it("gives full points to a locked plan, an interval excluding zero, a verified proof and receipts", () => {
    const s = strengthOf(fullDoc, { verified: 3, reproduced: 1 }, []);
    expect(s.score).toBe(100);
    expect(s.band).toBe("strong");
    expect(s.parts.find((p) => p.key === "plan_locked")!.detail).toContain("2026-11-14T10:00:00.000Z");
    expect(s.parts.find((p) => p.key === "interval_or_not_supported")!.detail).toContain("0.31 to 0.58");
    expect(s.parts.find((p) => p.key === "independently_verified")!.detail).toContain("3 times");
  });

  it("counts an interval that includes zero as 0, a clear NOT_SUPPORTED as full, and ppm intervals", () => {
    const withIv = (iv: unknown, status = "MIXED") =>
      strengthOf({ ...fullDoc, verdict: { status }, test: { ...fullDoc.test, interval: iv } }, none, []);
    expect(pts(withIv({ lo: "-0.1", hi: "0.4" })).interval_or_not_supported).toBe(0);
    expect(pts(withIv({ loPpm: "-200000", hiPpm: "-100000" })).interval_or_not_supported).toBe(10);
    expect(pts(withIv(undefined, "NOT_SUPPORTED")).interval_or_not_supported).toBe(10);
    expect(pts(withIv(undefined, "MIXED")).interval_or_not_supported).toBe(0);
  });

  it("scores the plan, the pair choice and the days by their tiers", () => {
    const t = (test: object, status = "MIXED") =>
      strengthOf({ ...fullDoc, verdict: { status }, test: { ...fullDoc.test, ...test } }, none, []);
    expect(pts(t({ n: 180 })).days_of_data).toBe(15);
    expect(pts(t({ n: 179 })).days_of_data).toBe(10);
    expect(pts(t({ n: 60 })).days_of_data).toBe(10);
    expect(pts(t({ n: 59 })).days_of_data).toBe(5);
    expect(pts(t({ n: 30 })).days_of_data).toBe(5);
    expect(pts(t({ n: 29 })).days_of_data).toBe(0);
    expect(pts(t({ n: null })).days_of_data).toBe(0);
    expect(
      pts(t({ plan: { statement: null, lockedAt: "x", sha256: "y", chosenBy: "rule" } })).plan_locked,
    ).toBe(0);
    expect(
      pts(t({ plan: { statement: "s", lockedAt: null, sha256: null, chosenBy: "user" } })).plan_locked,
    ).toBe(0);
    expect(pts(t({ plan: { ...fullDoc.test.plan, chosenBy: "rule" } })).valid_test).toBe(0);
    expect(pts(t({ partOfWhole: true })).valid_test).toBe(0);
    expect(pts(t({}, "INVALID_TEST")).valid_test).toBe(0);
    expect(pts(t({ coverage: { complete: false } })).coverage_complete).toBe(0);
    expect(pts(t({ coverage: undefined })).coverage_complete).toBe(0);
  });

  it("an OutLayer proof that is not verified, or a mismatching capsule, scores 0", () => {
    const d = {
      ...fullDoc,
      verification: { capsule: { status: "mismatch" }, outlayer: { status: "failed" } },
    };
    const s = strengthOf(d, none, []);
    expect(pts(s).capsule_verifies).toBe(0);
    expect(pts(s).outlayer_proof).toBe(0);
    expect(s.parts.find((p) => p.key === "outlayer_proof")!.detail).toContain("failed");
  });

  it("an unanswered material challenge removes the 5 points; an answer or only minor notes keep them", () => {
    const open = [{ outcome: "weakened", notes: [{ severity: "material" }], answer: null }];
    expect(pts(strengthOf(fullDoc, none, open)).challenges_answered).toBe(0);
    expect(pts(strengthOf(fullDoc, none, [{ ...open[0]!, answer: "Checked." }])).challenges_answered).toBe(5);
    expect(
      pts(strengthOf(fullDoc, none, [{ outcome: "holds", notes: [{ severity: "minor" }], answer: null }]))
        .challenges_answered,
    ).toBe(5);
  });

  it("maps the reference thesis from its own facts", () => {
    const s = strengthOf(reference, none, []);
    expect(pts(s)).toEqual({
      plan_locked: 15,
      days_of_data: 10,
      coverage_complete: 0,
      valid_test: 10,
      interval_or_not_supported: 0,
      capsule_verifies: 0,
      outlayer_proof: 0,
      independently_verified: 0,
      reproduced: 0,
      challenges_answered: 5,
    });
    expect(s.score).toBe(40);
    expect(s.band).toBe("fair");
    const d = (k: string) => s.parts.find((p) => p.key === k)!.detail;
    expect(d("plan_locked")).toContain("c1671ce22c51");
    expect(d("days_of_data")).toContain("77 scored forecast origins");
    expect(d("coverage_complete")).toContain("marked partial");
    expect(d("interval_or_not_supported")).toContain("0.98924266");
    expect(d("interval_or_not_supported")).toContain("0.05");
    // a passed bundle verification (hashes listed) earns the capsule and verified parts
    const v = strengthOf(reference, { verified: 2, reproduced: 0 }, []);
    expect(pts(v).capsule_verifies).toBe(10);
    expect(pts(v).independently_verified).toBe(5);
    expect(v.score).toBe(55);
  });

  it("maps the forecast reference thesis: method frozen, days of data, backtest, calibrated band, hashes", () => {
    const fc = JSON.parse(readFileSync(join(__dirname, "../../../thesis/build/thesis.json"), "utf8"));
    fc.origin = { kind: "reference" };
    const s = strengthOf(fc, none, []);
    const p = pts(s);
    expect(p.plan_locked).toBe(15);
    expect(p.days_of_data).toBe(15);
    expect([0, 5, 10]).toContain(p.coverage_complete);
    expect([0, 5, 10]).toContain(p.valid_test);
    expect([0, 5, 10]).toContain(p.interval_or_not_supported);
    expect(p.capsule_verifies).toBe(0);
    const d = (k: string) => s.parts.find((x) => x.key === k)!.detail;
    expect(d("plan_locked")).toContain(fc.forecast.methodFrozenAt);
    expect(d("days_of_data")).toContain(String(fc.forecast.daysOfData));
    expect(d("valid_test")).toContain("naive");
    // a passed bundle verification earns the capsule and verified parts
    const v = strengthOf(fc, { verified: 1, reproduced: 0 }, []);
    expect(pts(v).capsule_verifies).toBe(10);
    expect(pts(v).independently_verified).toBe(5);
  });

  it("bands: below 40 thin, below 60 fair, below 80 solid, else strong", () => {
    expect([0, 39, 40, 59, 60, 79, 80, 100].map(bandOf)).toEqual([
      "thin",
      "thin",
      "fair",
      "fair",
      "solid",
      "solid",
      "strong",
      "strong",
    ]);
  });
});
