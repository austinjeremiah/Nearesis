/**
 * Shared harness for tests that drive the REAL execution path: signed manifest -> plugin manager -> tool gateway ->
 * plugin handler (in-process confined, or in the container sandbox), on a disposable Postgres database.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signManifest } from "../../packages/plugin-sdk/src/index.ts";
import type { CapabilityDecl, ExecutionRequest, PluginManifest } from "../../packages/contracts/src/index.ts";
import type { Kernel, Session, PluginManagerConfig } from "../../packages/kernel/src/index.ts";
import {
  TEST_KEY,
  TEST_PUBLISHER,
  cap,
  createTestDb,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "plugins");
export const HOSTILE_CAP = "sec.hostile.run@1";

export function hostileManifest(
  over: {
    pluginId?: string;
    networkHosts?: string[];
    resourceLimits?: Record<string, number>;
    entrypoint?: string;
  } = {},
): PluginManifest {
  const entrypoint = over.entrypoint ?? "hostile.mjs";
  const file = readFileSync(join(FIXTURES, entrypoint));
  const m = {
    pluginId: over.pluginId ?? "sec-hostile",
    version: "1.0.0",
    apiVersion: 1,
    publisher: TEST_PUBLISHER,
    artifactSha256: createHash("sha256").update(file).digest("hex"),
    capabilities: [
      cap(HOSTILE_CAP, {
        timeoutMs: 15_000,
        inputSchema: { type: "object", additionalProperties: true },
        outputSchema: { type: "object" },
      } as Partial<CapabilityDecl>),
    ],
    permissions: [],
    networkHosts: over.networkHosts ?? [],
    resourceLimits: { memoryMb: 64, cpuMs: 4000, concurrency: 4, ...over.resourceLimits },
    configurationSchema: {},
    healthCheck: { intervalMs: 60_000 },
    entrypoint,
    rollbackStrategy: "previous_version",
    requires: [],
  } as unknown as PluginManifest;
  (m as unknown as Record<string, unknown>).signature = signManifest(m, TEST_KEY.privateKey);
  return m;
}

export interface Rig {
  db: TestDb;
  k: Kernel;
  human: Session;
  orgId: string;
  workspaceId: string;
  invoke: (input: Record<string, unknown>, capId?: string) => ReturnType<Kernel["gateway"]["invoke"]>;
  auditCount: (action: string) => Promise<number>;
  drop: () => Promise<void>;
}

/** One kernel on a fresh database with the hostile plugin installed and enabled in one workspace. */
export async function rig(opts: {
  manifest?: PluginManifest;
  execution?: PluginManagerConfig["execution"];
  prefix: string;
}): Promise<Rig> {
  const db = await createTestDb();
  const k = testKernel(db, {
    pluginRoot: FIXTURES,
    // no internal-endpoint grant unless the caller names the publisher
    execution: { internalPublishers: [], ...opts.execution },
  });
  const org = await seedOrg(db.admin, opts.prefix, { alice: "owner" });
  const human = await loginSession(k, org.users.alice!.subject);
  const manifest = opts.manifest ?? hostileManifest();
  await k.plugins.install(null, manifest);
  await k.plugins.enable(null, manifest.pluginId);
  const w = await k.workspaces.create(human, {
    objective: `${opts.prefix} real path`,
    networkScope: "fixture-only",
    idempotencyKey: `c-${randomUUID()}`,
  });
  await pluginUp(k, human, w.workspaceId, w.version, manifest.pluginId);
  await k.leases.issue(human, {
    workspaceId: w.workspaceId,
    holderActorId: human.principal.actorId,
    capability: HOSTILE_CAP,
    grants: [grant()],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const invoke: Rig["invoke"] = (input, capId = HOSTILE_CAP) =>
    k.gateway.invoke(human.principal, {
      requestId: randomUUID(),
      idempotencyKey: `idem-${randomUUID()}`,
      tenantId: org.orgId,
      workspaceId: w.workspaceId,
      actor: { kind: "human", actorId: human.principal.actorId },
      capability: capId,
      input,
      deadlineMs: 20_000,
      trace: { traceId: randomUUID() },
    } as ExecutionRequest);
  return {
    db,
    k,
    human,
    orgId: org.orgId,
    workspaceId: w.workspaceId,
    invoke,
    auditCount: async (action) =>
      Number(
        (await db.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = $1", [action]))
          .rows[0].n,
      ),
    drop: () => db.drop(),
  };
}
