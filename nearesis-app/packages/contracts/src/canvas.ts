import { z } from "zod";
import { IsoDateTime, Sha256Hex, SemVer, Uuid } from "./common.ts";
import { FreshnessWarning, ResultTruncation } from "./overload.ts";
import { AnalyticsPanelBinding } from "./analytics-capabilities.ts";

/** Registered panel kinds (Bible schemas/canvas_panel.schema.json). Unknown kinds are rejected (C09). */
export const PanelKind = z.enum([
  "timeSeries",
  "candlestick",
  "bar",
  "scatter",
  "heatmap",
  "cohort",
  "evidenceGraph",
  "table",
  "note",
  "waterfall",
]);
export type PanelKind = z.infer<typeof PanelKind>;

const SafeText = (max: number) => z.string().max(max);
const FieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/);

export const GridLayout = z.strictObject({
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(10000),
  w: z.number().int().min(1).max(48),
  h: z.number().int().min(1).max(200),
});
export type GridLayout = z.infer<typeof GridLayout>;

/**
 * PanelSpec (ch.09 + Bible schema). Declarative only: no functions, no HTML, no formatter strings (C02/C10).
 */
export const PanelSpec = z
  .strictObject({
    panelId: Uuid,
    schemaVersion: z.literal(1),
    kind: PanelKind,
    title: SafeText(180),
    queryRef: z.strictObject({
      hash: Sha256Hex,
      semanticVersion: SemVer,
      snapshotPolicy: z.enum(["live", "pinned"]).default("live"),
      /** v1.8.0 (additive): what the hash names. Absent = a semantic query (certified or authored metrics); `analytics_result` = an analytics capability call. */
      resultKind: z.enum(["semantic_query", "analytics_result"]).optional(),
    }),
    dataBinding: z.strictObject({
      fields: z.array(FieldName).min(1).max(32),
      units: z.record(FieldName, z.string().max(40)),
      timezone: z.literal("UTC"),
      completeness: z.enum(["complete", "partial", "unavailable"]),
    }),
    encoding: z.strictObject({
      x: FieldName.optional(),
      y: z.array(FieldName).max(8).optional(),
      series: FieldName.optional(),
      tooltip: z.array(FieldName).max(16).optional(),
      scale: z.enum(["linear", "log", "index_100"]).optional(),
      aggregation: z.enum(["none", "sum", "avg", "min", "max"]).optional(),
      interpolateGaps: z.boolean().default(false),
    }),
    layout: GridLayout,
    refreshPolicy: z.strictObject({ mode: z.enum(["on_watermark", "manual", "pinned"]) }),
    provenanceRequired: z.literal(true),
    note: SafeText(20000).optional(),
    /** v1.8.0 (additive): present exactly when queryRef.resultKind is `analytics_result`. Such a panel is labelled ANALYTICS_RESULT, never "certified metric". */
    analytics: AnalyticsPanelBinding.optional(),
  })
  .refine((p) => (p.queryRef.resultKind === "analytics_result") === (p.analytics !== undefined), {
    message: "analytics binding is required for, and only valid on, analytics_result panels",
    path: ["analytics"],
  });
export type PanelSpec = z.infer<typeof PanelSpec>;

export const MarkerAnchor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time_point"), at: IsoDateTime }),
  z.strictObject({ kind: z.literal("time_range"), start: IsoDateTime, end: IsoDateTime }),
  z.strictObject({
    kind: z.literal("threshold"),
    metricId: z.string(),
    op: z.enum(["gt", "lt"]),
    value: z.number(),
  }),
  /** v1.5.0 (additive): anchored to a discrete source event (e.g. a swap, a watermark update, a quote failure). */
  z.strictObject({
    kind: z.literal("source_event"),
    sourceId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    at: IsoDateTime,
  }),
]);
export const MarkerSpec = z.strictObject({
  markerId: Uuid,
  panelId: Uuid,
  anchor: MarkerAnchor,
  status: z.enum([
    "DRAFT",
    "ACTIVE",
    "INVESTIGATING",
    "REVIEW_REQUIRED",
    "RESOLVED",
    "MONITORING",
    "DISMISSED",
  ]),
  question: SafeText(4000).optional(),
  createdBy: Uuid,
  createdAt: IsoDateTime,
});
export type MarkerSpec = z.infer<typeof MarkerSpec>;

/** C13 selection context. */
export const Selection = z.strictObject({
  panelId: Uuid,
  queryHash: Sha256Hex,
  semanticVersion: SemVer,
  interval: z.strictObject({ start: IsoDateTime, end: IsoDateTime }),
  seriesIds: z.array(z.string()).max(32),
  dataPointIds: z.array(z.string()).max(10000),
  units: z.record(z.string(), z.string()),
  sourceWatermark: IsoDateTime.nullable(),
  rendererVersion: z.string(),
});
export type Selection = z.infer<typeof Selection>;

export const CanvasDocument = z.strictObject({
  id: Uuid,
  workspaceId: Uuid,
  branchId: Uuid,
  documentRevision: z.number().int().nonnegative(),
  dataRevision: z.number().int().nonnegative(),
  viewport: z.strictObject({ zoom: z.number().positive(), x: z.number(), y: z.number() }),
  layoutMode: z.enum(["grid", "freeform"]),
  panels: z.array(PanelSpec).max(200),
  markers: z.array(MarkerSpec).max(2000),
  activeSelections: z.array(Selection).max(50),
  updatedAt: IsoDateTime,
});
export type CanvasDocument = z.infer<typeof CanvasDocument>;

export const PatchOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("addPanel"), panel: PanelSpec }),
  z.strictObject({ op: z.literal("updatePanel"), panelId: Uuid, panel: PanelSpec }),
  z.strictObject({ op: z.literal("movePanel"), panelId: Uuid, layout: GridLayout }),
  z.strictObject({ op: z.literal("removePanel"), panelId: Uuid }),
  z.strictObject({ op: z.literal("addMarker"), marker: MarkerSpec }),
  z.strictObject({ op: z.literal("setSelection"), selection: Selection }),
  z.strictObject({ op: z.literal("removeMarker"), markerId: Uuid }),
  z.strictObject({ op: z.literal("clearSelection"), panelId: Uuid }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

/** ch.26 deterministic patch: operationId + expectedRevision; applied atomically (C11). */
export const CanvasPatch = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("workspace.patch"),
  operationId: Uuid,
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(PatchOp).min(1).max(50),
});
export type CanvasPatch = z.infer<typeof CanvasPatch>;

/** Chart data handed to the renderer: bounded, typed, never executable. */
export const ChartData = z.strictObject({
  panelId: Uuid,
  queryHash: Sha256Hex,
  dataRevision: z.number().int().nonnegative(),
  columns: z.array(z.strictObject({ name: FieldName, unit: z.string().nullable() })),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(200000),
  downsampling: z.strictObject({
    method: z.enum(["none", "min_max_bucket", "lttb"]),
    originalPoints: z.number().int().nonnegative(),
  }),
  freshness: z.enum(["fresh", "late", "partial", "unavailable"]),
  sourceWatermark: IsoDateTime.nullable(),
  /** v1.6.0 (additive): present only when the max-rows rule truncated or downsampled this data (label it in the UI). */
  truncation: ResultTruncation.optional(),
  /** v1.6.0 (additive): present while the source is degraded and this is the last finalized snapshot. */
  freshnessWarning: FreshnessWarning.optional(),
});
export type ChartData = z.infer<typeof ChartData>;
export type MarkerAnchor = z.infer<typeof MarkerAnchor>;
