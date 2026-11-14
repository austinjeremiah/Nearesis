import { describe, expect, it } from "vitest";
import * as C from "../src/index.ts";

const base = {
  panelId: "5d1c3a0e-8f1b-4c6e-9b53-2f4a7c1d9e10",
  schemaVersion: 1,
  kind: "bar",
  title: "t",
  queryRef: { hash: "a".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
  dataBinding: { fields: ["x", "y"], units: { y: "swaps" }, timezone: "UTC", completeness: "complete" },
  encoding: { x: "x", y: ["y"], interpolateGaps: false },
  layout: { x: 0, y: 0, w: 6, h: 6 },
  refreshPolicy: { mode: "manual" },
  provenanceRequired: true,
};
const binding = {
  capability: "intents.analyze@1",
  analysis: "status",
  label: "ANALYTICS_RESULT",
  certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
  sourceTables: ["nearesis_live.intents_swaps"],
  metricVersion: "intents-1.0.0",
  coverageState: "partial",
};

describe("contracts 1.8.0: analytics capabilities and analytics panels (additive)", () => {
  it("bumps the contract version and keeps every older panel valid", () => {
    expect(C.CONTRACTS_VERSION).toBe("1.9.0");
    expect(C.PanelSpec.safeParse(base).success).toBe(true); // semantic-query panel without the new fields
  });
  it("an analytics_result panel needs the ANALYTICS_RESULT binding, and only it may carry one", () => {
    const withKind = { ...base, queryRef: { ...base.queryRef, resultKind: "analytics_result" } };
    expect(C.PanelSpec.safeParse(withKind).success).toBe(false);
    expect(C.PanelSpec.safeParse({ ...withKind, analytics: binding }).success).toBe(true);
    expect(C.PanelSpec.safeParse({ ...base, analytics: binding }).success).toBe(false);
    // the label cannot be "certified": the binding literals are fixed
    expect(
      C.PanelSpec.safeParse({ ...withKind, analytics: { ...binding, certification: "CERTIFIED" } }).success,
    ).toBe(false);
    expect(
      C.PanelSpec.safeParse({ ...withKind, analytics: { ...binding, label: "CERTIFIED_METRIC" } }).success,
    ).toBe(false);
  });
  it("inputs are typed and bounded: no SQL, no tenancy, windows and top-N capped", () => {
    const i = C.INPUT_BY_CAPABILITY["intents.analyze@1"];
    expect(
      i.safeParse({ analysis: "status", from: "2026-08-01", to: "2026-11-01", grain: "week" }).success,
    ).toBe(true);
    for (const bad of [
      { analysis: "status", sql: "select 1" },
      { analysis: "status", tenantId: "x" },
      { analysis: "status", days: C.ANALYTICS_LIMITS.maxWindowDays + 1 },
      { analysis: "refund_rates", top: C.ANALYTICS_LIMITS.maxTop + 1 },
      { analysis: "status", from: "2026-02-31x" },
      { analysis: "nope" },
    ])
      expect(i.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(
      C.INPUT_BY_CAPABILITY["entities.analyze@1"].safeParse({
        analysis: "unique_signers",
        entityId: "x; drop",
      }).success,
    ).toBe(false);
  });
  it("every outcome is OK with a table or CANNOT_COMPUTE with what is missing", () => {
    expect(C.AnalyticsOutcome.safeParse({ outcome: "OK" }).success).toBe(false);
    expect(C.AnalyticsOutcome.safeParse({ outcome: "CANNOT_COMPUTE" }).success).toBe(false);
    expect(Object.keys(C.ANALYSES_BY_CAPABILITY)).toEqual([
      "intents.analyze@1",
      "entities.analyze@1",
      "accounts.analyze@1",
    ]);
  });
});
