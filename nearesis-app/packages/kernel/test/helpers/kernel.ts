import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateSigningKeyPair, signManifest } from "@nearesis/plugin-sdk";
import type { CapabilityDecl, PluginManifest } from "@nearesis/contracts";
import { Kernel, DEFAULT_ENGINE_INTERFACES } from "../../src/index.ts";
import type { PluginManagerConfig, Session } from "../../src/index.ts";
import type { StreamOptions } from "../../src/stream.ts";
import type { TestDb } from "./db.ts";

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");

/** Deterministic-per-process test signing key; the public half is the trusted key of publisher "nearesis-test". */
export const TEST_KEY = generateSigningKeyPair();
export const TEST_PUBLISHER = "nearesis-test";

export interface FxState {
  imports: Record<string, number>;
  calls: Record<string, number>;
  /** latches by name: call release() to let a blocked slow handler finish */
  latches: Record<string, { promise: Promise<void>; release: () => void }>;
  healthFail: Record<string, boolean>;
}
export function fx(): FxState {
  const g = globalThis as unknown as { __nearesisFx?: FxState };
  g.__nearesisFx ??= { imports: {}, calls: {}, latches: {}, healthFail: {} };
  return g.__nearesisFx;
}
export function newLatch(name: string): { release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  fx().latches[name] = { promise, release };
  return { release };
}

export function cap(id: string, over: Partial<CapabilityDecl> = {}): CapabilityDecl {
  return {
    id,
    category: "tool.provider",
    sideEffect: "read_only",
    idempotent: true,
    providerIdempotencyKey: false,
    latencyClass: "interactive",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
    outputSchema: { type: "object" },
    requiredGrants: ["fx:run"],
    timeoutMs: 2000,
    maxOutputBytes: 100_000,
    ...over,
  } as CapabilityDecl;
}

export interface MakeManifest {
  pluginId: string;
  version: string;
  entrypoint: string;
  apiVersion?: number;
  capabilities?: CapabilityDecl[];
  requires?: string[];
  sign?: boolean | "bad";
  mutate?: (m: Record<string, unknown>) => void;
  dropRollback?: boolean;
}

/** Build a manifest for a fixture entrypoint (artifactSha256 = real file hash). Signed with the test key by default. */
export function makeManifest(o: MakeManifest): PluginManifest {
  const file = readFileSync(join(FIXTURE_ROOT, o.entrypoint));
  const m: Record<string, unknown> = {
    pluginId: o.pluginId,
    version: o.version,
    apiVersion: o.apiVersion ?? 1,
    publisher: TEST_PUBLISHER,
    artifactSha256: createHash("sha256").update(file).digest("hex"),
    capabilities: o.capabilities ?? [cap(`${o.pluginId.replace(/-/g, "_")}.say@1`)],
    permissions: [],
    networkHosts: [],
    resourceLimits: { memoryMb: 64, cpuMs: 1000, concurrency: 4 },
    configurationSchema: {},
    healthCheck: { intervalMs: 60_000 },
    entrypoint: o.entrypoint,
    rollbackStrategy: "previous_version",
    requires: o.requires ?? [],
  };
  o.mutate?.(m);
  if (o.dropRollback) delete m.rollbackStrategy;
  if (o.sign !== false) {
    const sig = signManifest(m as unknown as PluginManifest, TEST_KEY.privateKey);
    m.signature = o.sign === "bad" ? sig.slice(0, -6) + "AAAAAA" : sig;
  }
  return m as unknown as PluginManifest;
}

export function testKernel(
  db: TestDb,
  over: Partial<PluginManagerConfig> = {},
  extra: { sessionSecret?: string; nodeEnv?: string; stream?: StreamOptions } = {},
): Kernel {
  return new Kernel({
    db: db.app,
    plugins: {
      trustMode: "production",
      trustedKeys: { [TEST_PUBLISHER]: [TEST_KEY.publicKey] },
      pluginRoot: FIXTURE_ROOT,
      engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      quarantineAfterFailures: 3,
      // fixtures from the test publisher stand in for the platform's first-party connectors
      execution: { internalPublishers: [TEST_PUBLISHER] },
      ...over,
    },
    sessionSecret: extra.sessionSecret ?? "test-session-secret-0123456789abcdef",
    nodeEnv: extra.nodeEnv ?? "test",
    ...(extra.stream ? { stream: extra.stream } : {}),
  });
}

export async function loginSession(k: Kernel, subject: string): Promise<Session> {
  const token = await k.devAuth!.login(subject);
  return k.identity.resolveSession(token);
}

// ---- scenario helpers -------------------------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { CommandType, ExecutionRequest, ExecutionResponse } from "@nearesis/contracts";

export async function createWs(k: Kernel, s: Session, objective = "test objective") {
  return k.workspaces.create(s, {
    objective,
    networkScope: "fixture-only",
    idempotencyKey: `create-${randomUUID()}`,
  });
}

export function runCmd(
  k: Kernel,
  s: Session,
  workspaceId: string,
  commandType: CommandType,
  payload: Record<string, unknown>,
  expectedVersion: number,
  commandId: string = randomUUID(),
) {
  return k.commands.execute(s, workspaceId, {
    apiVersion: "v1",
    commandId,
    commandType,
    payload,
    expectedVersion,
  });
}

export function execReq(
  s: Session,
  workspaceId: string,
  capability: string,
  input: unknown = {},
  over: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    tenantId: s.principal.orgId,
    workspaceId,
    actor: { kind: "human", actorId: s.principal.actorId },
    capability,
    input,
    deadlineMs: 5000,
    trace: { traceId: randomUUID() },
    ...over,
  } as ExecutionRequest;
}

export const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

export function grant(
  over: Partial<{ resource: string; action: string; maxCost: number; expiresAt: string }> = {},
) {
  return { resource: "fx", action: "run", maxCost: 10, expiresAt: inHours(1), ...over };
}

export async function giveLease(
  k: Kernel,
  s: Session,
  workspaceId: string,
  capability: string,
  grants = [grant()],
  expiresAt = inHours(1),
) {
  return k.leases.issue(s, {
    workspaceId,
    holderActorId: s.principal.actorId,
    capability,
    grants,
    expiresAt,
  });
}

export async function pluginUp(
  k: Kernel,
  s: Session,
  workspaceId: string,
  expectedVersion: number,
  pluginId: string,
): Promise<number> {
  const r = await runCmd(k, s, workspaceId, "plugin.enable", { pluginId }, expectedVersion);
  return r.workspaceVersion;
}

export type { ExecutionResponse };
