import { z } from "zod";
import { Sha256Hex } from "./common.ts";

/**
 * v1.8.0 (additive): governed analytics capabilities for agents (final_master_prompt s4, s10, s11, s15).
 *
 *   intents.analyze@1   NEAR Intents status, refunds, refund causes, chain flows, concentration, unusual flows (A20)
 *   entities.analyze@1  ecosystem entity metrics, period changes, coverage, unique signers (A17, A23)
 *   accounts.analyze@1  daily active accounts, new vs returning, retention, concentration (A23)
 *
 * Typed inputs only (no SQL, no free text queries). Every result is an ANALYTICS_RESULT: computed from certified source
 * tables, NOT a certified semantic metric. A source that cannot answer returns the typed `CANNOT_COMPUTE` outcome, never a zero.
 */
export const ANALYTICS_CONTRACT_VERSION = "1.0.0";
export const ANALYTICS_LABEL = "ANALYTICS_RESULT" as const;
export const ANALYTICS_CERTIFICATION = "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC" as const;
/** Hard bounds shared by every analysis. */
export const ANALYTICS_LIMITS = {
  maxWindowDays: 366,
  maxTop: 200,
  maxRows: 2000,
  maxMissingDaysListed: 120,
} as const;

export const AnalyticsCapabilityId = z.enum([
  "intents.analyze@1",
  "entities.analyze@1",
  "accounts.analyze@1",
]);
export type AnalyticsCapabilityId = z.infer<typeof AnalyticsCapabilityId>;

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a calendar date");
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);
const Win = {
  /** First UTC day, inclusive. With `to` it fixes the window; otherwise the window ends at the newest complete day. */
  from: Day.optional(),
  to: Day.optional(),
  /** Window length in days ending at `to` (or the newest complete day). Default 30. */
  days: z.number().int().min(1).max(ANALYTICS_LIMITS.maxWindowDays).optional(),
};
const Top = z.number().int().min(1).max(ANALYTICS_LIMITS.maxTop).optional();
const ENTITY_TYPES = [
  "application",
  "protocol",
  "dao",
  "bridge",
  "token_contract",
  "intents_contract",
  "infrastructure",
  "category",
] as const;

export const IntentsAnalyzeInput = z.discriminatedUnion("analysis", [
  /** Swaps per Explorer status (SUCCESS, REFUNDED, FAILED, ...). grain "week" = Monday-start weeks folded from daily rows. */
  z.strictObject({
    analysis: z.literal("status"),
    ...Win,
    grain: z.enum(["none", "day", "week"]).optional(),
  }),
  /** Swaps, successes, refunds, refund rate and known USD volume per day, week or month. */
  z.strictObject({
    analysis: z.literal("trend"),
    ...Win,
    granularity: z.enum(["day", "week", "month"]).optional(),
    /** Which measures the chart plots; the table always carries all of them. Default `swaps`. */
    emphasis: z.enum(["swaps", "refunds", "refund_rate", "volume"]).optional(),
  }),
  z.strictObject({
    analysis: z.literal("refund_rates"),
    ...Win,
    by: z.enum(["chain_pair", "asset_pair"]).optional(),
    minTerminal: z.number().int().min(1).max(1_000_000).optional(),
    top: Top,
  }),
  z.strictObject({
    analysis: z.literal("refund_causes"),
    ...Win,
    by: z.enum(["reason", "week", "day", "chain_pair"]).optional(),
  }),
  z.strictObject({ analysis: z.literal("chain_flows"), ...Win, view: z.enum(["matrix", "net"]).optional() }),
  z.strictObject({
    analysis: z.literal("concentration"),
    ...Win,
    dimension: z
      .enum(["origin_asset", "destination_asset", "origin_chain", "destination_chain", "chain_pair"])
      .optional(),
    measure: z.enum(["volume", "count"]).optional(),
    top: Top,
  }),
  z.strictObject({
    analysis: z.literal("unusual_flows"),
    asOf: Day.optional(),
    baselineDays: z.number().int().min(14).max(120).optional(),
    recentDays: z.number().int().min(1).max(30).optional(),
  }),
  z.strictObject({
    analysis: z.literal("summary"),
    ...Win,
    era: z.enum(["public", "private_settlement"]).optional(),
  }),
  z.strictObject({
    analysis: z.literal("coverage"),
    ...Win,
    era: z.enum(["public", "private_settlement"]).optional(),
  }),
  /** What the Explorer does and does not identify per concept (static, no window): the answer to "which fields/metrics are unavailable". */
  z.strictObject({ analysis: z.literal("field_inventory") }),
  /** Always CANNOT_COMPUTE (no settled_at in the source); carries a labelled indicative alternative when one exists. */
  z.strictObject({ analysis: z.literal("settlement_duration"), ...Win }),
  /** Always CANNOT_COMPUTE (the Explorer carries no solver identity). */
  z.strictObject({ analysis: z.literal("solver_metrics"), ...Win }),
]);
export type IntentsAnalyzeInput = z.infer<typeof IntentsAnalyzeInput>;

