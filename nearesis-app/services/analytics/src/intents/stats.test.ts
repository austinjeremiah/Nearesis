import { describe, expect, it } from "vitest";
import { norm, pctChange, ratio } from "./dec.ts";
import { concentration, detectUnusual } from "./stats.ts";

describe("exact decimal helpers", () => {
  it("ratio is exact and null on a zero denominator", () => {
    expect(ratio(1, 3)).toBe("0.333333");
    expect(ratio(2, 3)).toBe("0.666667");
    expect(ratio(1, 0)).toBeNull();
  });
  it("pctChange is exact, null when the previous value is 0", () => {
    expect(pctChange("150", "100")).toBe("50.00");
    expect(pctChange("1055.12", "1200.5")).toBe("-12.11");
    expect(pctChange("5", "0")).toBeNull();
  });
  it("norm trims trailing zeros", () => {
    expect(norm("12.500000")).toBe("12.5");
    expect(norm("3.000")).toBe("3");
    expect(norm("0.100000000000000001")).toBe("0.100000000000000001");
  });
});

describe("concentration", () => {
  it("computes top-N share and HHI exactly", () => {
    const c = concentration(
      [
        { key: "a", value: "50" },
        { key: "b", value: "30" },
        { key: "c", value: "20" },
      ],
      2,
    );
    expect(c.total).toBe("100");
    expect(c.hhi).toBe("3800.0000");
    expect(c.topNShare).toBe("0.800000");
    expect(c.top.map((t) => t.key)).toEqual(["a", "b"]);
  });
  it("an empty population has no concentration (null, not 0)", () => {
    const c = concentration([{ key: "a", value: "0" }], 3);
    expect(c.hhi).toBeNull();
    expect(c.total).toBeNull();
    expect(c.groups).toBe(0);
  });
  it("HHI of a monopoly is 10000", () => {
    expect(concentration([{ key: "x", value: "1234.5678" }], 1).hhi).toBe("10000.0000");
  });
});

describe("unusual flow detection (modified z-score)", () => {
  const base = Array.from({ length: 28 }, (_, i) => 20 + (i % 3));
  it("flags a spike and leaves normal days alone", () => {
    const r = detectUnusual(base, [
      { day: "d1", value: 21 },
      { day: "d2", value: 90 },
    ]);
    expect(r.scoreable).toBe(true);
    expect(r.anomalies.map((a) => a.day)).toEqual(["d2"]);
    expect(r.anomalies[0]?.direction).toBe("up");
  });
  it("flags a collapse as down", () => {
    expect(detectUnusual(base, [{ day: "d", value: 2 }]).anomalies[0]?.direction).toBe("down");
  });
  it("refuses to score a short, tiny or flat baseline instead of guessing", () => {
    expect(detectUnusual(base.slice(0, 5), [{ day: "d", value: 99 }]).scoreable).toBe(false);
    expect(detectUnusual(Array(28).fill(1), [{ day: "d", value: 99 }]).scoreable).toBe(false);
    expect(detectUnusual(Array(28).fill(20), [{ day: "d", value: 99 }]).scoreable).toBe(false);
  });
  it("absolute-delta guard suppresses tiny departures", () => {
    const b = Array.from({ length: 28 }, (_, i) => 6 + (i % 2));
    expect(detectUnusual(b, [{ day: "d", value: 12 }], { minAbsDelta: 10 }).anomalies).toEqual([]);
  });
});
