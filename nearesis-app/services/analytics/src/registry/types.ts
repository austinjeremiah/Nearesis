import { z } from "zod";
import { MetricMetadata, Visibility } from "@nearesis/contracts";

/** Machine-evaluable definition used by the dataset-backed diff (S12). Column names are allowlisted; values are bound parameters. */
export const Evaluator = z.strictObject({
  table: z.enum([
    "near_daily_usage",
    "near_signer_days",
    "contract_interactions",
    "intents_swaps",
    "quote_attempts",
    "price_candles",
    "economics_reports",
    "agent_market_jobs",
  ]),
  dayColumn: z.string().regex(/^[a-z_]+$/),
  agg: z.enum(["sum", "count", "avg", "uniqExact"]),
  column: z
    .string()
    .regex(/^[a-z_]+$/)
    .nullable(),
  filters: z.array(
    z.strictObject({
      column: z.string().regex(/^[a-z_]+$/),
      op: z.enum(["eq", "neq", "gte", "lte", "gt", "lt"]),
      value: z.union([z.string(), z.number()]),
    }),
  ),
});
export type Evaluator = z.infer<typeof Evaluator>;

export const RegistryDimension = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  view: z.string(),
  displayName: z.string(),
  kind: z.enum(["dimension", "time"]),
  visibility: Visibility,
});
export type RegistryDimension = z.infer<typeof RegistryDimension>;

export const Registry = z.strictObject({
  semanticVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  metrics: z.array(MetricMetadata),
  dimensions: z.array(RegistryDimension),
  evaluators: z.record(z.string(), Evaluator.nullable()),
});
export type Registry = z.infer<typeof Registry>;

/** Optional consumers (panels / claims) per metric, for the diff report. */
export interface DependentsFile {
  panels: Record<string, string[]>;
  claims: Record<string, string[]>;
}
