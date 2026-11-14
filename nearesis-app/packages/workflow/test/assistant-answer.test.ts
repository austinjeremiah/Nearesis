import { describe, expect, it } from "vitest";
import type { AnalyticsOkResult } from "@nearesis/contracts";
import { cellString, chartOf, summaryOf, type AssistantFinding } from "../src/assistant-answer.ts";

const finding = (o: Partial<AssistantFinding>): AssistantFinding => ({
  statement: "Swaps rose from 5 to 12.",
  basis: "observation",
  status: "supported",
  chartIds: ["c1"],
  facts: [
    { value: "5", unit: "swaps" },
    { value: "12", unit: "swaps" },
  ],
  limitations: [],
  skepticNotes: [],
  skepticVerdict: "holds",
  ...o,
});

describe("summaryOf", () => {
  it("is built from grounded finding sentences, at most five", () => {
    const s = summaryOf([
      finding({
        statement: "Swaps rose from 5 to 12. The peak was 12 on 2026-11-05. A third sentence about 5.",
      }),
      finding({ statement: "Refunds stayed at 5." }),
    ]);
    expect(s).toContain("Swaps rose from 5 to 12.");
    expect(s).toContain("Refunds stayed at 5.");
    expect(s!.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(5);
  });

  it("is null when a number in it does not ground against the returned facts", () => {
    expect(summaryOf([finding({ statement: "Swaps rose from 5 to 13 overall." })])).toBeNull();
  });

  it("never writes in a finding the skeptic judged unsupported, nor an insufficient one", () => {
    expect(summaryOf([finding({ skepticVerdict: "unsupported" })])).toBeNull();
    expect(summaryOf([finding({ status: "insufficient_data" })])).toBeNull();
  });
});

const base = (o: Partial<AnalyticsOkResult>): AnalyticsOkResult =>
  ({
    outcome: "OK",
    capability: "intents.analyze@1",
    analysis: "trend",
    label: "ANALYTICS_RESULT",
    certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
    callHash: "a".repeat(64),
    call: { capability: "intents.analyze@1", input: {} },
    metric: "m",
    definition: "d",
    window: { from: "2026-11-01", to: "2026-11-03" },
    provenance: {
      source: "src",
      tables: [],
      asOf: null,
      computedAt: "x",
      metricVersion: "1.0.0",
      method: "m",
    },
    coverage: {
      state: "partial",
      daysRequested: 3,
      daysWithData: 2,
      missingDays: ["2026-11-02"],
      incompleteDays: [],
      note: null,
    },
    caveats: [],
    table: { columns: [], rows: [], totalRows: 0, truncated: false },
    chart: { kind: "line", y: [] },
    ...o,
  }) as AnalyticsOkResult;

describe("chartOf", () => {
  it("keeps unknown cells null (never zero), says so in coverage and caveats", () => {
    const c = chartOf(
      "c1",
      "t",
      base({
        table: {
          columns: [
            { name: "day", type: "time", unit: null },
            { name: "swaps", type: "number", unit: "swaps" },
          ],
          rows: [
            ["2026-11-01", 5],
            ["2026-11-02", null],
            ["2026-11-03", 7.5],
          ],
          totalRows: 3,
          truncated: false,
        },
        chart: { kind: "line", x: "day", y: ["swaps"] },
      }),
    );
    expect(c.kind).toBe("line");
    expect(c.series[0]!.values).toEqual(["5", null, "7.5"]);
    expect(c.coverage).toContain("partial");
    expect(c.caveats.join(" ")).toContain("unknown, not zero");
  });

  it("pivots long format into one series per category and falls back to a table when nothing is plottable", () => {
    const long = chartOf(
      "c2",
      "t",
      base({
        table: {
          columns: [
            { name: "week", type: "time", unit: null },
            { name: "pair", type: "category", unit: null },
            { name: "swaps", type: "number", unit: "swaps" },
          ],
          rows: [
            ["2026-11-01", "a->b", 3],
            ["2026-11-01", "c->d", 1],
            ["2026-11-08", "a->b", 4],
          ],
          totalRows: 3,
          truncated: false,
        },
        chart: { kind: "line", x: "week", y: ["swaps"], series: "pair" },
      }),
    );
    expect(long.series.map((s) => s.name)).toEqual(["a->b", "c->d"]);
    expect(long.series.find((s) => s.name === "c->d")!.values).toEqual(["1", null]);
    const t = chartOf(
      "c3",
      "t",
      base({
        table: {
          columns: [{ name: "k", type: "category", unit: null }],
          rows: [["x"]],
          totalRows: 1,
          truncated: false,
        },
        chart: { kind: "heatmap", y: [] },
      }),
    );
    expect(t).toMatchObject({ kind: "table", columns: ["k"], rows: [["x"]] });
  });

  it("writes numbers as exact decimal strings", () => {
    expect(cellString(1e-7)).toBe("0.0000001");
    expect(cellString(12)).toBe("12");
    expect(cellString(null)).toBeNull();
    expect(cellString("123.450")).toBe("123.450");
  });
});
