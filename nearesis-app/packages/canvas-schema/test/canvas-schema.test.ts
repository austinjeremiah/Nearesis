import { describe, expect, it } from "vitest";
import type { ChartData } from "@nearesis/contracts";
import {
  applyCanvasPatch,
  applyOps,
  buildSelection,
  canTransition,
  compileVisualization,
  documentContentHash,
  downsampleMinMax,
  initialRuntime,
  parseSafeMarkdown,
  previewHash,
  transition,
  validateCanvasPatchSemantics,
  validatePanelSpec,
  type VizRequest,
} from "../src/index.ts";
import { CATALOG } from "./fixtures/catalog.ts";
import { emptyDoc, NOW, panel, RESULT_SWAPS, SHA, uuid } from "./fixtures/build.ts";

const patchOf = (ops: unknown[], expectedRevision = 0) => ({
  schemaVersion: 1,
  type: "workspace.patch",
  operationId: uuid(7000 + ops.length),
  expectedRevision,
  operations: ops,
});

describe("panel validation", () => {
  it("accepts a valid panel and rejects unbound encoding fields", () => {
    expect(validatePanelSpec(panel(1)).ok).toBe(true);
    const bad = panel(1, { encoding: { x: "intents.day", y: ["nope"], interpolateGaps: false } });
    const r = validatePanelSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("ENCODING_FIELD_UNKNOWN");
  });
  it("checks fields against the query result when a resolver is given", () => {
    const p = panel(1, {
      dataBinding: {
        fields: ["intents.day", "ghost"],
        units: { ghost: "count" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "intents.day", y: ["ghost"], interpolateGaps: false },
    });
    const r = validatePanelSpec(p, { resolveQuery: () => RESULT_SWAPS });
    expect(!r.ok && r.issues.some((i) => i.code === "FIELD_NOT_IN_RESULT")).toBe(true);
  });
  it("rejects accessors without invoking them", () => {
    let called = false;
    const p: Record<string, unknown> = { ...panel(1) };
    Object.defineProperty(p, "title", { enumerable: true, get: () => ((called = true), "x") });
    const r = validatePanelSpec(p);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("patch application", () => {
  it("is atomic: one bad op means nothing applies", () => {
    const ops = [1, 2, 3, 4].map((n) => ({ op: "addPanel", panel: panel(n) }));
    (ops[2]!.panel as { encoding: unknown }).encoding = {
      x: "intents.day",
      y: ["missing"],
      interpolateGaps: false,
    };
    const r = applyCanvasPatch(emptyDoc(), patchOf(ops), { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.operations.filter((o) => !o.ok).map((o) => o.index)).toEqual([2]);
    }
  });
  it("applies a valid 4-panel patch in exactly one revision and undo restores the document exactly", () => {
    const doc = emptyDoc();
    const ops = [1, 2, 3, 4].map((n) => ({ op: "addPanel", panel: panel(n) }));
    const r = applyCanvasPatch(doc, patchOf(ops), { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document.documentRevision).toBe(1);
    expect(r.document.dataRevision).toBe(0);
    expect(r.document.panels).toHaveLength(4);
    const undo = applyOps(r.document, r.inverse, { now: NOW });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.document.panels).toEqual(doc.panels);
    const redo = applyOps(undo.document, ops as never, { now: NOW });
    expect(redo.ok && documentContentHash({ ...redo.document, documentRevision: 1 })).toBe(
      documentContentHash(r.document),
    );
  });
  it("rejects stale revisions and duplicate panel ids", () => {
    const r1 = validateCanvasPatchSemantics(emptyDoc(), patchOf([{ op: "addPanel", panel: panel(1) }], 5));
    expect(r1.issues.map((i) => i.code)).toContain("STALE_REVISION");
    const r2 = validateCanvasPatchSemantics(
      emptyDoc(),
      patchOf([
        { op: "addPanel", panel: panel(1) },
        { op: "addPanel", panel: panel(1) },
      ]),
    );
    expect(r2.issues.map((i) => i.code)).toContain("DUPLICATE_PANEL_ID");
  });
  it("preview hash is stable", () => {
    const ops = [{ op: "addPanel" as const, panel: panel(1) }];
    expect(previewHash(emptyDoc(), ops)).toBe(previewHash(emptyDoc(), ops));
  });
  it("marker undo uses the local removeMarker op", () => {
    const d1 = applyCanvasPatch(emptyDoc(), patchOf([{ op: "addPanel", panel: panel(1) }]), { now: NOW });
    if (!d1.ok) throw new Error("setup");
    const marker = {
      markerId: uuid(500),
      panelId: uuid(1),
      anchor: { kind: "time_range", start: "2026-10-20T00:00:00Z", end: "2026-10-27T00:00:00Z" },
      status: "ACTIVE",
      createdBy: uuid(600),
      createdAt: NOW,
    };
    const d2 = applyCanvasPatch(d1.document, patchOf([{ op: "addMarker", marker }], 1), { now: NOW });
    expect(d2.ok).toBe(true);
    if (!d2.ok) return;
    expect(d2.inverse).toEqual([{ op: "removeMarker", markerId: uuid(500) }]);
  });
});

describe("compiler", () => {
  const req = (over: Partial<VizRequest>): VizRequest => ({
    panelId: uuid(1),
    title: "t",
    mark: "line",
    query: { hash: SHA("a"), semanticVersion: "1.0.0", grain: "day" },
    result: RESULT_SWAPS,
    x: "intents.day",
    y: ["intents.swap_count"],
    completeness: "complete",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...over,
  });
  it("refuses undeclared unit mismatch and indexes when declared", () => {
    const bad = compileVisualization(req({ y: ["intents.swap_count", "intents.volume_usd"] }), CATALOG);
    expect(!bad.ok && bad.issues[0]!.code).toBe("UNIT_MISMATCH");
    const ok = compileVisualization(
      req({ y: ["intents.swap_count", "intents.volume_usd"], unitStrategy: "index_100" }),
      CATALOG,
    );
    expect(ok.ok && ok.value.panel.encoding.scale).toBe("index_100");
    expect(ok.ok && ok.value.viz.transforms.map((t) => t.kind)).toEqual(["index_100"]);
  });
});

describe("runtime", () => {
  it("enforces the panel state machine and keeps last good data on error", () => {
    const data = { panelId: uuid(1) } as ChartData;
    let rt = initialRuntime();
    for (const s of ["VALIDATING", "QUERYING", "READY"] as const) rt = transition(rt, s, { data });
    rt = transition(rt, "ERROR", { error: { code: "QUERY_FAILED", message: "x" } });
    expect(rt.lastGood).toBe(data);
    expect(canTransition("DRAFT", "READY")).toBe(false);
    expect(() => transition(initialRuntime(), "READY")).toThrow();
  });
  it("min/max downsampling preserves spikes", () => {
    const pts: Array<[number, number]> = Array.from({ length: 100_000 }, (_, i) => [i, Math.sin(i / 50)]);
    pts[54_321] = [54_321, 1000];
    pts[77_777] = [77_777, -1000];
    const d = downsampleMinMax(pts, 1000);
    expect(d.method).toBe("min_max_bucket");
    expect(d.points.length).toBeLessThanOrEqual(4000);
    expect(d.points.some((p) => p[1] === 1000)).toBe(true);
    expect(d.points.some((p) => p[1] === -1000)).toBe(true);
  });
  it("builds a complete selection from data, not pixels", () => {
    const p = panel(1);
    const data: ChartData = {
      panelId: p.panelId,
      queryHash: p.queryRef.hash,
      dataRevision: 3,
      columns: [
        { name: "intents.day", unit: null },
        { name: "intents.swap_count", unit: "count" },
      ],
      rows: [
        ["2026-10-19T00:00:00.000Z", 5],
        ["2026-10-20T00:00:00.000Z", 6],
        ["2026-10-21T00:00:00.000Z", 7],
      ],
      downsampling: { method: "none", originalPoints: 3 },
      freshness: "fresh",
      sourceWatermark: "2026-11-09T00:00:00Z",
    };
    const s = buildSelection({
      panel: p,
      data,
      start: "2026-10-20T00:00:00Z",
      end: "2026-10-21T00:00:00Z",
      rendererVersion: "1.0.0",
    });
    expect(s.dataPointIds).toEqual([
      "intents.swap_count@2026-10-20T00:00:00.000Z",
      "intents.swap_count@2026-10-21T00:00:00.000Z",
    ]);
    expect(s.units).toEqual({ "intents.swap_count": "count" });
  });
});

describe("safe markdown", () => {
  it("never yields HTML or unsafe links", () => {
    const blocks = parseSafeMarkdown(
      "# T <script>x</script>\n\n[a](javascript:alert(1)) [b](https://near.org)‮",
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain("<script>x</script>"); // literal text, not markup
    expect(json).not.toContain('"href":"javascript');
    expect(json).toContain('"href":"https://near.org/"');
    expect(json).not.toContain("‮");
  });
});
