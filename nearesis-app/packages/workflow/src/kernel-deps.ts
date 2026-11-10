/**
 * Production wiring of the activity dependencies: the real kernel ToolGateway, kernel capability leases (K10) and the
 * kernel `canvas.apply_patch` command. The semantic and canvas tools come from the near-thesis plugin installed in
 * the kernel; the model comes from @nearesis/inference `createProvider()`.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createProviderFromEnv, loadEnvVar, resolveProviderMode } from "@nearesis/inference";
import { composeCanvas, registerRunSource } from "@nearesis/near-thesis";
import { DEFAULT_ENGINE_INTERFACES, Db, Kernel, type Session } from "@nearesis/kernel";
import type { ExecutionRequest, InferenceProvider, ToolGateway } from "@nearesis/contracts";
import {
  INVESTIGATION_GRANT,
  KernelCanvasExecutor,
  KernelLeaseBroker,
  requesterFromRuns,
  type Requester,
  type RequesterResolver,
  PgAudit,
  makePolicy,
  taskIdFromHash,
  withTenant,
  type LocalToolHandler,
  type Policy,
} from "@nearesis/agent-runtime";
import type { ActivityDeps, CanvasExecutor } from "./activities.ts";

/**
 * Model selection from the environment (INFERENCE_PROVIDER, root .env): `openrouter` uses the live provider (spend
 * goes through the shared USD 5 ledger in @nearesis/inference); otherwise the deterministic `mock`. Scenario tests
 * inject a scripted provider instead.
 */
export function createRuntimeProvider(): InferenceProvider {
  return createProviderFromEnv();
}
export const liveModelFromEnv = (): string =>
  loadEnvVar("OPENROUTER_PRIMARY_MODEL")?.trim() || "openai/gpt-4o-mini";

/**
 * Who asked: the run's recorded requester when the starter supplied one, otherwise the user the kernel audited as
 * submitting the question (`question.submitted`, written by the investigation API in the same request) together with
 * that user's membership role. Both are kernel facts; nothing here trusts model or workflow input.
 */
export function requesterFromKernel(pool: pg.Pool, kernel: Kernel): RequesterResolver {
  const fromRuns = requesterFromRuns(pool);
  return async (tenantId, runId) => {
    const direct = await fromRuns(tenantId, runId);
    if (direct) return direct;
    return kernel.db.tx({ orgId: tenantId, userId: ZERO_UUID, actorKind: "agent" }, async (tx) => {
      const a = await tx.query<{ actor_id: string | null }>(
        "SELECT actor_id FROM audit_events WHERE action = 'question.submitted' AND subject = $1 ORDER BY occurred_at LIMIT 1",
        [runId],
      );
      const userId = a.rows[0]?.actor_id;
      if (!userId) return null;
      const m = await tx.query<{ role: Requester["role"] }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
        [tenantId, userId],
      );
      return m.rows[0] ? { userId, role: m.rows[0].role } : null;
    });
  };
}
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Makes every gateway call for a run carry the run's semantic source (contracts 1.4.0 `source`): before delegating, the
 * source stored on the run's `runs` row (tenant-scoped read) is registered for the near-thesis plugin, which selects the
 * fixture cubes or cube-live from it. One choke point covers discovery, queries and canvas previews, whoever issues them.
 */
export function withRunSource(inner: ToolGateway, pool: pg.Pool): ToolGateway {
  const known = new Set<string>();
  return {
    async invoke(principal, request) {
      const runId = principal.parentRunId;
      if (runId && !known.has(runId)) {
        const r = await withTenant(pool, principal.orgId, (c) =>
          c.query<{ source: string }>("SELECT source FROM runs WHERE id = $1", [runId]),
        );
        if (r.rows[0]) {
          registerRunSource(runId, r.rows[0].source === "live" ? "live" : "fixture");
          if (known.size > 5000) known.clear();
          known.add(runId);
        }
      }
      return inner.invoke(principal, request);
    },
  };
}

export class KernelCanvas implements CanvasExecutor {
  constructor(
    private readonly o: {
      pool: pg.Pool;
      kernel: Kernel;
      gateway: ActivityDeps["gateway"];
      requesterOf: RequesterResolver;
    },
  ) {}

