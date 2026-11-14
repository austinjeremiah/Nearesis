import { describe, expect, it } from "vitest";
import type { AnalyticsOkResult } from "@nearesis/contracts";
import { compileAnalyticsPanel } from "../src/index.ts";

const result = (over: Partial<AnalyticsOkResult> = {}): AnalyticsOkResult => ({
  outcome: "OK",
  capability: "accounts.analyze@1",
  analysis: "daily",
  label: "ANALYTICS_RESULT",
  certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
  callHash: "b".repeat(64),
  call: { capability: "accounts.analyze@1", input: { analysis: "daily" } },
  metric: "accounts.daily_active",
  definition: "d",
  window: { from: "2026-11-01", to: "2026-11-05" },
  provenance: {
    source: "s",
    tables: ["nearesis_live.account_daily_new_returning"],
    asOf: null,
    computedAt: "2026-11-13T00:00:00Z",
    metricVersion: "accounts-1.0.0",
    method: "m",
  },
  coverage: {
    state: "partial",
    daysRequested: 5,
    daysWithData: 3,
    missingDays: ["2026-11-01"],
    incompleteDays: [],
    note: "gaps",
  },
  caveats: ["Accounts are not people."],
  table: {
    columns: [
      { name: "date", type: "time", unit: null },
      { name: "activeAccounts", type: "number", unit: "accounts" },
      { name: "newAccounts", type: "number", unit: "accounts" },
    ],
    rows: [["2026-11-02", 100, 5]],
    totalRows: 1,
    truncated: false,
  },
  chart: { kind: "line", x: "date", y: ["activeAccounts", "newAccounts"] },
  ...over,
});
const o = {
  panelId: "5d1c3a0e-8f1b-4c6e-9b53-2f4a7c1d9e10",
  title: "Active accounts",
  layout: { x: 0, y: 0, w: 6, h: 6 },
};

describe("compileAnalyticsPanel", () => {
  it("builds a typed timeSeries panel bound to the call hash, labelled ANALYTICS_RESULT, with coverage as completeness", () => {
    const c = compileAnalyticsPanel(result(), o);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.panel).toMatchObject({
      kind: "timeSeries",
      queryRef: { hash: "b".repeat(64), resultKind: "analytics_result" },
      dataBinding: {
        completeness: "partial",
        units: { activeAccounts: "accounts", newAccounts: "accounts" },
      },
      analytics: {
        label: "ANALYTICS_RESULT",
        certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
        coverageState: "partial",
      },
      provenanceRequired: true,
    });
    expect(c.value.panel.note).toMatch(/not a certified semantic metric/);
    expect(c.value.panel.note).toMatch(/Coverage: partial/);
    expect(c.value.viz.axes.map((a) => a.field)).toEqual(["activeAccounts", "newAccounts"]);
  });
  it("a line over a non-time axis becomes a bar; a table result has no y encoding", () => {
    const bar = compileAnalyticsPanel(
      result({ chart: { kind: "line", x: "activeAccounts", y: ["newAccounts"] } }),
      o,
    );
    expect(bar.ok && bar.value.panel.kind).toBe("bar");
    const t = compileAnalyticsPanel(result({ chart: { kind: "table", y: [] } }), o);
    expect(t.ok && t.value.panel.kind).toBe("table");
    expect(t.ok && t.value.panel.encoding.y).toBeUndefined();
  });
  it("refuses a measure that has no unit rather than drawing it unlabelled", () => {
    const r = result();
    r.table.columns[1] = { name: "activeAccounts", type: "number", unit: null };
    r.chart = { kind: "line", x: "date", y: ["activeAccounts"] };
    const c = compileAnalyticsPanel(r, o);
    // a y field without a unit is dropped from the encoding; with no plottable y left the compile fails the kind rule
    expect(c.ok).toBe(false);
  });
  it("says so on the panel when rows were truncated", () => {
    const r = result();
    r.table.truncated = true;
    r.table.totalRows = 5000;
    const c = compileAnalyticsPanel(r, o);
    expect(c.ok && c.value.panel.note).toMatch(/Showing 1 of 5000 rows/);
  });
});
