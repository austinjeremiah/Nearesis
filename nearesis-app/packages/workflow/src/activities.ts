import { CATALOG_UNAVAILABLE, catalogUnreadable, contextNeedsRebind } from "./source-gate.ts";
import { randomUUID } from "node:crypto";
import { meterActivities } from "./cost-ops.ts";
import {
  analyticsCallOf,
  commitInterpretation,
  computeInterpretation,
  previewQueriesOf,
  runInterpretation,
  type ComputedInterpretation,
  type FindingSink,
  type InterpretationDeps,
  type InterpretationSummary,
} from "./interpretation.ts";
import { guardInference, modelPolicyFromEnv, type InferenceVerification } from "@nearesis/kernel";
import type { z } from "zod";
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import type pg from "pg";
import {
  RUN_TRANSITIONS,
  type ExecutionRequest,
  type InferenceProvider,
  type RunState,
  type ToolGateway,
} from "@nearesis/contracts";
import {
  AbortedError,
  AgentRuntimeError,
  AgentToolClient,
  LedgerInference,
  Plan,
  Supervisor,
  ToolCallMeter,
  buildDirectorGraph,
  canonicalJson,
  loadRoles,
  openCheckpointer,
  reviewEvidenceResults,
  runInternalEffect,
  runRoleTask as runRoleGraph,
  sha256Hex,
  withTenant,
  validatorActorId,
  hashOf,
  taskIdFromHash,
  type ToolLogEntry,
  type AuditSink,
  type CostGovernor,
  type LeaseBroker,
  type LocalToolHandler,
  type Policy,
  type RoleResult,
} from "@nearesis/agent-runtime";
import {
  contextDifferences,
  contextHashes,
  gateTask,
  sourceHealthOf,
  sourceKey,
  type SourceHealth,
} from "@nearesis/near-thesis";
import type {
  ChildOutcome,
  ChildSpec,
  InvestigationInput,
  PlanView,
  PolicyView,
  RunContext,
  SourceGateView,
} from "./types.ts";

/**
 * Executes the owner-approved privileged action. The kernel implementation previews the proposal as the composer
 * agent principal (canvas.preview@1 through the gateway) and applies it with the kernel `canvas.apply_patch` command.
 */
export interface CanvasExecutor {
  apply(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    actionHash: string;
    params: Record<string, unknown>;
    directorTaskId: string;
  }): Promise<{ state: string; detail?: Record<string, unknown> }>;
}

/**
 * Live (model-planned) composer: used for runs that are not scripted test scenarios. `compose` is near-thesis
 * `composeCanvas()`: the model proposes only a typed plan of certified members; queries, previews and the patch are
 * derived from tool results through the kernel gateway.
 */
export interface LiveComposer {
  model: string;
  compose(a: {
    prompt: string;
    provider: InferenceProvider;
    model: string;
    invoke: (capability: string, input: unknown) => Promise<unknown>;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<{
    status: "ok" | "cannot_compute" | "rejected";
    plan: { rationale: string; panels: unknown[] } | null;
    patch: { operations: unknown[] } | null;
    issues: Array<{ code: string; message: string }>;
    modelRequestId: string | null;
    /** Per analytics-capability call outcome (panel built, typed CANNOT_COMPUTE, refused); shown with the proposal. */
    analytics?: unknown[];
  }>;
}
const isScripted = (text: string): boolean => /\[scenario=(?!none\])/.test(text);

export interface ActivityDeps {
  liveComposer?: LiveComposer;
  /** Interpretation stage output beyond the runtime tables: evidence graph claims and `finding.created` events (kernel-backed). */
  findingSink?: FindingSink;
  /**
   * A fresh provider per run for the interpretation stage. The live provider enforces a cumulative per-instance token cap
   * (RUN_TOKEN_CAP); sharing the worker's single instance would exhaust it after a few runs. The USD ceiling is the shared ledger and stays global.
   */
  providerForRun?: () => InferenceProvider;
  /** Interpretation model-call time limits (defaults 110 s analyst, 80 s skeptic); a timeout degrades to "interpretation unavailable". */
  interpretation?: { analystTimeoutMs?: number; skepticTimeoutMs?: number };
  /** Verified-state wiring (FND-072): records each model result's verification and reads the label a proposal must show. */
  verification?: InferenceVerification;
  /** App-role pool (nearesis_app, search_path=runtime). */
  pool: pg.Pool;
  /** Connection string for the LangGraph Postgres checkpointer (app role). Checkpointing is off when absent. */
  appUrl?: string;
  policy: Policy;
  audit: AuditSink;
  /** Spend governor (ch.13 cost model). When set, every model call is authorised before it is sent and settled after. */
  cost?: CostGovernor;
  gateway: ToolGateway;
  /** Kernel capability leases for agent principals (FND-20261110-030). */
  leases: LeaseBroker;
  canvas: CanvasExecutor;
  /** Runtime-executed tools (canvas.patch@1 -> proposal behind a kernel lease check). */
  localTools?: Record<string, LocalToolHandler>;
  /** Kernel mode: also audit gateway denials in the runtime audit and enforce the role allowlist client-side. */
  kernelMode?: boolean;
  provider: InferenceProvider;
  model?: string;
  /** Capabilities the investigation may delegate (root task grant). */
  investigationGrant: string[];
  /**
   * Health of a data source (collector provider id) for the fresh-data gate. Absent = the near-thesis health registry
   * only. A source with no record is treated as healthy: the gate refuses on evidence of a fault, never on silence.
   */
  sourceHealth?: (sourceId: string) => Promise<SourceHealth | undefined> | SourceHealth | undefined;
  /** Test-only transient fault points: returns true once for (point, scenario). */
  faultAt?: (point: string, scenario: string | undefined) => boolean;
  now?: () => number;
}

const model = (d: ActivityDeps) => d.model ?? "scripted-1";

export interface InterpretActivityInput {
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  directorTaskId: string;
  question: string;
}

/** Policy decisions become non-retryable ApplicationFailures typed by reasonCode (brief §10). */
export function toApplicationFailure(e: unknown): unknown {
  if (e instanceof AgentRuntimeError)
    return ApplicationFailure.nonRetryable(e.message, e.reasonCode, e.detail);
  return e;
}

/** toolCalls is a reservation against the run budget; the 24-calls-per-hypothesis cap is enforced by the tool meter. */
export const directorBudget = { tokens: 20000, toolCalls: 6, usd: 2 };
/** The live composer child's reservation. `MIN_QUESTION_BUDGET` (contracts) must stay >= director + composer. */
export const composerBudget = { tokens: 12000, toolCalls: 6, usd: 1 };

function createActivitiesRaw(d: ActivityDeps) {
  const roles = loadRoles();
  const supervisor = new Supervisor(d.pool, d.policy, d.audit, roles);
  const meter = new ToolCallMeter(d.pool, d.policy, d.audit);
  const now = d.now ?? (() => Date.now());
  // FND-073: every model call of every workflow agent, the composer and the research agents goes through this one
  // provider, so the classification guard applies to all of them whatever `d.provider` was injected.
  const egress = guardInference(d.provider, modelPolicyFromEnv());
  // FND-072: each delivered model result is submitted to the verifier-only state store (no-op without a verifier identity).
  const onResult = (tenantId: string, workspaceId: string) =>
    d.verification?.enabled
      ? {
          onProviderResult: async (e: {
            key: string;
            result: Parameters<typeof egress.verifyResponse>[0];
          }) => {
            await d.verification!.record({
              orgId: tenantId,
              workspaceId,
              key: e.key,
              result: e.result,
              verify: (r) => egress.verifyResponse(r),
            });
          },
        }
      : {};

  const interpretationDeps = (i: { tenantId: string; workspaceId: string }): InterpretationDeps => ({
    pool: d.pool,
    gateway: d.gateway,
    leases: d.leases,
    supervisor,
    provider: d.providerForRun?.() ?? d.provider,
    model: model(d),
    ...(d.cost ? { cost: d.cost } : {}),
    ...(d.findingSink ? { sink: d.findingSink } : {}),
    ...(d.interpretation?.analystTimeoutMs ? { analystTimeoutMs: d.interpretation.analystTimeoutMs } : {}),
    ...(d.interpretation?.skepticTimeoutMs ? { skepticTimeoutMs: d.interpretation.skepticTimeoutMs } : {}),
    ...onResult(i.tenantId, i.workspaceId),
  });

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toApplicationFailure(e);
    }
  }

