import { describe, expect, it } from "vitest";
import {
  compareIntSeries,
  eachDay,
  missingDays,
  serializeRaw,
  sha256Hex,
  toPlainDecimal,
  topOverlap,
} from "./data-lib.ts";

describe("toPlainDecimal", () => {
  it("expands exponents without rounding", () => {
    expect(toPlainDecimal("1.2345e+10")).toBe("12345000000");
    expect(toPlainDecimal("4.8677353992507e7")).toBe("48677353.992507");
    expect(toPlainDecimal("1e-7")).toBe("0.0000001");
    expect(toPlainDecimal("2.5E-3")).toBe("0.0025");
  });
  it("normalises trailing zeros and signs", () => {
    expect(toPlainDecimal("2.786479825543101000")).toBe("2.786479825543101");
    expect(toPlainDecimal("+3.0")).toBe("3");
    expect(toPlainDecimal("-0.50")).toBe("-0.5");
    expect(toPlainDecimal("000.0")).toBe("0");
  });
  it("keeps null and rejects non-numbers", () => {
    expect(toPlainDecimal(null)).toBeNull();
    expect(() => toPlainDecimal("nan")).toThrow();
    expect(() => toPlainDecimal("1,5")).toThrow();
  });
});

describe("days and gaps", () => {
  it("lists missing days and never counts null as present", () => {
    expect(eachDay("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    const rows = [
      ["2026-03-01", "5"],
      ["2026-03-02", null],
    ];
    expect(missingDays(rows, "2026-02-28", "2026-03-02")).toEqual(["2026-02-28", "2026-03-02"]);
  });
});

describe("comparison and serialization", () => {
  it("compares exactly and reports the largest difference", () => {
    const c = compareIntSeries(
      [
        ["2026-01-01", "100"],
        ["2026-01-02", "200"],
        ["2026-01-03", "300"],
      ],
      [
        ["2026-01-01", "100"],
        ["2026-01-02", "190"],
        ["2026-01-04", "1"],
      ],
    );
    expect(c).toMatchObject({ daysCompared: 2, daysEqual: 1, maxAbsDiff: "10", maxAbsDiffDay: "2026-01-02" });
  });
  it("is deterministic", () => {
    const a = serializeRaw([{ name: "d", type: "date" }], [["2026-01-01"]]);
    expect(a).toBe('{"columns":[{"name":"d","type":"date"}],"rows":[\n["2026-01-01"]\n]}\n');
    expect(sha256Hex(a)).toBe(sha256Hex(a));
    expect(topOverlap(["a", "b", "c"], ["c", "x", "a"], 3)).toBe(2);
  });
});
