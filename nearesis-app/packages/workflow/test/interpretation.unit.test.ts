import { describe, expect, it } from "vitest";
import { analyticsCallOf, analyticsResultOf } from "../src/interpretation.ts";

describe("analytics panels as interpretation input", () => {
  it("records only successful analytics calls, keyed by their call hash", () => {
    const h = "a".repeat(64);
    expect(
      analyticsCallOf("intents.analyze@1", { analysis: "trend" }, { ok: true, outcome: "OK", callHash: h }),
    ).toEqual({
      callHash: h,
      capability: "intents.analyze@1",
      input: { analysis: "trend" },
    });
    expect(
      analyticsCallOf("intents.analyze@1", {}, { ok: true, outcome: "CANNOT_COMPUTE", callHash: h }),
    ).toBeNull();
    expect(analyticsCallOf("intents.analyze@1", {}, { ok: false })).toBeNull();
  });
  it("maps a table to a panel result: unknown days are gaps, never certified", () => {
    const r = analyticsResultOf(
      { panelId: "p", title: "Refunds", hash: "h", completeness: "partial", analytics: true },
      {
        callHash: "b".repeat(64),
        provenance: { metricVersion: "1.0.0", asOf: "2026-11-10" },
        table: {
          columns: [
            { name: "week", type: "time", unit: null },
            { name: "swaps", type: "number", unit: "swaps" },
          ],
          rows: [
            ["2026-08-03", 5],
            ["2026-08-10", null],
          ],
          truncated: false,
        },
        coverage: { state: "partial", missingDays: ["2026-08-05"], incompleteDays: ["2026-08-06"] },
      } as never,
    );
    expect(r.certification).toBe("experimental");
    expect(r.gaps).toHaveLength(1);
    expect(r.partialCount).toBe(1);
    expect(r.nullCount).toBe(1);
    expect(r.queryHash).toBe("b".repeat(64));
  });
});
