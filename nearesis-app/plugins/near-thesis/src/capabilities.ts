import { z } from "zod";
import {
  type CapabilityDecl,
  CanvasPatch,
  DataFrameEnvelope,
  ErrorResponse,
  SemanticQuery,
} from "@nearesis/contracts";

/** JSON Schema for the kernel's ajv validation; zod refinements are re-checked inside the handlers. */
const schema = (s: z.ZodType) =>
  z.toJSONSchema(s, { unrepresentable: "any", target: "draft-7" }) as Record<string, unknown>;

/** Result of a capability: an ok payload or the gateway's structured error (never a thrown string). */
const resultOf = (ok: z.ZodType) =>
  z.union([
    z
      .object({ ok: z.literal(true) })
      .passthrough()
      .and(ok),
    z.object({ ok: z.literal(false), status: z.number(), error: ErrorResponse }),
  ]);

export const QueryOutput = z.object({
  ok: z.literal(true),
  queryHash: z.string(),
  cache: z.enum(["hit", "miss"]),
  envelope: DataFrameEnvelope,
});
export const DiscoverOutput = z.object({
  ok: z.literal(true),
  semanticVersion: z.string(),
  semanticModelHash: z.string(),
  metrics: z.array(z.unknown()),
  dimensions: z.array(z.unknown()),
});
/** Agent-facing input of metric.propose@1: the typed proposal (author is set by the kernel from the principal, never trusted). */
export const MetricProposeInput = z.object({
  proposal: z.record(z.string(), z.unknown()),
  /** `check` compiles only; `propose` stores a DRAFT and runs the full validation gate. */
  mode: z.enum(["check", "propose"]).default("propose"),
});
export const MetricProposeOutput = z.object({
  ok: z.literal(true),
  mode: z.enum(["check", "propose"]),
  status: z.enum(["REFUSED", "DRAFT", "VALIDATED"]),
  metricKey: z.string().nullable(),
  version: z.number().nullable(),
  issues: z.array(z.object({ reason: z.string(), path: z.string(), message: z.string() })),
  report: z.unknown().nullable(),
  exploratory: z.literal(true),
});
export const PreviewInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  requests: z.array(z.record(z.string(), z.unknown())).min(1).max(12),
});
export const PreviewOutput = z.object({
  ok: z.boolean(),
  patch: CanvasPatch.nullable(),
  issues: z.array(z.object({ index: z.number(), code: z.string(), path: z.string(), message: z.string() })),
});

const base = {
  idempotent: true,
  providerIdempotencyKey: false,
  latencyClass: "interactive" as const,
  timeoutMs: 30_000,
  maxOutputBytes: 8 * 1024 * 1024,
};

/** ch.25 registration points exposed as kernel capabilities. All read-only: no workspace writes, no paid calls. */
export const CAPABILITIES: CapabilityDecl[] = [
  {
    ...base,
    id: "semantic.query@1",
    category: "semantic.metricpack",
    sideEffect: "read_only",
    inputSchema: schema(SemanticQuery),
    outputSchema: schema(resultOf(QueryOutput)),
    requiredGrants: ["semantic:query"],
  },
  {
    ...base,
    id: "semantic.discover@1",
    category: "semantic.metricpack",
    sideEffect: "read_only",
    inputSchema: schema(z.object({}).strict()),
    outputSchema: schema(resultOf(DiscoverOutput)),
    requiredGrants: ["semantic:discover"],
  },
  {
    ...base,
    id: "metric.propose@1",
    category: "semantic.metricpack",
    // stores a DRAFT metric definition (never certified, never published); no workspace content changes, no paid calls
    sideEffect: "read_only",
    idempotent: false,
    timeoutMs: 60_000,
    inputSchema: schema(MetricProposeInput),
    outputSchema: schema(resultOf(MetricProposeOutput)),
    requiredGrants: ["metric:propose"],
  },
  {
    ...base,
    id: "canvas.preview@1",
    category: "canvas.paneltype",
    sideEffect: "read_only",
    inputSchema: schema(PreviewInput),
    outputSchema: schema(PreviewOutput),
    requiredGrants: ["canvas:preview"],
  },
];
