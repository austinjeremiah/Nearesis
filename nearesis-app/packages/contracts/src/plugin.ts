import { z } from "zod";
import { IsoDateTime, SemVer, Sha256Hex, Uuid } from "./common.ts";

export const SideEffect = z.enum(["read_only", "workspace_write", "paid_call", "chain_write"]);
export type SideEffect = z.infer<typeof SideEffect>;

export const CapabilityCategory = z.enum([
  "data.source",
  "semantic.metricpack",
  "agent.role",
  "research.experiment",
  "canvas.paneltype",
  "monitor.rule",
  "evidence.verifier",
  "publisher.exporter",
  "network.adapter",
  "notification.channel",
  "tool.provider",
]);

/** Capability id: dotted name + @major, e.g. near.explorer.listSwaps@1 */
export const CapabilityId = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+@\d+$/);

export const CapabilityDecl = z.strictObject({
  id: CapabilityId,
  category: CapabilityCategory,
  sideEffect: SideEffect,
  idempotent: z.boolean(),
  /** Provider-side idempotency key support (A20 guarantee classes). */
  providerIdempotencyKey: z.boolean().default(false),
  latencyClass: z.enum(["interactive", "batch", "long_running"]),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  requiredGrants: z.array(z.string()).max(32),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(15 * 60_000),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
});
export type CapabilityDecl = z.infer<typeof CapabilityDecl>;

/** ch.04 manifest fields. */
export const PluginManifest = z.strictObject({
  pluginId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  version: SemVer,
  apiVersion: z.number().int().positive(),
  publisher: z.string().min(1).max(200),
  /** base64 ed25519 signature over canonical manifest-without-signature. Absent => unsigned. */
  signature: z.string().min(1).optional(),
  artifactSha256: Sha256Hex,
  capabilities: z.array(CapabilityDecl).min(1).max(64),
  permissions: z.array(z.string()).max(64),
  networkHosts: z.array(z.string().regex(/^[a-z0-9.-]+(?::\d+)?$/)).max(32),
  resourceLimits: z.strictObject({
    memoryMb: z.number().int().positive(),
    cpuMs: z.number().int().positive(),
    concurrency: z.number().int().positive(),
  }),
  configurationSchema: z.record(z.string(), z.unknown()),
  healthCheck: z.strictObject({
    capability: CapabilityId.optional(),
    intervalMs: z.number().int().positive(),
  }),
  entrypoint: z.string().min(1),
  rollbackStrategy: z.enum(["previous_version", "disable", "migration_down"]),
  requires: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]*@\d+$/))
    .max(32)
    .default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export const PluginState = z.enum(["installed", "enabled", "disabled", "degraded", "quarantined"]);
export const TrustMode = z.enum(["production", "dev_trust"]);

export const CapabilityGrant = z.strictObject({
  resource: z.string().min(1),
  action: z.string().min(1),
  maxCost: z.number().nonnegative(),
  expiresAt: IsoDateTime,
});
export type CapabilityGrant = z.infer<typeof CapabilityGrant>;

/** ch.04 execution envelope (request). grants are a fingerprint echo only; authority is server-resolved. */
export const ExecutionRequest = z.strictObject({
  requestId: Uuid,
  idempotencyKey: z.string().min(8).max(200),
  tenantId: Uuid,
  workspaceId: Uuid,
  actor: z.strictObject({ kind: z.enum(["human", "agent"]), actorId: Uuid, parentRunId: Uuid.optional() }),
  capability: CapabilityId,
  input: z.unknown(),
  deadlineMs: z
    .number()
    .int()
    .positive()
    .max(15 * 60_000),
  expectedWorkspaceVersion: z.number().int().nonnegative().optional(),
  grantFingerprint: Sha256Hex.optional(),
  trace: z.strictObject({ traceId: z.string().min(1), researchRunId: Uuid.optional() }),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

export const ExecutionResponse = z.strictObject({
  requestId: Uuid,
  state: z.enum(["ok", "partial", "blocked", "failed"]),
  payload: z.unknown(),
  sourceRefs: z.array(z.string()).max(1000),
  provenance: z.strictObject({
    pluginId: z.string(),
    pluginVersion: SemVer,
    capability: CapabilityId,
    resultSha256: Sha256Hex,
  }),
  cost: z.strictObject({ units: z.string(), amount: z.number().nonnegative() }).optional(),
  warnings: z.array(z.string()).max(100),
  outputSchemaVersion: z.number().int().positive(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  reasonCode: z.string().optional(),
});
export type ExecutionResponse = z.infer<typeof ExecutionResponse>;