  async function maybeFault(tenantId: string, runId: string, point: string, key: string, scenario?: string) {
    if (!d.faultAt?.(point, scenario)) return;
    const inserted = await withTenant(d.pool, tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO agent_side_effects (effect_key, kind, run_id, tenant_id, status)
         VALUES ($1,'fault',$2,$3,'done') ON CONFLICT (effect_key) DO NOTHING RETURNING effect_key`,
        [`fault:${point}:${key}`, runId, tenantId],
      );
      return r.rowCount === 1;
    });
    if (inserted) throw new Error(`injected transient failure at ${point}`);
  }

  async function liveCompose(
    i: { tenantId: string; workspaceId: string; runId: string; taskId: string; objective: string },
    tools: AgentToolClient,
    inference: LedgerInference,
  ): Promise<RoleResult> {
    const live = d.liveComposer!;
    const row = await withTenant(d.pool, i.tenantId, async (c) => {
      const r = await c.query<{ snapshot_ref: string; parent: string | null }>(
        "SELECT r.snapshot_ref, t.parent_task_id AS parent FROM runs r JOIN tasks t ON t.run_id = r.id WHERE t.id=$1",
        [i.taskId],
      );
      return r.rows[0];
    });
    // Queries are pinned to the run's source snapshot when the question asked for a pinned one.
    const pinned = row?.snapshot_ref?.startsWith("pinned:") ? row.snapshot_ref.slice(0, 100) : null;
    const toolLog: ToolLogEntry[] = [];
    const validator = validatorActorId(i.runId);
    // A28: the executable queries behind the previewed panels, kept with the proposal so the interpretation stage can read their results
    let previewQueries: ReturnType<typeof previewQueriesOf> = [];
    const analyticsCalls: NonNullable<ReturnType<typeof analyticsCallOf>>[] = [];
    // taken synchronously per call: the composer issues its tool calls concurrently, and each needs its own idempotency step
    let nextStep = 0;
    const invoke = async (capability: string, input: unknown): Promise<unknown> => {
      const step = nextStep++;
      if (capability === "semantic.discover@1") {
        // catalog discovery runs as the run's semantic_analyst validator principal (FND-20261110-030)
        await d.leases.ensureChild({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          parentTaskId: row?.parent ?? i.taskId,
          taskId: validator,
          role: "semantic_analyst",
          capabilities: ["semantic.discover@1"],
        });
        const r = await d.gateway.invoke(
          { kind: "agent", actorId: validator, orgId: i.tenantId, parentRunId: i.runId },
          {
            requestId: randomUUID(),
            idempotencyKey: `${i.runId}:live-discover`,
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            actor: { kind: "agent", actorId: validator, parentRunId: i.runId },
            capability: "semantic.discover@1",
            input: {},
            deadlineMs: 60_000,
            trace: { traceId: `${i.runId}/${validator}`, researchRunId: i.runId },
          },
        );
        toolLog.push({
          step,
          tool: capability,
          ok: r.state === "ok",
          reasonCode: r.state === "ok" ? null : (r.reasonCode ?? r.state),
          resultHash: r.state === "ok" ? r.provenance.resultSha256 : null,
        });
        if (r.state !== "ok")
          throw new AgentRuntimeError("SOURCE_UNAVAILABLE", `discover ${r.state}`, {
            reasonCode: r.reasonCode ?? null,
          });
        return r.payload;
      }
      const shaped =
        pinned && capability === "canvas.preview@1"
          ? {
              ...(input as Record<string, unknown>),
              requests: (
                (input as { requests: Array<{ query: Record<string, unknown> }> }).requests ?? []
              ).map((q) => ({ ...q, query: { ...q.query, sourceSnapshotId: pinned } })),
            }
          : input;
      const out = await tools.call(capability, shaped, `live${step}`);
      toolLog.push({
        step,
        tool: capability,
        ok: out.ok,
        reasonCode: out.ok ? null : out.reasonCode,
        resultHash: out.ok ? out.resultHash : null,
      });
      if (!out.ok)
        throw new AgentRuntimeError(
          out.reasonCode === "TOOL_NOT_GRANTED" ? "TOOL_NOT_GRANTED" : "SOURCE_UNAVAILABLE",
          `${capability}: ${out.reasonCode}`,
          {},
        );
      if (capability === "canvas.preview@1") previewQueries = previewQueriesOf(shaped);
      if (capability.endsWith(".analyze@1")) {
        const c = analyticsCallOf(capability, shaped, out.response.payload);
        if (c) analyticsCalls.push(c);
      }
      return out.response.payload;
    };
    const ledgerProvider: InferenceProvider = {
      id: "ledger",
      health: async () => ({ ok: true, detail: "ledger" }),
      listModels: async () => [],
      generateStructured: async (a: {
        model: string;
        system: string;
        prompt: string;
        schema: z.ZodType<unknown>;
        idempotencyKey: string;
        maxTokens: number;
      }) => {
        const output = await inference.generate({
          key: a.idempotencyKey,
          system: a.system,
          prompt: a.prompt,
          schema: a.schema,
          maxTokens: a.maxTokens,
        });
        return {
          output,
          provider: "ledger",
          model: a.model,
          requestId: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          evidence: null,
          rawResponseSha256: "",
        };
      },
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not supported");
      },
      verifyResponse: async () => ({
        verified: false,
        status: "unattested_dev" as const,
        checks: [],
        reason: "LEDGER_WRAPPER",
      }),
    } as unknown as InferenceProvider;
    // The routed wrapper is itself marked guarded (policy approves only the `ledger` routing id); the real binding is
    // checked again inside LedgerInference against `egress`.
    const provider = guardInference(ledgerProvider, modelPolicyFromEnv());
    const base = {
      taskId: i.taskId,
      role: "composer" as const,
      toolLog,
      parentRunId: i.runId,
      workspaceId: i.workspaceId,
      spawnRequests: [],
    };
    let res;
    try {
      res = await live.compose({
        prompt: i.objective,
        provider,
        model: live.model,
        invoke,
        expectedRevision: 0,
        idempotencyKey: `${i.taskId}:compose`,
      });
    } catch (e) {
      if (e instanceof AgentRuntimeError && e.reasonCode === "STAGE_TIMEOUT") throw e;
      const reason = e instanceof AgentRuntimeError ? e.reasonCode : "SOURCE_UNAVAILABLE";
      return {
        ...base,
        status: "failed",
        reasonCode: reason,
        message: String((e as Error).message).slice(0, 300),
        finding: null,
        artifact: {
          type: "canvas-patch.json",
          label: "unattested_dev",
          sha256: sha256Hex(canonicalJson({ failed: reason, task: i.taskId })),
          missingMetric: null,
          nextMeasurement: null,
        },
      };
    }
    const finding = (status: "supported" | "cannot_compute", statement: string) => ({
      id: taskIdFromHash(sha256Hex(`finding:${i.taskId}`)),
      workspaceId: i.workspaceId,
      runId: i.runId,
      agentRole: "composer" as const,
      status,
      statement,
      facts: [],
      limitations: ["model-planned composition; label unattested_dev"],
      createdAt: new Date().toISOString(),
    });
    if (res.status === "ok" && res.patch)
      return {
        ...base,
        status: "finished",
        reasonCode: null,
        message: null,
        finding: finding(
          "supported",
          res.analytics?.length
            ? "Composed a canvas proposal from the certified catalog and typed analytics results (labelled ANALYTICS_RESULT, not certified metrics) and verified it."
            : "Composed a canvas proposal from the certified catalog and verified it with the preview tool.",
        ),
        artifact: {
          type: "canvas-patch.json",
          label: "unattested_dev",
          sha256: hashOf(res.patch),
          missingMetric: null,
          nextMeasurement: null,
        },
        proposal: {
          patch: res.patch,
          plan: res.plan,
          queries: previewQueries,
          analyticsCalls,
          modelRequestId: res.modelRequestId,
          // analytics panels are ANALYTICS_RESULT (source tables, not certified metrics); skipped asks stay visible here
          ...(res.analytics?.length ? { analytics: res.analytics, skipped: res.issues } : {}),
          // ch.12: the proposal shows the verification state of the model result that produced it; no stored state means
          // `unverified`, and a failed or tampered state is shown as failed, never as verified.
          verification: await (async () => {
            const l = await (d.verification ?? null)?.labelFor({
              orgId: i.tenantId,
              workspaceId: i.workspaceId,
              key: `${i.taskId}:compose`,
            });
            return l
              ? { state: l.state, text: l.badge.text }
              : { state: "unverified" as const, text: "Unverified" };
          })(),
        },
      };
    if (res.status === "cannot_compute")
      return {
        ...base,
        status: "finished",
        reasonCode: null,
        message: null,
        finding: finding(
          "cannot_compute",
          res.analytics?.length
            ? "Neither the certified catalog nor the analytics tools can answer this request; no panels were proposed."
            : "The certified catalog cannot answer this request; no panels were proposed.",
        ),
        artifact: {
          type: "canvas-patch.json",
          label: "unattested_dev",
          sha256: hashOf(res.issues),
          missingMetric: (res.plan?.rationale ?? "unknown").slice(0, 200),
          nextMeasurement: "Add the missing metric to the certified catalog or narrow the request.",
        },
      };
    return {
      ...base,
      status: "failed",
      reasonCode: "PATCH_REJECTED",
      message: JSON.stringify(res.issues).slice(0, 300),
      finding: null,
      artifact: {
        type: "canvas-patch.json",
        label: "unattested_dev",
        sha256: hashOf(res.issues),
        missingMetric: null,
        nextMeasurement: null,
      },
    };
  }

  return {
    /** Binds a live composer's verified patch into the privileged action, so the owner approves the exact patch (hash covers it). */
    async bindComposerAction(i: {
      tenantId: string;
      runId: string;
      action: { kind: string; params: Record<string, unknown>; network: string; costLimit: number };
    }): Promise<{ kind: string; params: Record<string, unknown>; network: string; costLimit: number }> {
      const patch = await withTenant(d.pool, i.tenantId, async (c) => {
        const r = await c.query<{ patch: unknown }>(
          "SELECT result->'result'->'proposal'->'patch' AS patch FROM tasks WHERE run_id=$1 AND role='composer' AND status='DONE' ORDER BY created_at LIMIT 1",
          [i.runId],
        );
        return r.rows[0]?.patch ?? null;
      });
      if (!patch) throw new AgentRuntimeError("APPROVAL_INVALID", "no composer proposal to approve", {});
      return { ...i.action, params: { patch } };
    },

    async loadPolicy(): Promise<PolicyView> {
      return {
        stageTimeboxMs: d.policy.stageTimeboxMs,
        heartbeatTimeoutMs: d.policy.heartbeatTimeoutMs,
        approvalTimeoutMs: d.policy.approvalTimeoutMs,
      };
    },

    /** Creates the run row, director (depth 0) task and its budget reservation. Idempotent. */
    async initRun(i: InvestigationInput & { workflowId: string }): Promise<{ directorTaskId: string }> {
      return guarded(async () => {
        await withTenant(d.pool, i.tenantId, (c) =>
          c.query(
            `INSERT INTO runs (id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, scenario, state, requested_by, requested_role, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED',$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
            [
              i.runId,
              i.tenantId,
              i.workspaceId,
              i.investigationId,
              i.questionId,
              i.snapshotRef,
              i.budgetId,
              i.workflowId,
              i.scenario ?? null,
              i.requestedBy?.userId ?? null,
              i.requestedBy?.role ?? null,
              i.source ?? "fixture",
            ],
          ),
        );
        const rootCaps = [...new Set([...d.investigationGrant, ...roles.get("director")!.allowedTools])];
        const root = await supervisor.createRootTask({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          investigationId: i.investigationId,
          budgetId: i.budgetId,
          snapshotRef: i.snapshotRef,
          role: "director",
          capabilities: rootCaps,
          budget: directorBudget,
        });
        // The run's workspace grant: root leases held by the director task; every child lease derives from these.
        await d.leases.ensureRoot({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          taskId: root.taskId,
          role: "director",
          capabilities: rootCaps,
        });
        return { directorTaskId: root.taskId };
      });
    },

    /** Persists a run event; transitions are validated against RUN_TRANSITIONS and update runs.state (A19 d). */
    async recordRunEvent(e: {
      tenantId: string;
      runId: string;
      source: string;
      seq: number;
      kind: string;
      from?: RunState | null;
      to?: RunState | null;
      detail?: Record<string, unknown>;
      failure?: unknown;
    }): Promise<void> {
      return guarded(async () => {
        if (e.kind === "transition") {
          if (!e.from || !e.to || !RUN_TRANSITIONS[e.from].includes(e.to))
            throw new AgentRuntimeError("ILLEGAL_TRANSITION", `illegal transition ${e.from} -> ${e.to}`, {});
        }
        await withTenant(d.pool, e.tenantId, async (c) => {
          const ins = await c.query(
            `INSERT INTO run_events (tenant_id, run_id, source, seq, kind, from_state, to_state, detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id, source, seq) DO NOTHING RETURNING id`,
            [
              e.tenantId,
              e.runId,
              e.source,
              e.seq,
              e.kind,
              e.from ?? null,
              e.to ?? null,
              JSON.stringify(e.detail ?? {}),
            ],
          );
          if (e.kind === "transition" && ins.rowCount)
            await c.query(
              `UPDATE runs SET state=$2, failure=COALESCE($3::jsonb, failure), updated_at=now() WHERE id=$1`,
              [e.runId, e.to, e.failure ? JSON.stringify(e.failure) : null],
            );
        });
      });
    },

    /** Director: LangGraph plan -> validate_plan (-> human_input). Runs inside this activity; Temporal owns retries. */
    async planTask(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      budgetId: string;
      directorTaskId: string;
      question: string;
      scenario?: string;
    }): Promise<PlanView & { missingMetrics: string[] }> {
      return guarded(async () => {
        if (d.liveComposer && !isScripted(i.question)) {
          // Live question: the plan is deterministic (one composer branch, then the approval-gated canvas apply); the
          // model is used inside the composer, where every number and query is derived from tool results.
          const snapshotRef = await withTenant(d.pool, i.tenantId, async (c) => {
            const r = await c.query<{ snapshot_ref: string }>("SELECT snapshot_ref FROM runs WHERE id=$1", [
              i.runId,
            ]);
            return r.rows[0]?.snapshot_ref ?? "live";
          });
          const text = i.question.replace(/^\[scenario=none\]\s*/, "");
          return {
            stages: [
              [
                {
                  task: "compose canvas",
                  role: "composer",
                  objective: text.slice(0, 3900),
                  capabilities: [
                    "canvas.preview@1",
                    "intents.analyze@1",
                    "entities.analyze@1",
                    "accounts.analyze@1",
                  ],
                  inputSnapshot: snapshotRef.slice(0, 500),
                  budget: { ...composerBudget },
                  maxChildDepth: 0,
                },
              ],
            ],
            privilegedAction: {
              kind: "canvas.apply_patch",
              params: { fromComposer: true },
              network: "fixture-only",
              costLimit: 0,
            },
            requiredMetrics: [],
            modelVersion: d.liveComposer.model,
            missingMetrics: [],
          };
        }
        const saver = d.appUrl ? openCheckpointer(d.appUrl) : undefined;
        try {
          const inference = new LedgerInference(
            egress,
            d.pool,
            supervisor,
            {
              tenantId: i.tenantId,
              workspaceId: i.workspaceId,
              runId: i.runId,
              budgetId: i.budgetId,
              taskId: i.directorTaskId,
              model: model(d),
              ...onResult(i.tenantId, i.workspaceId),
              ...(Context.current().cancellationSignal
                ? { signal: Context.current().cancellationSignal }
                : {}),
            },
            d.cost,
          );
          const graph = buildDirectorGraph({
            mode: "plan",
            question: i.question,
            taskId: i.directorTaskId,
            roles,
            inference,
            heartbeat: () => Context.current().heartbeat(),
            ...(saver ? { checkpointer: saver } : {}),
            discoverMetrics: async (metrics, key) => {
              // FND-20261110-030: coverage is checked by a semantic_analyst agent principal holding its own lease,
              // derived from the run's grant. No service principal exists; the director never calls semantic tools.
              const validator = validatorActorId(i.runId);
              await d.leases.ensureChild({
                tenantId: i.tenantId,
                workspaceId: i.workspaceId,
                runId: i.runId,
                parentTaskId: i.directorTaskId,
                taskId: validator,
                role: "semantic_analyst",
                capabilities: ["semantic.discover@1"],
              });
              const req: ExecutionRequest = {
                requestId: randomUUID(),
                idempotencyKey: key,
                tenantId: i.tenantId,
                workspaceId: i.workspaceId,
                actor: { kind: "agent", actorId: validator, parentRunId: i.runId },
                capability: "semantic.discover@1",
                input: {},
                deadlineMs: 60_000,
                trace: { traceId: `${i.runId}/${validator}`, researchRunId: i.runId },
              };
              const r = await d.gateway.invoke(
                { kind: "agent", actorId: validator, orgId: i.tenantId, parentRunId: i.runId },
                req,
              );
              if (r.state !== "ok" && r.state !== "partial")
                throw new AgentRuntimeError(
                  r.state === "blocked" ? "TOOL_NOT_GRANTED" : "SOURCE_UNAVAILABLE",
                  `plan validation discover ${r.state}: ${r.reasonCode ?? ""}`,
                  { reasonCode: r.reasonCode ?? null },
                );
              const catalog = new Set(
                ((r.payload as { metrics?: Array<{ id?: string }> } | null)?.metrics ?? []).map(
                  (m) => m.id ?? "",
                ),
              );
              return {
                available: metrics.filter((m) => catalog.has(m)),
                missing: metrics.filter((m) => !catalog.has(m)),
              };
            },
          });
          const cfg = { configurable: { thread_id: i.directorTaskId }, recursionLimit: 50 };
          let state: { plan: Plan | null; validation: { missingMetrics: string[] } | null };
          if (saver) {
            const snap = await graph.getState(cfg);
            const v = snap.values as
              { plan: Plan | null; validation: { missingMetrics: string[] } | null } | undefined;
            if (v?.plan && v.validation && snap.next.length === 0) state = v;
            else state = (await graph.invoke(snap.next.length ? null : {}, cfg)) as typeof state;
          } else state = (await graph.invoke({}, cfg)) as typeof state;
          const plan = state.plan!;
          return {
            stages: plan.stages,
            privilegedAction: plan.privilegedAction,
            requiredMetrics: plan.requiredMetrics,
            modelVersion: plan.modelVersion,
            missingMetrics: state.validation?.missingMetrics ?? [],
          };
        } finally {
          await saver?.end().catch(() => undefined);
        }
      });
    },

    /**
     * Freezes the run's dispatch context (ch.16b B12): the question, snapshot, metric-version map and preregistration
     * hashes every child must carry. Idempotent: a replayed or retried call returns the stored context.
     */
    async bindRunContext(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      directorTaskId: string;
      question: string;
      preregistrationHash?: string;
    }): Promise<RunContext> {
      return guarded(async () => {
        const row = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query<{ snapshot_ref: string; context: RunContext | null }>(
            "SELECT snapshot_ref, context FROM runs WHERE id=$1",
            [i.runId],
          );
          return r.rows[0];
        });
        if (!row) throw new AgentRuntimeError("TOOL_NOT_GRANTED", "unknown run", {});
        // an unreadable-catalog context is retried (kernel mode), never frozen: a transient plugin/kernel fault must not
        // poison the run's context for good
        if (row.context && !(d.kernelMode && contextNeedsRebind(row.context))) return row.context;
        let catalogError: string | undefined;
        const versions: Record<string, string> = {};
        const metricSources: Record<string, string[]> = {};
        if (d.kernelMode) {
          const validator = validatorActorId(i.runId);
          await d.leases.ensureChild({
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            parentTaskId: i.directorTaskId,
            taskId: validator,
            role: "semantic_analyst",
            capabilities: ["semantic.discover@1"],
          });
          const r = await d.gateway.invoke(
            { kind: "agent", actorId: validator, orgId: i.tenantId, parentRunId: i.runId },
            {
              requestId: randomUUID(),
              idempotencyKey: `${i.runId}:bind-context`,
              tenantId: i.tenantId,
              workspaceId: i.workspaceId,
              actor: { kind: "agent", actorId: validator, parentRunId: i.runId },
              capability: "semantic.discover@1",
              input: {},
              deadlineMs: 60_000,
              trace: { traceId: `${i.runId}/${validator}`, researchRunId: i.runId },
            },
          );
          if (r.state === "ok" || r.state === "partial") {
            const p = r.payload as {
              semanticVersion?: string;
              metrics?: Array<{ id?: string; certifiedVersion?: string; sources?: string[] }>;
            } | null;
            for (const m of p?.metrics ?? []) {
              if (!m.id) continue;
              versions[m.id] = m.certifiedVersion ?? p?.semanticVersion ?? "unversioned";
              metricSources[m.id] = [...new Set((m.sources ?? []).map(sourceKey))];
            }
          } else catalogError = r.reasonCode ?? r.state;
        }
        const ctx: RunContext = {
          hashes: contextHashes({
            question: i.question,
            snapshotId: row.snapshot_ref,
            metricVersionMap: versions,
            preregistrationHash: i.preregistrationHash ?? "unregistered",
          }),
          metricSources,
          ...(catalogError ? { catalogError } : {}),
        };
        await withTenant(d.pool, i.tenantId, (c) =>
          c.query(
            "UPDATE runs SET context=$2::jsonb WHERE id=$1 AND (context IS NULL OR context->'metricSources' = '{}'::jsonb)",
            [i.runId, JSON.stringify(ctx)],
          ),
        );
        return ctx;
      });
    },

    /**
     * Fresh-data gate: a `live` run (real data) whose sources are degraded or unavailable is `BLOCKED_SOURCE` before any
     * child starts. A fixture run reads frozen data and is never gated. The decision comes from source health the
     * collector recorded, never from a guess; a source with no health record is not a reason to refuse.
     */
    async gateRun(i: {
      tenantId: string;
      runId: string;
      requiredMetrics: string[];
    }): Promise<SourceGateView> {
      return guarded(async () => {
        const row = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query<{ source: string; context: RunContext | null }>(
            "SELECT source, context FROM runs WHERE id=$1",
            [i.runId],
          );
          return r.rows[0];
        });
        if (!row || row.source !== "live")
          return { gated: false, state: "RUN", reasonCode: null, sources: [] };
        const by = row.context?.metricSources ?? {};
        // fail closed: a live run whose catalog could not be read has no known sources, so it cannot be shown fresh
        if (catalogUnreadable(by))
          return {
            gated: true,
            state: "BLOCKED_SOURCE",
            reasonCode: CATALOG_UNAVAILABLE,
            // name the cause (the kernel's reason code for the failed catalog read) instead of an empty source list
            sources: row.context?.catalogError
              ? [{ source: "semantic.discover@1", status: "unavailable", reason: row.context.catalogError }]
              : [],
          };
        // the sources behind the metrics the plan needs; a plan naming no metric the live catalog knows (or none at all)
        // reads the whole live layer, so every live source counts
        const named = i.requiredMetrics.filter((m) => by[m]);
        const wanted = named.length ? named : Object.keys(by);
        const sources = [...new Set(wanted.flatMap((m) => by[m] ?? []))];
        const known = new Map<string, SourceHealth | undefined>();
        for (const s of sources) known.set(s, (await d.sourceHealth?.(s)) ?? sourceHealthOf(s));
        const g = gateTask("fresh", sources, (s) => known.get(s));
        return { gated: true, state: g.state, reasonCode: g.reason_code, sources: g.sources };
      });
    },

    /** Server-enforced spawn (depth, fan-out, capability subset, budget reserve, dedup). Rejections are typed failures. */
    async spawnTask(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      budgetId: string;
      investigationId: string;
      parentTaskId: string;
      modelVersion: string;
      child: ChildSpec;
      /** Delegation grants of the run (marker.assign): the child's capabilities are narrowed to these. */
      grants?: string[];
    }): Promise<{ taskId: string; depth: number; created: boolean; status: string; hypothesisId: string }> {
      return guarded(async () => {
        const parent = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query<{
            role: string;
            depth: number;
            allowed_capabilities: string[];
            hypothesis_id: string;
          }>("SELECT role, depth, allowed_capabilities, hypothesis_id FROM tasks WHERE id=$1", [
            i.parentTaskId,
          ]);
          return r.rows[0];
        });
        if (!parent) throw new AgentRuntimeError("TOOL_NOT_GRANTED", "unknown parent task", {});
        if (!roles.get(parent.role as never)?.allowedTools.includes("agent.spawn@1")) {
          await d.audit.write({
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            taskId: i.parentTaskId,
            kind: "spawn.rejected",
            reasonCode: "TOOL_NOT_GRANTED",
            detail: { role: parent.role },
          });
          throw new AgentRuntimeError("TOOL_NOT_GRANTED", `role ${parent.role} may not spawn`, {});
        }
        // Dispatch enforcement (ch.16b B12): a run that froze a context lets only children carrying exactly that
        // question, snapshot, metric-version-map and preregistration hash start; anything else is refused and audited.
        const runCtx = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query<{ context: RunContext | null }>("SELECT context FROM runs WHERE id=$1", [
            i.runId,
          ]);
          return r.rows[0]?.context ?? null;
        });
        if (runCtx) {
          const differs = contextDifferences(runCtx.hashes, i.child.context);
          if (differs.length) {
            await d.audit.write({
              tenantId: i.tenantId,
              workspaceId: i.workspaceId,
              runId: i.runId,
              taskId: i.parentTaskId,
              kind: "spawn.rejected",
              reasonCode: "CONTEXT_MISMATCH",
              detail: { task: i.child.task, role: i.child.role, differs },
            });
            throw new AgentRuntimeError(
              "CONTEXT_MISMATCH",
              `child ${i.child.role} context differs from the run's frozen context: ${differs.join(", ")}`,
              { differs },
            );
          }
        }
        const hypothesisId = `${i.child.task}|${i.child.inputSnapshot}`;
        // Delegation grants narrow (never widen) what the role and the parent would allow: a tool the role permits but the
        // grant set excludes is simply not leased, so the kernel denies and audits it at invocation.
        const granted = i.grants ? new Set(i.grants) : undefined;
        const capabilities = granted
          ? i.child.capabilities.filter((c) => granted.has(c))
          : i.child.capabilities;
        const r = await supervisor.spawn(
          {
            role: i.child.role as never,
            objective: i.child.objective,
            workspaceId: i.workspaceId,
            allowedCapabilities: capabilities,
            maxChildDepth: i.child.maxChildDepth,
            budget: i.child.budget,
          },
          {
            tenantId: i.tenantId,
            runId: i.runId,
            budgetId: i.budgetId,
            parent: {
              taskId: i.parentTaskId,
              depth: parent.depth,
              allowedCapabilities: parent.allowed_capabilities,
            },
            dedupKey: {
              workspaceId: i.workspaceId,
              investigationId: i.investigationId,
              task: i.child.task,
              modelVersion: i.modelVersion,
              inputSnapshot: i.child.inputSnapshot,
            },
            hypothesisId,
          },
        );
        // The child's leases are derived from the parent's (never wider); idempotent for a retried or deduplicated spawn.
        await d.leases.ensureChild({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          parentTaskId: i.parentTaskId,
          taskId: r.taskId,
          role: i.child.role,
          capabilities,
        });
        if (runCtx)
          await withTenant(d.pool, i.tenantId, (c) =>
            c.query("UPDATE tasks SET context=$2::jsonb WHERE id=$1 AND context IS NULL", [
              r.taskId,
              JSON.stringify(i.child.context),
            ]),
          );
        return { taskId: r.taskId, depth: r.depth, created: r.created, status: r.status, hypothesisId };
      });
    },

    /** Records that the child workflow exists. Idempotent; an injected transient failure exercises parent retry (A18). */
    async recordChildStarted(i: {
      tenantId: string;
      runId: string;
      taskId: string;
      childWorkflowId: string;
      scenario?: string;
    }): Promise<void> {
      await maybeFault(i.tenantId, i.runId, "recordChildStarted", i.taskId, i.scenario);
      await withTenant(d.pool, i.tenantId, (c) =>
        c.query("UPDATE tasks SET workflow_id=$2, updated_at=now() WHERE id=$1", [
          i.taskId,
          i.childWorkflowId,
        ]),
      );
    },

    /** Role worker: LangGraph graph inside this activity (thread id = task id); resumes from the Postgres checkpoint. */
    async runRoleTask(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      budgetId: string;
      taskId: string;
      role: string;
      objective: string;
      hypothesisId: string;
    }): Promise<RoleResult> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 500);
      const saver = d.appUrl ? openCheckpointer(d.appUrl) : undefined;
      try {
        const roleCfg = roles.get(i.role as never)!;
        const tools = new AgentToolClient({
          gateway: d.gateway,
          audit: d.audit,
          meter,
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          taskId: i.taskId,
          hypothesisId: i.hypothesisId,
          role: i.role,
          ...(d.kernelMode ? { roleAllowed: roleCfg.allowedTools, auditGatewayDenials: true } : {}),
          ...(d.localTools ? { local: d.localTools } : {}),
        });
        const inference = new LedgerInference(
          egress,
          d.pool,
          supervisor,
          {
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            budgetId: i.budgetId,
            taskId: i.taskId,
            model: model(d),
            ...onResult(i.tenantId, i.workspaceId),
            signal: ctx.cancellationSignal,
          },
          d.cost,
        );
        if (i.role === "composer" && d.liveComposer && !isScripted(i.objective))
          return await liveCompose(i, tools, inference);
        const result = await runRoleGraph({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          taskId: i.taskId,
          role: i.role as never,
          roleCfg,
          hypothesisId: i.hypothesisId,
          objective: i.objective,
          tools,
          inference,
          now,
          stageDeadlineAt: now() + d.policy.stageTimeboxMs,
          heartbeat: () => ctx.heartbeat(),
          signal: ctx.cancellationSignal,
          clock: () => new Date().toISOString(),
          ...(saver ? { checkpointer: saver } : {}),
        });
        return result;
      } catch (e) {
        if (e instanceof AbortedError) throw new CancelledFailure("role task cancelled");
        if (e instanceof AgentRuntimeError && e.reasonCode !== "CANCELLED") {
          await d.audit.write({
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            taskId: i.taskId,
            actor: "role-worker",
            kind: "task.failed",
            reasonCode: e.reasonCode,
            detail: e.detail,
          });
          const failed: RoleResult = {
            taskId: i.taskId,
            role: i.role as never,
            status: "failed",
            reasonCode: e.reasonCode,
            message: e.message,
            finding: null,
            artifact: {
              type: roles.get(i.role as never)!.artifact,
              label: "unattested_dev",
              sha256: sha256Hex(canonicalJson({ failed: e.reasonCode, task: i.taskId })),
              missingMetric: null,
              nextMeasurement: null,
            },
            toolLog: [],
            parentRunId: i.runId,
            workspaceId: i.workspaceId,
            spawnRequests: [],
          };
          return failed;
        }
        throw e;
      } finally {
        clearInterval(timer);
        await saver?.end().catch(() => undefined);
      }
    },

    /** Internal effect (panel/artifact proposal): exactly once via key + write in one transaction (A18 c, A20 c). */
    async persistArtifact(i: {
      tenantId: string;
      runId: string;
      taskId: string;
      artifactSha256: string;
    }): Promise<{ accepted: boolean }> {
      const out = await runInternalEffect(
        d.pool,
        { tenantId: i.tenantId, runId: i.runId, effectKey: `artifact:${i.taskId}`, kind: "panel_proposal" },
        async () => ({ artifactSha256: i.artifactSha256 }),
      );
      return { accepted: out.accepted };
    },

    async finishTask(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      budgetId: string;
      taskId: string;
      status: "DONE" | "FAILED" | "CANCELLED";
      outcome: ChildOutcome;
    }): Promise<void> {
      await supervisor.completeTask({
        tenantId: i.tenantId,
        workspaceId: i.workspaceId,
        runId: i.runId,
        budgetId: i.budgetId,
        taskId: i.taskId,
        status: i.status,
        outputRef: i.outcome.result ? sha256Hex(canonicalJson(i.outcome.result)) : null,
      });
      await withTenant(d.pool, i.tenantId, (c) =>
        c.query("UPDATE tasks SET result=$2::jsonb WHERE id=$1", [i.taskId, JSON.stringify(i.outcome)]),
      );
    },

    /** Resolves an already-started child (possibly owned by another parent) by polling its task record. */
    async awaitTaskOutcome(i: {
      tenantId: string;
      taskId: string;
      timeoutMs: number;
    }): Promise<ChildOutcome> {
      const ctx = Context.current();
      const end = Date.now() + i.timeoutMs;
      for (;;) {
        ctx.heartbeat();
        const row = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query<{ status: string; result: ChildOutcome | null }>(
            "SELECT status, result FROM tasks WHERE id=$1",
            [i.taskId],
          );
          return r.rows[0];
        });
        if (row && ["DONE", "FAILED", "CANCELLED"].includes(row.status) && row.result)
          return { ...row.result, deduplicated: true };
        if (Date.now() > end)
          throw ApplicationFailure.nonRetryable("existing child did not finish", "STAGE_TIMEOUT");
        await new Promise((r) => setTimeout(r, 300));
      }
    },

    /** Persists the approval decision (called only for decisions that match the current action hash). */
    async recordApproval(i: {
      tenantId: string;
      runId: string;
      actionHash: string;
      decision: "approve" | "reject";
      by: string;
      network: string;
      costLimit: number;
      ttlMs: number;
    }): Promise<void> {
      await withTenant(d.pool, i.tenantId, (c) =>
        c.query(
          `INSERT INTO approvals (tenant_id, run_id, action_hash, decision, approved_by, network, cost_limit, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' milliseconds')::interval)
           ON CONFLICT (run_id, action_hash, decision, approved_by) DO NOTHING`,
          [i.tenantId, i.runId, i.actionHash, i.decision, i.by, i.network, i.costLimit, String(i.ttlMs)],
        ),
      );
    },

    /**
     * The privileged step. The approval is re-verified HERE at execution time (the model/workflow signal alone is not
     * authorization, ch.05): hash must equal sha256 of the exact canonical parameters, and a stored, unexpired approval
     * for that hash must exist. Executes exactly once (ledger key = run + hash).
     */
    async executePrivilegedAction(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      directorTaskId: string;
      action: { kind: string; params: Record<string, unknown>; network: string; costLimit: number };
      actionHash: string;
    }): Promise<{ executed: boolean; accepted: boolean }> {
      return guarded(async () => {
        const computed = sha256Hex(canonicalJson(i.action));
        const ok = await withTenant(d.pool, i.tenantId, async (c) => {
          const r = await c.query(
            `SELECT 1 FROM approvals WHERE run_id=$1 AND action_hash=$2 AND decision='approve'
             AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
            [i.runId, computed],
          );
          return r.rowCount === 1;
        });
        if (computed !== i.actionHash || !ok) {
          await d.audit.write({
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            kind: "privileged.blocked",
            reasonCode: "APPROVAL_INVALID",
            detail: { expected: computed, presented: i.actionHash, approvalFound: ok },
          });
          throw new AgentRuntimeError("APPROVAL_INVALID", "no valid approval for this exact action hash", {});
        }
        const out = await runInternalEffect(
          d.pool,
          {
            tenantId: i.tenantId,
            runId: i.runId,
            effectKey: `privileged:${i.runId}:${computed}`,
            kind: "privileged_action",
          },
          async () => {
            const r = await d.canvas.apply({
              tenantId: i.tenantId,
              workspaceId: i.workspaceId,
              runId: i.runId,
              actionHash: computed,
              params: i.action.params,
              directorTaskId: i.directorTaskId,
            });
            if (r.state !== "ok")
              throw new AgentRuntimeError("TOOL_NOT_GRANTED", `privileged action not applied: ${r.state}`, {
                ...(r.detail ?? {}),
              });
            return { state: r.state };
          },
        );
        return { executed: true, accepted: out.accepted };
      });
    },

    async reviewEvidence(i: {
      tenantId: string;
      workspaceId: string;
      runId: string;
      outcomes: ChildOutcome[];
    }): Promise<{
      outcome: "COMPLETE" | "PARTIAL" | "BLOCKED";
      failedBranches: Array<{ task: string; role: string; reasonCode: string }>;
      notes: string[];
    }> {
      const failedBranches: Array<{ task: string; role: string; reasonCode: string }> = [];
      const notes: string[] = [];
      for (const o of i.outcomes) {
        if (o.status === "cancelled") continue;
        if (o.status !== "finished" || !o.result) {
          failedBranches.push({ task: o.task, role: o.role, reasonCode: o.reasonCode ?? "FAILED" });
          continue;
        }
        const v = reviewEvidenceResults([o.result as unknown as RoleResult], {
          runId: i.runId,
          workspaceId: i.workspaceId,
        });
        for (const f of v.failedBranches)
          failedBranches.push({ task: o.task, role: o.role, reasonCode: f.reasonCode });
        notes.push(...v.notes);
      }
      const total = i.outcomes.length;
      const abstained = i.outcomes.some(
        (o) => (o.result as RoleResult | null)?.finding?.status === "cannot_compute",
      );
      const outcome: "COMPLETE" | "PARTIAL" | "BLOCKED" =
        total > 0 && failedBranches.length === total
          ? "BLOCKED"
          : failedBranches.length > 0 || abstained
            ? "PARTIAL"
            : "COMPLETE";
      await d.audit.write({
        tenantId: i.tenantId,
        workspaceId: i.workspaceId,
        runId: i.runId,
        actor: "director",
        kind: "evidence.reviewed",
        detail: { outcome, failedBranches },
      });
      return { outcome, failedBranches, notes };
    },

    /**
     * Interpretation stage: an analyst reads the executed panel results and a skeptic challenges the findings. It never
     * fails the run: any error degrades to an `unavailable` record (the panels are untouched). Cancellation propagates.
     */
    async interpretRun(i: InterpretActivityInput): Promise<InterpretationSummary> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 1000);
      try {
        return await runInterpretation(interpretationDeps(i), { ...i, signal: ctx.cancellationSignal });
      } catch (e) {
        if (e instanceof AbortedError) throw new CancelledFailure("interpretation cancelled");
        const reason = (e instanceof AgentRuntimeError ? e.reasonCode : "INTERPRETATION_ERROR").slice(0, 80);
        await withTenant(d.pool, i.tenantId, (c) =>
          c.query(
            `INSERT INTO run_interpretation (run_id, tenant_id, workspace_id, state, reason, finding_count)
             VALUES ($1,$2,$3,'unavailable',$4,0) ON CONFLICT (run_id) DO NOTHING`,
            [i.runId, i.tenantId, i.workspaceId, reason],
          ),
        ).catch(() => undefined);
        return { state: "unavailable", reason, findingCount: 0 };
      } finally {
        clearInterval(timer);
      }
    },

    /**
     * Interpretation, first half (A37): reads the proposal's panels and runs analyst + skeptic while the owner's approval is
     * pending. Writes and publishes nothing (interpretCommit does, after approval). An error is returned, not thrown, so the
     * workflow falls back to the full `interpretRun` after approval exactly as before.
     */
    async interpretCompute(i: InterpretActivityInput): Promise<ComputedInterpretation | null> {
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat(), 1000);
      try {
        return await computeInterpretation(interpretationDeps(i), { ...i, signal: ctx.cancellationSignal });
      } catch (e) {
        if (e instanceof AbortedError) throw new CancelledFailure("interpretation cancelled");
        return null;
      } finally {
        clearInterval(timer);
      }
    },

    /** Interpretation, second half: records and publishes a computed interpretation (idempotent per run). */
    async interpretCommit(
      i: InterpretActivityInput & { computed: ComputedInterpretation },
    ): Promise<InterpretationSummary> {
      const { computed, ...rest } = i;
      return commitInterpretation(interpretationDeps(rest), rest, computed);
    },

    /** CANVAS_PATCH_REVIEW: every composer proposal must have exactly one ledger row. */
    async reviewCanvasPatch(i: { tenantId: string; runId: string }): Promise<{ proposals: number }> {
      return withTenant(d.pool, i.tenantId, async (c) => {
        const r = await c.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind='panel_proposal'",
          [i.runId],
        );
        return { proposals: Number(r.rows[0]!.n) };
      });
    },

    /** A10: lists external calls that may still complete after cancellation and marks open tasks CANCELLED. */
    async reconcileCancellation(i: { tenantId: string; runId: string }): Promise<{
      inFlight: Array<{ effectKey: string; kind: string; guarantee: string; compensation: string }>;
      cancelledTasks: number;
    }> {
      let cancelled: Array<{ id: string; workspace_id: string }> = [];
      const out = await withTenant(d.pool, i.tenantId, async (c) => {
        const eff = await c.query<{ effect_key: string; kind: string; guarantee: string }>(
          "SELECT effect_key, kind, guarantee FROM agent_side_effects WHERE run_id=$1 AND status='started' AND kind <> 'fault' ORDER BY effect_key",
          [i.runId],
        );
        const t = await c.query<{ id: string; workspace_id: string }>(
          `UPDATE tasks SET status='CANCELLED', updated_at=now() WHERE run_id=$1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL') RETURNING id, workspace_id`,
          [i.runId],
        );
        cancelled = t.rows;
        return {
          inFlight: eff.rows.map((r) => ({
            effectKey: r.effect_key,
            kind: r.kind,
            guarantee: r.guarantee,
            // an inference request already sent cannot be recalled; its result, if it arrives, is never accepted
            compensation:
              r.kind === "inference" ? "none_possible_result_will_be_discarded" : "not_applicable",
          })),
          cancelledTasks: t.rowCount ?? 0,
        };
      });
      // A cancelled task must not keep tool authority: revoke its kernel leases (idempotent).
      for (const t of cancelled)
        await d.leases.revokeTask({
          tenantId: i.tenantId,
          workspaceId: t.workspace_id,
          runId: i.runId,
          taskId: t.id,
        });
      return out;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/**
 * The workflow activities. With `d.cost` set (NEARESIS_COST_CONTROL=1) the work-starting activities are authorised as
 * `workflow_operations` before they run and the rest are counted (see `meterActivities`).
 */
export function createActivities(d: ActivityDeps): ReturnType<typeof createActivitiesRaw> {
  const acts = createActivitiesRaw(d);
  if (!d.cost) return acts;
  const cost = d.cost;
  return meterActivities(acts as never, cost, {
    attemptId: () => {
      try {
        const info = Context.current().info;
        return `${info.workflowExecution?.workflowId}:${info.activityId}:${info.attempt}`;
      } catch {
        return randomUUID();
      }
    },
  }) as ReturnType<typeof createActivitiesRaw>;
}
