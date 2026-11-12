import { z } from "zod";
import { IsoDateTime, Sha256Hex, SemVer, Visibility } from "./common.ts";
import { ResultTruncation } from "./overload.ts";

const MemberName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "cube.member");

/** ch.20 strict query schema. tenant/workspace/security context are NOT accepted (bound server-side). */
export const SemanticQuery = z
  .strictObject({
    semanticVersion: SemVer,
    measures: z.array(MemberName).min(1).max(8),
    dimensions: z.array(MemberName).max(6),
    time: z.strictObject({
      field: MemberName,
      from: IsoDateTime,
      to: IsoDateTime,
      grain: z.enum(["hour", "day", "week", "month"]),
    }),
    filters: z
      .array(
        z.strictObject({
          member: MemberName,
          operator: z.enum(["equals", "in", "gt", "gte", "lt", "lte"]),
          values: z
            .array(z.union([z.string().max(200), z.number()]))
            .min(1)
            .max(100),
        }),
      )
      .max(12),
    order: z.array(z.strictObject({ member: MemberName, direction: z.enum(["asc", "desc"]) })).max(4),
    limit: z.number().int().positive().max(10000),
    outputUnit: z.string().max(50).optional(),
    sourceSnapshotId: z.string().max(100).optional(),
  })
  .refine((q) => Date.parse(q.time.from) < Date.parse(q.time.to), {
    message: "time.from must be < time.to",
    path: ["time"],
  });
export type SemanticQuery = z.infer<typeof SemanticQuery>;

/** ch.06 metric catalog requirements. */
export const MetricMetadata = z.strictObject({
  id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  displayName: z.string().min(1),
  kind: z.enum(["stock", "flow", "count", "rate"]),
  unit: z.string().min(1),
  grain: z.enum(["day", "week"]),
  aggregationLaw: z.enum(["sum", "avg", "max", "min", "count_distinct", "non_additive", "ratio"]),
  denominator: z.string().nullable(),
  zeroPolicy: z.enum(["zero_is_observed", "zero_requires_complete_coverage"]),
  sources: z.array(z.string()).min(1),
  transformations: z.array(z.string()),
  expectedUpdateLag: z.string(),
  botProxyDefinition: z.string().nullable(),
  visibility: Visibility,
  segmentOverlap: z.enum(["disjoint", "overlapping", "n/a"]),
  certifiedVersion: SemVer,
  certified: z.boolean(),
  owner: z.string().min(1),
  docUri: z.string().min(1),
  testFixture: z.string().min(1),
  uncertainty: z.string().min(1),
  cubeMember: MemberName,
});
export type MetricMetadata = z.infer<typeof MetricMetadata>;

export const Coverage = z.enum(["complete", "partial", "unavailable"]);
export type Coverage = z.infer<typeof Coverage>;
const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** ch.06 step 6 DataFrameEnvelope. Exact amounts are strings with `scale`. */
export const DataFrameEnvelope = z.strictObject({
  queryHash: Sha256Hex,
  semanticVersion: SemVer,
  semanticModelHash: Sha256Hex,
  sourceSnapshotId: z.string().nullable(),
  columns: z.array(
    z.strictObject({
      name: z.string(),
      type: z.enum(["time", "string", "number", "decimal", "boolean"]),
      unit: z.string().nullable(),
      scale: z.number().int().nonnegative().optional(),
    }),
  ),
  rows: z.array(z.array(Cell)).max(100000),
  rowCoverage: z.array(Coverage).optional(),
  nullCount: z.number().int().nonnegative(),
  partialCount: z.number().int().nonnegative(),
  gaps: z.array(z.strictObject({ from: IsoDateTime, to: IsoDateTime, reason: z.string() })),
  sourceWatermarks: z.record(z.string(), IsoDateTime.nullable()),
  certification: z.enum(["certified", "experimental", "partial", "stale"]),
  cost: z.strictObject({ bytesEstimated: z.number().nonnegative(), bytesBilled: z.number().nonnegative() }),
  planFingerprint: Sha256Hex,
  generatedAt: IsoDateTime,
  /** v1.6.0 (additive): present only when the max-rows rule cut the result. Absent means nothing was cut. */
  truncation: ResultTruncation.optional(),
});
export type DataFrameEnvelope = z.infer<typeof DataFrameEnvelope>;