export const EntitiesAnalyzeInput = z.discriminatedUnion("analysis", [
  /** Ranked period-over-period contract interactions per entity (+ unique signer change when the per-signer scan is loaded). */
  z.strictObject({
    analysis: z.literal("changes"),
    days: z.number().int().min(1).max(180).optional(),
    to: Day.optional(),
    limit: Top,
    type: z.enum(ENTITY_TYPES).optional(),
  }),
  z.strictObject({ analysis: z.literal("metrics"), entityId: Id, from: Day, to: Day }),
  z.strictObject({ analysis: z.literal("coverage"), ...Win }),
  z.strictObject({ analysis: z.literal("unique_signers"), entityId: Id, ...Win }),
  z.strictObject({
    analysis: z.literal("search"),
    q: z.string().min(1).max(100).optional(),
    type: z.enum(ENTITY_TYPES).optional(),
    limit: Top,
  }),
]);
export type EntitiesAnalyzeInput = z.infer<typeof EntitiesAnalyzeInput>;

export const AccountsAnalyzeInput = z.discriminatedUnion("analysis", [
  /** Daily active accounts with new vs returning (new = first organic transaction seen since the scan window start). */
  z.strictObject({ analysis: z.literal("daily"), ...Win }),
  z.strictObject({
    analysis: z.literal("growth"),
    days: z.number().int().min(1).max(180).optional(),
    to: Day.optional(),
  }),
  z.strictObject({ analysis: z.literal("retention") }),
  z.strictObject({ analysis: z.literal("concentration"), ...Win }),
  z.strictObject({ analysis: z.literal("coverage") }),
]);
export type AccountsAnalyzeInput = z.infer<typeof AccountsAnalyzeInput>;

export const INTENTS_ANALYSES = IntentsAnalyzeInput.options.map((o) => o.shape.analysis.value);
export const ENTITIES_ANALYSES = EntitiesAnalyzeInput.options.map((o) => o.shape.analysis.value);
export const ACCOUNTS_ANALYSES = AccountsAnalyzeInput.options.map((o) => o.shape.analysis.value);
export const ANALYSES_BY_CAPABILITY: Record<AnalyticsCapabilityId, readonly string[]> = {
  "intents.analyze@1": INTENTS_ANALYSES,
  "entities.analyze@1": ENTITIES_ANALYSES,
  "accounts.analyze@1": ACCOUNTS_ANALYSES,
};
export const INPUT_BY_CAPABILITY = {
  "intents.analyze@1": IntentsAnalyzeInput,
  "entities.analyze@1": EntitiesAnalyzeInput,
  "accounts.analyze@1": AccountsAnalyzeInput,
} as const;

/** The call as executed: relative windows resolved to absolute UTC days, so its hash names exactly one computation. */
export const AnalyticsCall = z.strictObject({
  capability: AnalyticsCapabilityId,
  input: z.record(z.string(), z.unknown()),
});
export type AnalyticsCall = z.infer<typeof AnalyticsCall>;

const FieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/);
export const AnalyticsColumn = z.strictObject({
  name: FieldName,
  type: z.enum(["time", "category", "number"]),
  unit: z.string().max(40).nullable(),
});
export const AnalyticsTable = z.strictObject({
  columns: z.array(AnalyticsColumn).min(1).max(32),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(ANALYTICS_LIMITS.maxRows),
  totalRows: z.number().int().nonnegative(),
  /** True when more rows existed than `maxRows`; the panel must say so. */
  truncated: z.boolean(),
});
export const AnalyticsChartHint = z.strictObject({
  kind: z.enum(["line", "bar", "stacked_bar", "heatmap", "table", "cohort"]),
  x: FieldName.optional(),
  y: z.array(FieldName).max(8),
  series: FieldName.optional(),
});
export const AnalyticsCoverage = z.strictObject({
  /** complete = every requested day is complete in source coverage; partial = some are incomplete or missing; unavailable = none usable. */
  state: z.enum(["complete", "partial", "unavailable"]),
  daysRequested: z.number().int().nonnegative().nullable(),
  daysWithData: z.number().int().nonnegative().nullable(),
  /** Days with no coverage record at all: unknown, never zero. Capped at `maxMissingDaysListed`. */
  missingDays: z.array(z.string()).max(ANALYTICS_LIMITS.maxMissingDaysListed),
  incompleteDays: z.array(z.string()).max(ANALYTICS_LIMITS.maxMissingDaysListed),
  note: z.string().max(1000).nullable(),
});
export const AnalyticsProvenance = z.strictObject({
  source: z.string().max(200),
  tables: z.array(z.string().max(80)).max(12),
  asOf: z.string().nullable(),
  computedAt: z.string(),
  metricVersion: z.string().max(40),
  method: z.string().max(600),
});

