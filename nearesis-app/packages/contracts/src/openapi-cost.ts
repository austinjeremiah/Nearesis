import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.ts";

/**
 * Response shapes of the cost and budget API (final_master_prompt s18, s21). They mirror the TypeScript interfaces in
 * `packages/agent-runtime/src/cost/*` and are asserted against the real governor output in
 * `packages/agent-runtime/test/cost-global.test.ts`, so they cannot drift from the code.
 */
export const CostDimensionName = z.enum([
  "bigquery_bytes_billed",
  "external_requests",
  "ai_tokens",
  "outlayer_compute",
  "clickhouse_cpu",
  "clickhouse_io",
  "object_storage_gb_month",
  "network_egress_bytes",
  "workflow_operations",
]);

export const CostPolicyBody = z.strictObject({
  capUsd: z.number().min(0),
  periodDays: z.number().int().min(1).max(366).optional(),
  dimensionLimits: z.partialRecord(CostDimensionName, z.number().min(0)).optional(),
  rates: z.partialRecord(CostDimensionName, z.number().min(0)).optional(),
  paidOpsPermitted: z.array(z.string().min(1).max(100)).max(50).optional(),
  /** v1.7.0: dimensions refused with PRICE_UNKNOWN while no price is configured (model spend is always refused). */
  requirePriceFor: z.array(CostDimensionName).max(9).optional(),
  inflightAllowanceUsd: z.number().min(0).optional(),
  alertThresholds: z.array(z.number().gt(0).max(1)).max(10).optional(),
  alertMaxPerWindow: z.number().int().min(0).max(1000).optional(),
  alertWindowSeconds: z.number().int().min(1).max(604800).optional(),
  alertCooldownSeconds: z.number().int().min(0).max(86400).optional(),
});

export const CostPolicyRecord = z.looseObject({
  tenantId: Uuid,
  workspaceId: Uuid,
  capUsd: z.number(),
  periodStart: IsoDateTime,
  periodDays: z.number().int(),
  dimensionLimits: z.partialRecord(CostDimensionName, z.number()),
  rates: z.partialRecord(CostDimensionName, z.number()),
  paidOpsPermitted: z.array(z.string()),
  requirePriceFor: z.array(CostDimensionName),
  inflightAllowanceUsd: z.number(),
  alertThresholds: z.array(z.number()),
  alertMaxPerWindow: z.number().int(),
  alertWindowSeconds: z.number().int(),
  alertCooldownSeconds: z.number().int(),
  hardStoppedAt: IsoDateTime.nullable(),
  hardStopReason: z.string().nullable(),
});

export const CostForecast = z.strictObject({
  label: z.literal("projection"),
  method: z.literal("linear_to_period_end"),
  basis: z.strictObject({ elapsedHours: z.number(), spentUsd: z.number(), entries: z.number().int() }),
  projectedPeriodUsd: z.number().nullable(),
  projectedOverCap: z.boolean().nullable(),
  projectedExhaustionAt: IsoDateTime.nullable(),
  confidence: z.enum(["ok", "insufficient_data"]),
  assumptions: z.array(z.string()),
});

export const WorkspaceBurn = z.strictObject({
  tenantId: Uuid,
  workspaceId: Uuid,
  period: z.strictObject({ start: IsoDateTime, end: IsoDateTime }),
  policy: CostPolicyRecord.nullable(),
  spentUsd: z.number(),
  reservedUsd: z.number(),
  capUsd: z.number().nullable(),
  burnFraction: z.number().nullable(),
  burnRateUsdPerHour: z.strictObject({ last1h: z.number(), last24h: z.number() }),
  hardStopped: z.boolean(),
  hardStopReason: z.string().nullable(),
  dimensions: z.array(
    z.strictObject({
      dimension: CostDimensionName,
      unit: z.string(),
      /** null = never metered in the period (distinct from a metered 0). */
      quantity: z.number().nullable(),
      usd: z.number().nullable(),
      limit: z.number().nullable(),
      limitFraction: z.number().nullable(),
    }),
  ),
  forecast: CostForecast,
  blocks: z.strictObject({ total: z.number().int(), byReason: z.record(z.string(), z.number().int()) }),
  alerts: z.strictObject({ sent: z.number().int(), suppressed: z.number().int() }),
  priceUnknown: z.strictObject({
    entries: z.number().int(),
    byDimension: z.record(z.string(), z.number().int()),
  }),
  asOf: IsoDateTime,
});

