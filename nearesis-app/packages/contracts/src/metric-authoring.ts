import { z } from "zod";
import { IsoDateTime, Sha256Hex } from "./common.ts";

/**
 * v1.7.0 (additive): governed metric authoring (final_master_prompt section 4, ch.06).
 *
 * A MetricProposal is a constrained, typed semantic representation. It carries NO SQL: every table and column is a
 * reference into the generated source catalogue, every aggregation is an enum, and the only computed expression is a
 * small typed arithmetic tree over declared aggregations. Unknown keys are refused (strict objects).
 */

const Ident = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const MetricColumnRef = z.strictObject({ table: Ident, column: Ident });
export type MetricColumnRef = z.infer<typeof MetricColumnRef>;

export const MetricFilterValue = z.union([z.string().min(1).max(200), z.number().finite()]);

export const MetricFilter = z.strictObject({
  column: MetricColumnRef,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"]),
  values: z.array(MetricFilterValue).max(50),
});
export type MetricFilter = z.infer<typeof MetricFilter>;

export const MetricAggFn = z.enum(["sum", "count", "count_distinct", "avg", "min", "max"]);
export type MetricAggFn = z.infer<typeof MetricAggFn>;

export const MetricAggregation = z.strictObject({
  id: Ident,
  fn: MetricAggFn,
  /** null only for `count` (row count). */
  column: MetricColumnRef.nullable(),
  /** The table whose rows `count` counts; required for `count`, forbidden otherwise. */
  table: Ident.optional(),
});
export type MetricAggregation = z.infer<typeof MetricAggregation>;

export type MetricExpr =
  | { kind: "agg"; id: string }
  | { kind: "const"; value: number; unit?: string | undefined }
  | { kind: "op"; op: "add" | "sub" | "mul" | "div"; left: MetricExpr; right: MetricExpr };
export const MetricExpr: z.ZodType<MetricExpr> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("agg"), id: Ident }),
    z.strictObject({
      kind: z.literal("const"),
      value: z.number().finite(),
      unit: z.string().max(50).optional(),
    }),
    z.strictObject({
      kind: z.literal("op"),
      op: z.enum(["add", "sub", "mul", "div"]),
      left: MetricExpr,
      right: MetricExpr,
    }),
  ]),
);

export const MetricTest = z.discriminatedUnion("kind", [
  /** Compiled result must equal an independent raw recomputation over the same window (always run, declared or not). */
  z.strictObject({ kind: z.literal("reconcile_raw"), name: z.string().min(1).max(100) }),
  z.strictObject({
    kind: z.literal("expected_value"),
    name: z.string().min(1).max(100),
    bucket: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** exact decimal string */
    value: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    tolerance: z.string().regex(/^\d+(?:\.\d+)?$/),
  }),
  z.strictObject({ kind: z.literal("non_negative"), name: z.string().min(1).max(100) }),
  z.strictObject({
    kind: z.literal("min_rows"),
    name: z.string().min(1).max(100),
    rows: z.number().int().positive().max(100000),
  }),
]);
export type MetricTest = z.infer<typeof MetricTest>;

export const MetricAuthor = z.strictObject({
  principalId: z.string().min(1).max(100),
  kind: z.enum(["human", "agent", "service"]),
  tenantId: z.string().min(1).max(100),
});
export type MetricAuthor = z.infer<typeof MetricAuthor>;

export const MetricProposal = z.strictObject({
  schemaVersion: z.literal(1),
  /** `namespace.name` is the metric key. The `live`, `fixture`, and `certified` namespaces belong to the static registry. */
  namespace: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  name: Ident,
  displayName: z.string().min(1).max(120),
  description: z.string().min(10).max(2000),
  /** Source tables (catalogue ids). Every table used anywhere in the proposal must be listed. */
  sources: z.array(Ident).min(1).max(4),
  /** Joins only along declared keys of the catalogue. */
  joins: z.array(z.strictObject({ left: MetricColumnRef, right: MetricColumnRef })).max(3),
  entityGrain: z.strictObject({
    kind: z.enum(["global", "column"]),
    column: MetricColumnRef.optional(),
  }),
  timeGrain: z.strictObject({ column: MetricColumnRef, grain: z.enum(["day", "week", "month"]) }),
  dimensions: z.array(MetricColumnRef).max(4),
  filters: z.array(MetricFilter).max(12),
  aggregations: z.array(MetricAggregation).min(1).max(8),
  /** Defaults to the single aggregation when there is exactly one. */
  formula: MetricExpr.optional(),
  /** The declared output unit; the compiler derives the unit from the catalogue and refuses a mismatch. */
  unit: z.string().min(1).max(50),
  precision: z.strictObject({
    decimals: z.number().int().min(0).max(18),
    rounding: z.enum(["half_even", "truncate"]),
  }),
  nullSemantics: z.strictObject({
    /** How NULL inputs are treated. `ignore` is the SQL aggregate default; `propagate` makes a bucket NULL if any input is NULL. */
    nullInput: z.enum(["ignore", "propagate"]),
    /** A bucket with no source rows or with unavailable coverage is NULL, never zero, unless coverage is complete. */
    emptyBucket: z.enum(["null", "zero_when_coverage_complete"]),
  }),
  dedup: z.strictObject({ strategy: z.enum(["final", "none_declared_unique"]) }),
  historicalValidity: z.strictObject({
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    restatement: z.enum(["immutable", "may_restate"]),
  }),
  /** Budget the author accepts. The estimate itself is computed by the system and reported in the validation report. */
  costEstimate: z.strictObject({ maxEstimatedRows: z.number().int().positive().max(50_000_000) }),
  /** Certified metrics this one depends on (`namespace.name@version`). */
  dependencies: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@\d+$/)).max(10),
  tests: z.array(MetricTest).max(20),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
  /** Proposal revision the author intends (1 for a new metric); the store assigns the final immutable version. */
  version: z.number().int().positive().max(1000),
  author: MetricAuthor,
});
export type MetricProposal = z.infer<typeof MetricProposal>;

