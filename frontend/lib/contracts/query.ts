import { z } from 'zod';
import {
  DataMode,
  DatasetOrigin,
  MeasureValue,
  ReasonCode,
  SourceMaturity,
} from './enums';

/**
 * Source, query and result envelopes from Frontend Product Spec v1 section 6.2,
 * with the detail fields section 4.2 requires wherever a number is displayed.
 *
 * The invariant these encode: a result cannot reach a chart without carrying the
 * provenance needed to explain it. Every field here is rendered somewhere, so
 * dropping one in the backend removes something a reviewer is entitled to see.
 */

/** ISO-8601 UTC instant. Stored and transported as a string, never a Date. */
const Instant = z.string().datetime({ offset: true });

/** Lowercase hex digest. Used for raw manifests, queries and results. */
const Digest = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha-256 hex digest');

export const Coverage = z.object({
  /** Observations the window should contain if the source were complete. */
  expected: z.number().int().nonnegative(),
  /** Observations actually present. */
  observed: z.number().int().nonnegative(),
  /** Present but with an unresolvable value. Not the same as absent. */
  unknown: z.number().int().nonnegative(),
  /** Human-readable gap descriptors, e.g. "2026-10-27/2026-10-29". */
  gaps: z.array(z.string()),
});
export type Coverage = z.infer<typeof Coverage>;

export const SourceMetadata = z.object({
  sourceId: z.string().min(1),
  snapshotId: z.string().min(1),
  rawManifestHash: Digest,
  /** Latest finalized sample. Null when the source has never reported one. */
  sourceWatermark: Instant.nullable(),
  retrievedAt: Instant,
  maturity: SourceMaturity,
  datasetOrigin: DatasetOrigin,
  dataMode: DataMode,
  coverage: Coverage,
  /**
   * Spec 4.3: limits a reader must know to interpret the number, such as
   * settlement that stopped being publicly reconstructable after 2026-10-27.
   * Rendered in the panel, not buried in a tooltip.
   */
  visibilityNotes: z.array(z.string()),
  /** Spec 4.2: last failed refresh is shown alongside the last successful one. */
  lastSuccessfulRefresh: Instant.nullable(),
  lastFailedRefresh: z
    .object({ at: Instant, reason: z.string(), code: z.string() })
    .nullable(),
});
export type SourceMetadata = z.infer<typeof SourceMetadata>;

export const QueryRef = z.object({
  canonicalQueryHash: Digest,
  /** Semantic model version the measures were resolved against. */
  semanticVersion: z.string().min(1),
  snapshotId: z.string().min(1),
  metricIds: z.array(z.string().min(1)).min(1),
  /** Grain the result is aggregated to, e.g. "day". Drives axis labelling. */
  grain: z.enum(['hour', 'day', 'week', 'month']).optional(),
  /** Always UTC in transport; the UI converts and says so. */
  timezone: z.literal('UTC').default('UTC'),
});
export type QueryRef = z.infer<typeof QueryRef>;

export const DataColumn = z.object({
  id: z.string().min(1),
  role: z.enum(['time', 'dimension', 'measure', 'lower', 'upper']),
  unit: z.string(),
  nullable: z.boolean(),
  precision: z.number().int().nonnegative().optional(),
  /**
   * Spec 4.3: distinct_signer_proxy is not a count of humans. A column that
   * approximates something carries the caveat with it so chart titles and
   * tooltips can render it without each screen remembering to.
   */
  proxyCaveat: z.string().optional(),
});
export type DataColumn = z.infer<typeof DataColumn>;

/** One row. Keys are DataColumn ids; measures may be null for "unavailable". */
export const DataRow = z.record(z.string(), z.union([z.string(), MeasureValue]));
export type DataRow = z.infer<typeof DataRow>;

export const QueryResultEnvelope = z.object({
  resultId: z.string().min(1),
  query: QueryRef,
  source: SourceMetadata,
  columns: z.array(DataColumn).min(1),
  /**
   * Server-authorized paginated reference, not the rows themselves. Large series
   * are fetched through this so the client never holds an unbounded payload and
   * cannot leak rows the principal is not entitled to.
   */
  rowsRef: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  resultHash: Digest,
  /** Non-empty means the result is incomplete and the panel must say why. */
  partialReasonCodes: z.array(ReasonCode),
});
export type QueryResultEnvelope = z.infer<typeof QueryResultEnvelope>;

/** A bounded page of rows resolved from `rowsRef`. */
export const QueryResultPage = z.object({
  resultId: z.string().min(1),
  rows: z.array(DataRow),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  /**
   * Set when the server reduced the series to fit a viewport. Spec 5.7 requires
   * the method to be disclosed rather than silently applied.
   */
  downsample: z
    .object({
      method: z.enum(['lttb', 'min_max', 'mean', 'none']),
      originalRowCount: z.number().int().nonnegative(),
    })
    .optional(),
});
export type QueryResultPage = z.infer<typeof QueryResultPage>;