export const LedgerExport = z.strictObject({
  entries: z.array(
    z.strictObject({
      key: z.string(),
      dimension: CostDimensionName,
      quantity: z.number(),
      /** null = the price was unknown; never 0. */
      usd: z.number().nullable(),
      priceUnknown: z.boolean(),
      state: z.enum(["reserved", "settled", "released"]),
      paidOp: z.string().nullable(),
      createdAt: IsoDateTime,
    }),
  ),
  blocks: z.array(
    z.strictObject({
      key: z.string().nullable(),
      dimension: z.string(),
      reason: z.enum([
        "CAP_REACHED",
        "DIMENSION_LIMIT",
        "PAID_OP_NOT_PERMITTED",
        "HARD_STOPPED",
        "PRICE_UNKNOWN",
        "GLOBAL_CEILING",
      ]),
      requestedUsd: z.number().nullable(),
      ledgerUsd: z.number(),
      createdAt: IsoDateTime,
    }),
  ),
});

export const GlobalSpendStatus = z.strictObject({
  scope: z.literal("global"),
  currency: z.literal("USD"),
  ceilingUsd: z.number(),
  hardMaxUsd: z.literal(5),
  settledUsd: z.number(),
  reservedUsd: z.number(),
  externalUsd: z.number(),
  committedUsd: z.number(),
  remainingUsd: z.number(),
  fraction: z.number(),
  state: z.enum(["ok", "warning", "exhausted"]),
  unknownPriceEntries: z.number().int(),
  thresholds: z.array(z.strictObject({ fraction: z.number(), usd: z.number(), reached: z.boolean() })),
  forecast: z.strictObject({
    label: z.literal("projection"),
    method: z.literal("trailing_24h_rate"),
    assumptions: z.array(z.string()),
    rate24hUsdPerHour: z.number(),
    projectedExhaustionAt: IsoDateTime.nullable(),
    projected30DayUsd: z.number().nullable(),
    confidence: z.enum(["ok", "insufficient_data"]),
  }),
  asOf: IsoDateTime,
});

const DimensionReconciliation = z.strictObject({
  dimension: CostDimensionName,
  reserved: z.strictObject({ entries: z.number().int(), usd: z.number() }),
  settled: z.strictObject({ entries: z.number().int(), usd: z.number() }),
  released: z.strictObject({ entries: z.number().int() }),
  priceUnknown: z.strictObject({ entries: z.number().int() }),
  estimateVsActual: z.strictObject({
    estimatedUsd: z.number(),
    actualUsd: z.number(),
    varianceUsd: z.number(),
    comparedEntries: z.number().int(),
  }),
});

export const WorkspaceReconciliation = z.strictObject({
  scope: z.literal("workspace"),
  tenantId: Uuid,
  workspaceId: Uuid,
  period: z.strictObject({ start: IsoDateTime, end: IsoDateTime }),
  dimensions: z.array(DimensionReconciliation),
  totals: z.strictObject({
    reservedOpenUsd: z.number(),
    settledUsd: z.number(),
    overrunUsd: z.number(),
    priceUnknownEntries: z.number().int(),
    blocks: z.number().int(),
  }),
  staleReservations: z.array(
    z.strictObject({
      key: z.string(),
      dimension: z.string(),
      usd: z.number().nullable(),
      ageHours: z.number(),
    }),
  ),
  priceUnknownEntries: z.array(
    z.strictObject({ key: z.string(), dimension: z.string(), state: z.string(), quantity: z.number() }),
  ),
  globalMirror: z
    .strictObject({
      checked: z.number().int(),
      mismatches: z.array(z.strictObject({ key: z.string(), issue: z.string() })),
    })
    .nullable(),
  discrepancies: z.array(z.string()),
  reconciled: z.boolean(),
  asOf: IsoDateTime,
});

export const GlobalReconciliation = z.strictObject({
  scope: z.literal("global"),
  status: GlobalSpendStatus,
  staleReservations: z.array(
    z.strictObject({ key: z.string(), usd: z.number().nullable(), ageHours: z.number() }),
  ),
  discrepancies: z.array(z.string()),
  reconciled: z.boolean(),
  asOf: IsoDateTime,
});
