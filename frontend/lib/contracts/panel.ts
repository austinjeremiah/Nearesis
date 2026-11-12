import { z } from 'zod';
import { PanelStatus } from './enums';
import { QueryRef } from './query';

/**
 * Panel and canvas-patch contracts from Frontend Product Spec v1 sections 6.1,
 * 6.2 and 5.7.
 *
 * The rule the spec states three separate ways: an agent never emits React, SQL
 * or HTML. It emits one of these documents, the server validates it, and the
 * renderer draws it. Anything not expressible here cannot reach the screen.
 */

export const VizKind = z.enum([
  'line',
  'area',
  'bar',
  'scatter',
  'heatmap',
  'candlestick',
  'forecast',
  'distribution',
  'waterfall',
  'cohort',
  'table',
  'equation',
  'markdown',
  'evidence_graph',
  'agent_timeline',
]);
export type VizKind = z.infer<typeof VizKind>;

/**
 * How a gap in the series is drawn. `break` leaves the line open, `show_gap`
 * shades the interval. Neither interpolates. Spec 4.4: never auto-generate an
 * aesthetically pleasing curve across missing data.
 */
export const MissingnessPolicy = z.enum(['break', 'show_gap', 'not_applicable']);
export type MissingnessPolicy = z.infer<typeof MissingnessPolicy>;

/**
 * Channel bindings, e.g. { x: 'block_date', y: 'daily_volume' }. Values are
 * column ids from the result envelope and nothing else: the spec forbids raw
 * HTML, JavaScript, CSS URLs, SQL fragments, client-specified API hosts and
 * foreign query member names as rendering props, so this is a flat string map
 * rather than an open object.
 */
export const Encodings = z.record(z.string(), z.string());
export type Encodings = z.infer<typeof Encodings>;

export const VizSpec = z.object({
  kind: VizKind,
  title: z.string().min(1),
  encodings: Encodings,
  annotations: z.object({
    markerIds: z.array(z.string()),
    confidenceBand: z.boolean().optional(),
  }),
  missingnessPolicy: MissingnessPolicy,
  /**
   * Accessible text alternative. Spec 11 requires chart findings to be readable
   * without seeing the chart; it is generated then checked, never left blank.
   */
  description: z.string().min(1),
  /** Explicit scale choice. A log axis is never applied without saying so. */
  scale: z.enum(['linear', 'log']).default('linear'),
});
export type VizSpec = z.infer<typeof VizSpec>;

export const PanelLayout = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type PanelLayout = z.infer<typeof PanelLayout>;

export const PanelDocument = z.object({
  panelId: z.string().min(1),
  queryRef: QueryRef.optional(),
  viz: VizSpec,
  state: PanelStatus,
  /**
   * Spec 4.5: three revisions that must not collide. Layout edits bump
   * documentRevision, a refresh bumps dataRevision, evidence changes bump
   * evidenceRevision. Writes carry the expected value and a mismatch is a 409.
   */
  documentRevision: z.number().int().nonnegative(),
  dataRevision: z.number().int().nonnegative(),
  evidenceRevision: z.number().int().nonnegative().default(0),
  layout: PanelLayout,
  provenanceRef: z.string().min(1),
  /** Kept so STALE and REFRESHING can keep showing the last good data. */
  lastGoodResultId: z.string().optional(),
  /** Populated in ERROR. Rendered with Retry and Inspect, never as an empty box. */
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .optional(),
});
export type PanelDocument = z.infer<typeof PanelDocument>;

/**
 * 5.7 — an AI canvas edit is proposed as a patch, previewed as a diff, then
 * applied atomically. Panel ids are stable across the preview so the diff refers
 * to the same objects the commit will touch.
 */
export const CanvasPatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), panel: PanelDocument }),
  z.object({
    op: z.literal('update'),
    panelId: z.string().min(1),
    changes: PanelDocument.partial(),
  }),
  z.object({ op: z.literal('remove'), panelId: z.string().min(1) }),
]);
export type CanvasPatchOp = z.infer<typeof CanvasPatchOp>;

export const CanvasPatch = z.object({
  patchId: z.string().min(1),
  ops: z.array(CanvasPatchOp).min(1),
  /** Optimistic concurrency against the canvas document. */
  expectedRevision: z.number().int().nonnegative(),
  /** What the user typed, kept for the audit trail. */
  sourcePrompt: z.string().optional(),
  estimate: z.object({
    queryCount: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    /** Queries the planner expects to fail, surfaced before Apply. */
    atRiskPanelIds: z.array(z.string()),
  }),
});
export type CanvasPatch = z.infer<typeof CanvasPatch>;

/**
 * 5.7 — the result of applying a patch. Partial application is legal but must be
 * disclosed: a failed panel stays on the canvas in ERROR rather than being
 * dropped or filled with substitute numbers.
 */
export const CanvasPatchResult = z.object({
  patchId: z.string().min(1),
  applied: z.boolean(),
  revision: z.number().int().nonnegative(),
  failedPanels: z.array(
    z.object({ panelId: z.string(), code: z.string(), message: z.string() }),
  ),
});
export type CanvasPatchResult = z.infer<typeof CanvasPatchResult>;

/**
 * 5.7 — a drag selection on a chart. Ephemeral until the user explicitly creates
 * a marker: no agent is spawned by hover, click, zoom or selection alone.
 */
export const ChartSelection = z.object({
  panelId: z.string().min(1),
  seriesId: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  filterHash: z.string().min(1),
  workspaceVersion: z.number().int().nonnegative(),
});
export type ChartSelection = z.infer<typeof ChartSelection>;

/** A lens is a view-level filter applied across several panels at once. */
export const Lens = z.object({
  lensId: z.string().min(1),
  label: z.string().min(1),
  appliesToPanelIds: z.array(z.string()),
  filters: z.record(z.string(), z.string()),
});
export type Lens = z.infer<typeof Lens>;
