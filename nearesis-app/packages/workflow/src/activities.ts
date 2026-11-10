import { randomUUID } from "node:crypto";
import { ApplicationFailure, Context } from "@temporalio/activity";
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
  type AuditSink,
  type Policy,
  type RoleResult,
} from "@nearesis/agent-runtime";
import type { ChildOutcome, ChildSpec, InvestigationInput, PlanView, PolicyView } from "./types.ts";

export interface ActivityDeps {
  /** App-role pool (nearesis_app, search_path=runtime). */
  pool: pg.Pool;
  /** Connection string for the LangGraph Postgres checkpointer (app role). Checkpointing is off when absent. */
  appUrl?: string;
  policy: Policy;
  audit: AuditSink;
  gateway: ToolGateway;
  provider: InferenceProvider;
  model?: string;
  /** Capabilities the investigation may delegate (root task grant). */
  investigationGrant: string[];
  /** Test-only transient fault points: returns true once for (point, scenario). */
  faultAt?: (point: string, scenario: string | undefined) => boolean;
  now?: () => number;
}

const model = (d: ActivityDeps) => d.model ?? "scripted-1";

/** Policy decisions become non-retryable ApplicationFailures typed by reasonCode (brief §10). */
export function toApplicationFailure(e: unknown): unknown {
  if (e instanceof AgentRuntimeError)
    return ApplicationFailure.nonRetryable(e.message, e.reasonCode, e.detail);
  return e;
}

export const directorBudget = { tokens: 20000, toolCalls: 50, usd: 2 };

export function createActivities(d: ActivityDeps) {
  const roles = loadRoles();
  const supervisor = new Supervisor(d.pool, d.policy, d.audit, roles);
  const meter = new ToolCallMeter(d.pool, d.policy, d.audit);
  const now = d.now ?? (() => Date.now());

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

  return {
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
            `INSERT INTO runs (id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, scenario, state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED') ON CONFLICT (id) DO NOTHING`,
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
            ],
          ),
        );
        const root = await supervisor.createRootTask({
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          investigationId: i.investigationId,
          budgetId: i.budgetId,
          snapshotRef: i.snapshotRef,
          role: "director",
          capabilities: [...new Set([...d.investigationGrant, ...roles.get("director")!.allowedTools])],
          budget: directorBudget,
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
        const saver = d.appUrl ? openCheckpointer(d.appUrl) : undefined;
        try {
          const inference = new LedgerInference(d.provider, d.pool, supervisor, {
            tenantId: i.tenantId,
            workspaceId: i.workspaceId,
            runId: i.runId,
            budgetId: i.budgetId,
            taskId: i.directorTaskId,
            model: model(d),
            ...(Context.current().cancellationSignal ? { signal: Context.current().cancellationSignal } : {}),
          });
          const graph = buildDirectorGraph({
            mode: "plan",
            question: i.question,
            taskId: i.directorTaskId,
            roles,
            inference,
            heartbeat: () => Context.current().heartbeat(),
            ...(saver ? { checkpointer: saver } : {}),
            discoverMetrics: async (metrics, key) => {
              const req: ExecutionRequest = {
                requestId: randomUUID(),
                idempotencyKey: key,
                tenantId: i.tenantId,
                workspaceId: i.workspaceId,
                actor: { kind: "agent", actorId: i.directorTaskId, parentRunId: i.runId },
                capability: "semantic.discover@1",
                input: { metrics },
                deadlineMs: 60_000,
                trace: { traceId: `${i.runId}/${i.directorTaskId}`, researchRunId: i.runId },
              };
              const r = await d.gateway.invoke(
                { kind: "service", actorId: i.directorTaskId, orgId: i.tenantId, parentRunId: i.runId },
                req,
              );
              const p = (r.payload ?? { available: [], missing: metrics }) as {
                available: string[];
                missing: string[];
              };
              return p;
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
        const hypothesisId = `${i.child.task}|${i.child.inputSnapshot}`;
        const r = await supervisor.spawn(
          {
            role: i.child.role as never,
            objective: i.child.objective,
            workspaceId: i.workspaceId,
            allowedCapabilities: i.child.capabilities,
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
      const timer = setInterval(() => ctx.heartbeat(), 1000);
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
        });
        const inference = new LedgerInference(d.provider, d.pool, supervisor, {
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          budgetId: i.budgetId,
          taskId: i.taskId,
          model: model(d),
          signal: ctx.cancellationSignal,
        });
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
        if (e instanceof AbortedError) throw e;
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
            const req: ExecutionRequest = {
              requestId: randomUUID(),
              idempotencyKey: `priv-${computed}`,
              tenantId: i.tenantId,
              workspaceId: i.workspaceId,
              actor: { kind: "agent", actorId: i.directorTaskId, parentRunId: i.runId },
              capability: "canvas.patch@1",
              input: i.action.params,
              deadlineMs: 60_000,
              trace: { traceId: `${i.runId}/priv`, researchRunId: i.runId },
            };
            const r = await d.gateway.invoke(
              { kind: "service", actorId: i.directorTaskId, orgId: i.tenantId, parentRunId: i.runId },
              req,
            );
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
      const verdict = reviewEvidenceResults(
        i.outcomes.filter((o) => o.result).map((o) => o.result as unknown as RoleResult),
        { runId: i.runId, workspaceId: i.workspaceId },
      );
      // branches that never produced a result are failed branches too, named by task
      const failed = i.outcomes
        .filter((o) => o.status !== "finished" && o.status !== "cancelled")
        .map((o) => ({ task: o.task, role: o.role, reasonCode: o.reasonCode ?? "FAILED" }));
      const byTask = new Map<string, { task: string; role: string; reasonCode: string }>();
      for (const f of failed) byTask.set(`${f.role}:${f.task}`, f);
      for (const f of verdict.failedBranches) {
        const match = i.outcomes.find(
          (o) => (o.result as RoleResult | null)?.role === f.role && o.status === "finished",
        );
        byTask.set(`${f.role}:${match?.task ?? f.task}`, { ...f, task: match?.task ?? f.task });
      }
      const failedBranches = [...byTask.values()];
      const total = i.outcomes.length;
      const abstained = i.outcomes.some(
        (o) => (o.result as RoleResult | null)?.finding?.status === "cannot_compute",
      );
      const outcome =
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
      return { outcome, failedBranches, notes: verdict.notes };
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
      return withTenant(d.pool, i.tenantId, async (c) => {
        const eff = await c.query<{ effect_key: string; kind: string; guarantee: string }>(
          "SELECT effect_key, kind, guarantee FROM agent_side_effects WHERE run_id=$1 AND status='started' AND kind <> 'fault' ORDER BY effect_key",
          [i.runId],
        );
        const t = await c.query(
          `UPDATE tasks SET status='CANCELLED', updated_at=now() WHERE run_id=$1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
          [i.runId],
        );
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
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