  async apply(a: Parameters<CanvasExecutor["apply"]>[0]) {
    const requester = await this.o.requesterOf(a.tenantId, a.runId);
    if (!requester) return { state: "blocked", detail: { reason: "run has no requesting user" } };
    // The requesting agent is the composer that proposed the panels (the director's allowlist has no canvas tools).
    const composer = await withTenant(this.o.pool, a.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        "SELECT id FROM tasks WHERE run_id=$1 AND role='composer' ORDER BY created_at LIMIT 1",
        [a.runId],
      );
      return r.rows[0]?.id;
    });
    if (!composer) return { state: "blocked", detail: { reason: "no composer task requested this action" } };
    const exec = new KernelCanvasExecutor(this.o.kernel);
    const session: Session = exec.sessionFor({
      tenantId: a.tenantId,
      runId: a.runId,
      agentActorId: composer,
      requester,
    });
    const revision = await exec.documentRevision(session, a.workspaceId);
    const approvedPatch = (a.params as { patch?: Record<string, unknown> }).patch;
    if (approvedPatch) {
      // Live composer: the owner approved this exact, already-previewed patch (the action hash covers it). The kernel
      // still validates it structurally and semantically; only the CAS revision is brought to the current one.
      const patch = {
        ...approvedPatch,
        expectedRevision: revision,
        operationId: taskIdFromHash(a.actionHash),
      };
      const r = await exec.apply(session, a.workspaceId, patch as never);
      return { state: "ok", detail: { workspaceVersion: r.workspaceVersion, eventSeq: r.eventSeq } };
    }
    const req: ExecutionRequest = {
      requestId: randomUUID(),
      idempotencyKey: `priv-preview-${a.actionHash}`,
      tenantId: a.tenantId,
      workspaceId: a.workspaceId,
      actor: { kind: "agent", actorId: composer, parentRunId: a.runId },
      capability: "canvas.preview@1",
      input: { expectedRevision: revision, requests: (a.params as { requests?: unknown[] }).requests ?? [] },
      deadlineMs: 60_000,
      trace: { traceId: `${a.runId}/priv`, researchRunId: a.runId },
    };
    const resp = await this.o.gateway.invoke(
      { kind: "agent", actorId: composer, orgId: a.tenantId, parentRunId: a.runId },
      req,
    );
    if (resp.state !== "ok")
      return { state: resp.state, detail: { reasonCode: resp.reasonCode ?? null, phase: "preview" } };
    const prev = resp.payload as {
      ok: boolean;
      patch: Record<string, unknown> | null;
      issues: unknown[];
    };
    if (!prev.ok || !prev.patch) return { state: "rejected", detail: { issues: prev.issues } };
    // The approved action hash is the patch's idempotency identity: a retried execution replays, never re-applies.
    const patch = { ...prev.patch, operationId: taskIdFromHash(a.actionHash) };
    const r = await exec.apply(session, a.workspaceId, patch as never);
    return { state: "ok", detail: { workspaceVersion: r.workspaceVersion, eventSeq: r.eventSeq } };
  }
}

export function canvasPatchProposalTool(leases: KernelLeaseBroker): LocalToolHandler {
  return async ({ principal, request }) => ({
    granted: await leases.hasGrant({
      tenantId: principal.orgId,
      workspaceId: request.workspaceId,
      taskId: principal.actorId,
      capability: "canvas.patch@1",
    }),
    payload: { ok: true, proposed: true, note: "recorded as a proposal; applied only after owner approval" },
  });
}

export function buildKernelDeps(a: {
  pool: pg.Pool;
  kernel: Kernel;
  appUrl?: string;
  policy?: Partial<Policy>;
  provider?: InferenceProvider;
  model?: string;
  /** Model-planned composer for non-scenario questions. Default: on when INFERENCE_PROVIDER=openrouter and no provider is injected. */
  liveComposer?: boolean;
}): ActivityDeps {
  const live = a.liveComposer ?? (!a.provider && resolveProviderMode() === "openrouter");
  const requesterOf = requesterFromKernel(a.pool, a.kernel);
  const leases = new KernelLeaseBroker({ kernel: a.kernel, requesterOf });
  const gateway = withRunSource(a.kernel.gateway, a.pool);
  return {
    pool: a.pool,
    ...(a.appUrl ? { appUrl: a.appUrl } : {}),
    policy: makePolicy(a.policy ?? {}),
    audit: new PgAudit(a.pool),
    gateway,
    leases,
    canvas: new KernelCanvas({ pool: a.pool, kernel: a.kernel, gateway, requesterOf }),
    localTools: { "canvas.patch@1": canvasPatchProposalTool(leases) },
    kernelMode: true,
    provider: a.provider ?? createRuntimeProvider(),
    ...(a.model ? { model: a.model } : live ? { model: liveModelFromEnv() } : {}),
    ...(live
      ? {
          liveComposer: {
            model: a.model ?? liveModelFromEnv(),
            compose: composeCanvas as unknown as NonNullable<ActivityDeps["liveComposer"]>["compose"],
          },
        }
      : {}),
    investigationGrant: INVESTIGATION_GRANT,
  };
}

/**
 * Boots a kernel for a worker or API process from configuration. Plugins are loaded from the installations persisted
 * in the database; manifests are verified against the trusted publisher keys (production trust, no dev trust).
 */
export async function bootKernel(cfg: {
  appUrl: string;
  pluginRoot: string;
  trustedKeys: Record<string, string[]>;
}): Promise<Kernel> {
  const kernel = new Kernel({
    db: Db.connect(cfg.appUrl, 8),
    plugins: {
      trustMode: "production",
      trustedKeys: cfg.trustedKeys,
      pluginRoot: cfg.pluginRoot,
      engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      quarantineAfterFailures: 1000,
    },
    authProvider: {
      authenticate: async () => {
        throw new Error("workers do not authenticate users");
      },
    },
    nodeEnv: "production",
  });
  await kernel.boot();
  return kernel;
}