export const MetricStatus = z.enum(["DRAFT", "VALIDATED", "CERTIFIED", "DEPRECATED"]);
export type MetricStatus = z.infer<typeof MetricStatus>;

export const MetricAuthoringReason = z.enum([
  "UNKNOWN_FIELD",
  "INVALID_PROPOSAL",
  "UNKNOWN_SOURCE",
  "UNKNOWN_COLUMN",
  "COLUMN_NOT_ALLOWED",
  "CROSS_TENANT_SOURCE",
  "RAW_SQL_REFUSED",
  "JOIN_NOT_DECLARED",
  "UNUSED_SOURCE",
  "UNIT_MISMATCH",
  "UNIT_UNKNOWN",
  "AGGREGATION_INVALID",
  "DEDUP_REQUIRED",
  "TIME_COLUMN_INVALID",
  "DIMENSIONS_UNSUPPORTED",
  "DEPENDENCY_NOT_CERTIFIED",
  "COST_CAP",
  "COVERAGE_UNKNOWN",
  "EXECUTION_FAILED",
  "RECONCILIATION_FAILED",
  "TEST_FAILED",
  "NAMESPACE_RESERVED",
  "NOT_FOUND",
  "ILLEGAL_TRANSITION",
  "CERTIFIER_REQUIRED",
  "HUMAN_PRINCIPAL_REQUIRED",
  "SELF_CERTIFICATION_REFUSED",
  "NOT_VALIDATED",
  "STALE_VALIDATION",
  "IMMUTABLE_VERSION",
  "METRIC_NOT_CERTIFIED",
  "EXPLORATION_NOT_PERMITTED",
  "FORBIDDEN",
  "CONFLICT",
]);
export type MetricAuthoringReason = z.infer<typeof MetricAuthoringReason>;

export const MetricIssue = z.strictObject({
  reason: MetricAuthoringReason,
  path: z.string(),
  message: z.string(),
});
export type MetricIssue = z.infer<typeof MetricIssue>;

export const MetricCheck = z.strictObject({
  name: z.string(),
  verdict: z.enum(["pass", "fail", "skipped"]),
  detail: z.string(),
});
export type MetricCheck = z.infer<typeof MetricCheck>;

export const MetricValidationReport = z.strictObject({
  ok: z.boolean(),
  proposalHash: Sha256Hex,
  /** schema, allowlist, units, dedup, joins, dependencies, cost, bounded execution, reconciliation, declared tests */
  checks: z.array(MetricCheck),
  issues: z.array(MetricIssue),
  derivedUnit: z.string().nullable(),
  cost: z
    .strictObject({
      estimatedRows: z.number().nonnegative(),
      maxEstimatedRows: z.number().nonnegative(),
      method: z.literal("coverage_rate_x_days"),
      windowDays: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Fingerprint of the compiled plan (catalogue-checked identifiers, filters, grain and formula). */
  planFingerprint: Sha256Hex.nullable(),
  sampleWindow: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
  validatedAt: IsoDateTime,
});
export type MetricValidationReport = z.infer<typeof MetricValidationReport>;

export const MetricRecord = z.strictObject({
  metricKey: z.string(),
  version: z.number().int().positive(),
  status: MetricStatus,
  proposal: MetricProposal,
  proposalHash: Sha256Hex,
  tenantId: z.string(),
  workspaceId: z.string(),
  validation: MetricValidationReport.nullable(),
  authorId: z.string(),
  certifiedBy: z.string().nullable(),
  certifiedAt: IsoDateTime.nullable(),
  deprecatedBy: z.string().nullable(),
  deprecatedAt: IsoDateTime.nullable(),
  deprecationReason: z.string().nullable(),
  supersededBy: z.number().int().positive().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MetricRecord = z.infer<typeof MetricRecord>;

/** Stamp carried by every result computed from a non-certified metric (exploratory). */
export const MetricExploratoryStamp = z.strictObject({
  banner: z.string().min(1),
  metricKey: z.string(),
  metricVersion: z.number().int().positive(),
  proposalHash: Sha256Hex,
});
export type MetricExploratoryStamp = z.infer<typeof MetricExploratoryStamp>;

/** A snapshot pins the exact metric version (and definition hash) it used. */
export const MetricVersionPin = z.strictObject({
  metricKey: z.string(),
  version: z.number().int().positive(),
  proposalHash: Sha256Hex,
});
export type MetricVersionPin = z.infer<typeof MetricVersionPin>;

export const EXPLORATORY_BANNER =
  "EXPLORATORY: this metric is not certified. It must not be cited in published or verified research artifacts.";