const Common = {
  capability: AnalyticsCapabilityId,
  analysis: z.string().max(40),
  /** Always "ANALYTICS_RESULT": computed from certified source tables, never presented as a certified semantic metric. */
  label: z.literal(ANALYTICS_LABEL),
  certification: z.literal(ANALYTICS_CERTIFICATION),
  /** sha256 of the canonical executed call: panels reference it as their query hash and re-execute it. */
  callHash: Sha256Hex,
  call: AnalyticsCall,
  metric: z.string().max(120),
  definition: z.string().max(1200),
  window: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
  provenance: AnalyticsProvenance,
  coverage: AnalyticsCoverage,
  caveats: z.array(z.string().max(600)).max(20),
};
export const AnalyticsOk = z.strictObject({
  outcome: z.literal("OK"),
  ...Common,
  table: AnalyticsTable,
  chart: AnalyticsChartHint,
  /** Typed scalar facts that do not fit the table (totals, HHI, scan window, method parameters). */
  summary: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
});
export const AnalyticsCannotCompute = z.strictObject({
  outcome: z.literal("CANNOT_COMPUTE"),
  ...Common,
  /** Fields, linkages or sources that are absent. */
  missing: z.array(z.string().max(300)).max(20),
  explanation: z.string().max(2000),
  evidence: z.array(z.string().max(300)).max(10),
  /** A clearly labelled substitute that IS computable; it is not the requested metric. */
  alternative: z
    .strictObject({
      metric: z.string().max(120),
      label: z.string().max(300),
      table: AnalyticsTable.nullable(),
    })
    .optional(),
});
export const AnalyticsOutcome = z.discriminatedUnion("outcome", [AnalyticsOk, AnalyticsCannotCompute]);
export type AnalyticsOutcome = z.infer<typeof AnalyticsOutcome>;
export type AnalyticsOkResult = z.infer<typeof AnalyticsOk>;
export type AnalyticsTable = z.infer<typeof AnalyticsTable>;

/** Binding stored on a PanelSpec whose data is an analytics result (additive, v1.8.0). */
export const AnalyticsPanelBinding = z.strictObject({
  capability: AnalyticsCapabilityId,
  analysis: z.string().max(40),
  label: z.literal(ANALYTICS_LABEL),
  certification: z.literal(ANALYTICS_CERTIFICATION),
  sourceTables: z.array(z.string().max(80)).max(12),
  metricVersion: z.string().max(40),
  coverageState: z.enum(["complete", "partial", "unavailable"]),
});
export type AnalyticsPanelBinding = z.infer<typeof AnalyticsPanelBinding>;

/** Panel data for an analytics panel: what `GET /v1/analytics/panel/:hash` returns (mirrors the semantic panel data shape). */
export const AnalyticsPanelData = z.strictObject({
  chart: z.strictObject({
    queryHash: Sha256Hex,
    dataRevision: z.number().int().nonnegative(),
    columns: z.array(z.strictObject({ name: FieldName, unit: z.string().nullable() })),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(ANALYTICS_LIMITS.maxRows),
    downsampling: z.strictObject({
      method: z.literal("none"),
      originalPoints: z.number().int().nonnegative(),
    }),
    freshness: z.enum(["fresh", "late", "partial", "unavailable"]),
    sourceWatermark: z.string().nullable(),
  }),
  shape: z.strictObject({
    queryHash: Sha256Hex,
    fields: z.array(
      z.strictObject({
        name: FieldName,
        unit: z.string().nullable(),
        role: z.enum(["time", "measure", "dimension"]),
      }),
    ),
  }),
  provenance: z.strictObject({
    queryHash: Sha256Hex,
    sourceLabel: z.literal("ANALYTICS"),
    certification: z.literal(ANALYTICS_CERTIFICATION),
    capability: AnalyticsCapabilityId,
    analysis: z.string(),
    call: AnalyticsCall,
    resultHash: Sha256Hex,
    sources: z.array(z.string()),
    metricVersion: z.string(),
    definition: z.string(),
    method: z.string(),
    asOf: z.string().nullable(),
    computedAt: z.string(),
    coverage: AnalyticsCoverage,
    caveats: z.array(z.string()),
  }),
  /** Typed non-answer when the stored call can no longer be computed; the panel shows it instead of a chart. */
  cannotCompute: z.strictObject({ missing: z.array(z.string()), explanation: z.string() }).nullable(),
  truncated: z.boolean(),
});
export type AnalyticsPanelData = z.infer<typeof AnalyticsPanelData>;
