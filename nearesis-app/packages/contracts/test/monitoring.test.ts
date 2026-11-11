import { describe, expect, it } from "vitest";
import * as C from "../src/index.ts";

describe("v1.5.0 monitoring contracts", () => {
  it("marker transitions are exactly the ch.09 chain", () => {
    expect(C.MARKER_TRANSITIONS).toEqual({
      DRAFT: ["ACTIVE"],
      ACTIVE: ["INVESTIGATING"],
      INVESTIGATING: ["REVIEW_REQUIRED"],
      REVIEW_REQUIRED: ["RESOLVED", "MONITORING", "DISMISSED"],
      RESOLVED: [],
      MONITORING: [],
      DISMISSED: [],
    });
    expect(C.isMarkerTransitionAllowed("DRAFT", "RESOLVED")).toBe(false);
  });
  it("source_event anchors and condition ASTs validate; code-like input does not", () => {
    expect(
      C.MarkerAnchor.safeParse({
        kind: "source_event",
        sourceId: "s",
        eventId: "e",
        at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    const ok = {
      kind: "and",
      terms: [
        { kind: "compare", metricId: "m", op: "gt", value: 1 },
        { kind: "not", term: { kind: "compare", metricId: "n", op: "lte", value: 2 } },
      ],
    };
    expect(C.Condition.safeParse(ok).success).toBe(true);
    expect(C.Condition.safeParse({ kind: "compare", metricId: "m", op: "gt", value: "1" }).success).toBe(
      false,
    );
    expect(C.Condition.safeParse({ kind: "expr", code: "1+1" }).success).toBe(false);
    expect(C.conditionShape(ok as C.Condition)).toEqual({ depth: 3, nodes: 4 });
  });
  it("watermark events and triggers carry a live|replay mode", () => {
    expect(C.TriggerMode.options).toEqual(["live", "replay"]);
    expect(
      C.WatermarkEvent.safeParse({
        sourceId: "s",
        watermark: "2026-01-01T00:00:00Z",
        mode: "replay",
        values: { a: 1 },
      }).success,
    ).toBe(true);
    expect(
      C.WatermarkEvent.safeParse({
        sourceId: "s",
        watermark: "2026-01-01T00:00:00Z",
        mode: "other",
        values: {},
      }).success,
    ).toBe(false);
  });
});
