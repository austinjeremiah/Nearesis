import type { CanvasDocument, PanelSpec } from "@nearesis/contracts";
import type { QueryResultShape } from "../../src/index.ts";

export const SHA = (c: string) => c.repeat(64).slice(0, 64);
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const NOW = "2026-11-10T12:00:00.000Z";

export const RESULT_SWAPS: QueryResultShape = {
  queryHash: SHA("a"),
  grain: "day",
  fields: [
    { name: "intents.day", unit: null, role: "time", timeSemantics: "event_time" },
    { name: "intents.swap_count", unit: "count", role: "measure", metricId: "intents.swap_count" },
    { name: "intents.volume_usd", unit: "usd", role: "measure", metricId: "intents.volume_usd" },
    { name: "intents.chain", unit: null, role: "dimension" },
  ],
};

export function panel(n: number, over: Partial<PanelSpec> = {}): PanelSpec {
  return {
    panelId: uuid(n),
    schemaVersion: 1,
    kind: "timeSeries",
    title: `Panel ${n}`,
    queryRef: { hash: SHA("a"), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: {
      fields: ["intents.day", "intents.swap_count"],
      units: { "intents.swap_count": "count" },
      timezone: "UTC",
      completeness: "complete",
    },
    encoding: { x: "intents.day", y: ["intents.swap_count"], interpolateGaps: false },
    layout: { x: 0, y: n * 4, w: 6, h: 4 },
    refreshPolicy: { mode: "on_watermark" },
    provenanceRequired: true,
    ...over,
  };
}

export function emptyDoc(): CanvasDocument {
  return {
    id: uuid(9001),
    workspaceId: uuid(9002),
    branchId: uuid(9003),
    documentRevision: 0,
    dataRevision: 0,
    viewport: { zoom: 1, x: 0, y: 0 },
    layoutMode: "grid",
    panels: [],
    markers: [],
    activeSelections: [],
    updatedAt: NOW,
  };
}
