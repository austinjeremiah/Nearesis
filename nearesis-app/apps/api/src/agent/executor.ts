import { CreditsExhausted, KernelError, exhaustedDetails, usdNumberToMicro } from "@nearesis/kernel";
import type { Db, Tx } from "@nearesis/kernel";
import type { AssistantModelPort } from "@nearesis/workflow";
import { chargeModelUsd, usdCreditsOf } from "../usd-credits-api.ts";
import { lockPlan } from "./test-plan.ts";
import type { TaskTestPlan } from "./test-plan.ts";
import { ApiError, call } from "./api-client.ts";
import type { AgentApi, AgentUser } from "./api-client.ts";
import { AgentStore } from "./store.ts";
import type { StepRow } from "./store.ts";
import { DEFAULT_LIMITS, HANDLERS, StepFail, awaitProof, recordProofCosts } from "./steps.ts";
import type { CostReport, Env, Limits, Outcome } from "./steps.ts";
import type { ConsentKey, StepError, StepResult, StepWaiting, TaskCtx } from "./types.ts";

export interface ExecutorDeps {
  db: Db;
  store: AgentStore;
  api: AgentApi;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  limits?: Partial<Limits>;
  /** The model a step may call (one call, to resolve the two series of the test plan); charged to the user's credits. */
  model?: (user: AgentUser) => Promise<AssistantModelPort>;
  /** Called when a task finishes `completed`: post the summary message into the thread. */
  onCompleted?: (
    user: AgentUser,
    task: { id: string; threadId: string; title: string; result: StepResult },
  ) => Promise<void>;
}

const userOf = (u: AgentUser) => ({ orgId: u.orgId, userId: u.userId });
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const stepErrorOf = (e: unknown): StepError => {
  if (e instanceof StepFail)
    return {
      reasonCode: e.reasonCode,
      message: e.message,
      retryable: e.retryable,
      ...(e.details ? { details: e.details } : {}),
    };
  if (e instanceof ApiError) return e.toStepError();
  if (e instanceof CreditsExhausted)
    return {
      reasonCode: e.reasonCode,
      message: e.message,
      retryable: false,
      details: exhaustedDetails(e.facts),
    };
  if (e instanceof KernelError)
    return {
      reasonCode: e.reasonCode,
      message: e.message,
      retryable: e.opts.retryable ?? false,
      ...(e.opts.detailsObject ? { details: e.opts.detailsObject } : {}),
    };
  return { reasonCode: "STEP_FAILED", message: "The step failed unexpectedly.", retryable: true };
};

/**
 * Runs tasks in the API process. One task per user at a time (a partial unique index backs it). A step calls the public
 * route in-process as the user; done steps are never repeated; a failure stops the task and is retryable from that step.
 */
export class Executor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly limits: Limits;

  constructor(private readonly d: ExecutorDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...(d.limits ?? {}) };
  }

  /** Resolves when no drive loops are active (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }
  isDriving(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Starts the drive loop in the background (no-op if already driving). */
  drive(user: AgentUser, taskId: string): void {
    if (this.active.has(taskId)) return;
    const p = this.loop(user, taskId)
      .catch(() => undefined)
      .finally(() => this.active.delete(taskId));
    this.active.set(taskId, p);
  }

  private async taskState(user: AgentUser, taskId: string): Promise<string | null> {
    return this.d.store.inTx(userOf(user), async (tx) => {
      const r = await tx.query<{ state: string }>("SELECT state FROM agent_tasks WHERE id = $1", [taskId]);
      return r.rows[0]?.state ?? null;
    });
  }

  private makeEnv(
    user: AgentUser,
    taskId: string,
    threadId: string,
    step: StepRow,
    ctx: TaskCtx,
    startedAtMs: number,
    testPlan: TaskTestPlan | null = null,
  ): Env {
    const ctxU = userOf(user);
    const store = this.d.store;
    let lastProgress: string | null = step.progress;
    const add = (tx: Tx, usd: string, calls: number, creditsUsd: string) =>
      Promise.all([
        tx.query(
          "UPDATE agent_task_steps SET model_usd = model_usd + $3, model_calls = model_calls + $4, credits_usd = credits_usd + $5 WHERE task_id=$1 AND idx=$2",
          [taskId, step.idx, usd, calls, creditsUsd],
        ),
        tx.query(
          "UPDATE agent_tasks SET model_usd = model_usd + $2, model_calls = model_calls + $3, credits_charged_usd = credits_charged_usd + $4 WHERE id=$1",
          [taskId, usd, calls, creditsUsd],
        ),
      ]);
    const env: Env = {
      user,
      taskId,
      threadId,
      idx: step.idx,
      attempt: Number((step.params as { _attempt?: number })._attempt ?? 0),
      params: Object.fromEntries(Object.entries(step.params).filter(([k]) => !k.startsWith("_"))),
      ctx,
      testPlan,
      startedAtMs,
      now: this.now,
      sleep: this.sleep,
      api: this.d.api,
      limits: this.limits,
      key: (suffix) => `agent:${taskId}:${step.idx}${suffix ? `:${suffix}` : ""}`,
      patchCtx: async (p) => {
        Object.assign(ctx, p);
        await store.inTx(ctxU, (tx) =>
          tx.query("UPDATE agent_tasks SET ctx = ctx || $2::jsonb WHERE id = $1", [
            taskId,
            JSON.stringify(p),
          ]),
        );
      },
      setWorkspace: async (id) => {
        ctx.workspaceId = id;
        await store.inTx(ctxU, async (tx) => {
          await tx.query("UPDATE agent_tasks SET workspace_id = $2, ctx = ctx || $3::jsonb WHERE id = $1", [
            taskId,
            id,
            JSON.stringify({ workspaceId: id }),
          ]);
          await tx.query("UPDATE agent_threads SET workspace_id = $2, updated_at = now() WHERE id = $1", [
            threadId,
            id,
          ]);
        });
      },
      progress: async (text) => {
        const t = text.slice(0, 300);
        if (t === lastProgress) return;
        lastProgress = t;
        await store.inTx(ctxU, (tx) =>
          tx.query(
            "UPDATE agent_task_steps SET progress = $3 WHERE task_id=$1 AND idx=$2 AND state='running'",
            [taskId, step.idx, t],
          ),
        );
      },
      cancelled: async () => {
        const s = await this.taskState(user, taskId);
        return s === null || s === "cancelled";
      },
      cost: async (c: CostReport) => {
        const inserted = await store.addCost(ctxU, {
          threadId,
          taskId,
          stepIdx: step.idx,
          stepKey: step.key,
          label: c.label,
          unit: "usd",
          category: c.category ?? "model",
          detail: c.detail ?? null,
          amount: c.amount,
          txHash: c.txHash ?? null,
          sourceKey: c.sourceKey,
        });
        if (!inserted) return;
        const onChain = c.category === "onchain";
        await store.inTx(ctxU, (tx) =>
          add(tx, onChain ? "0" : c.amount, onChain ? 0 : (c.calls ?? 0), onChain ? c.amount : "0"),
        );
      },
      model: this.d.model ? async () => this.d.model!(user) : null,
      chargeModel: async (usd, calls, label) => {
        if (!(usd > 0) || usdNumberToMicro(usd) <= 0n) return;
        await chargeModelUsd(this.d.db, ctxU, usd, {
          refKind: "agent_step",
          refId: `${taskId}:${step.idx}:${label}`,
          detail: { step: step.key, label, modelCalls: calls },
        });
      },
      requireCredits: async () => {
        await usdCreditsOf(this.d.db).require(ctxU);
      },
      setHeld: async (usd) => {
        await store.inTx(ctxU, (tx) =>
          tx.query("UPDATE agent_tasks SET credits_held_usd = $2 WHERE id = $1", [taskId, usd]),
        );
      },
    };
    return env;
  }

  private async loop(user: AgentUser, taskId: string): Promise<void> {
    const ctxU = userOf(user);
    for (;;) {
      const raw = await this.d.store.loadRaw(ctxU, taskId);
      if (!raw || TERMINAL.has(raw.task.state) || raw.task.state === "proposed") return;
      const step = raw.steps.find(
        (s) => s.state === "pending" || s.state === "running" || s.state === "waiting_user",
      );
      if (!step) {
        await this.complete(user, raw.task.id, raw.task.thread_id, raw.task.title, raw.steps);
        return;
      }
      const startedAtMs = step.started_at ? new Date(step.started_at).getTime() : this.now();
      const ok = await this.d.store.inTx(ctxU, async (tx) => {
        const t = await tx.query<{ state: string }>("SELECT state FROM agent_tasks WHERE id=$1 FOR UPDATE", [
          taskId,
        ]);
        if (!t.rows[0] || TERMINAL.has(t.rows[0].state)) return false;
        await tx.query("UPDATE agent_tasks SET state='running', current_step=$2 WHERE id=$1", [
          taskId,
          step.idx,
        ]);
        await tx.query(
          "UPDATE agent_task_steps SET state='running', started_at = COALESCE(started_at, now()), waiting=NULL, error=NULL, finished_at=NULL WHERE task_id=$1 AND idx=$2",
          [taskId, step.idx],
        );
        return true;
      });
      if (!ok) return;
      const ctx: TaskCtx = { ...(raw.task.ctx ?? {}) };
      const env = this.makeEnv(
        user,
        taskId,
        raw.task.thread_id,
        step,
        ctx,
        startedAtMs,
        raw.task.test_plan ?? null,
      );
      const handler = HANDLERS[step.key];
      let outcome: Outcome;
      try {
        if (!handler) throw new StepFail("UNKNOWN_STEP", `Unknown step ${step.key}.`, false);
        outcome = await handler(env);
      } catch (e) {
        if (e instanceof StepFail && e.reasonCode === "CANCELLED") return;
        await this.failStep(user, taskId, step.idx, stepErrorOf(e));
        return;
      }
      const stillActive = await this.d.store.inTx(ctxU, async (tx) => {
        const t = await tx.query<{ state: string }>("SELECT state FROM agent_tasks WHERE id=$1 FOR UPDATE", [
          taskId,
        ]);
        if (!t.rows[0] || t.rows[0].state === "cancelled") return false;
        if (outcome.kind === "waiting") {
          await tx.query(
            "UPDATE agent_task_steps SET state='waiting_user', waiting=$3::jsonb, progress=$4 WHERE task_id=$1 AND idx=$2",
            [taskId, step.idx, JSON.stringify(outcome.waiting satisfies StepWaiting), outcome.progress],
          );
          await tx.query("UPDATE agent_tasks SET state='waiting_user', current_step=$2 WHERE id=$1", [
            taskId,
            step.idx,
          ]);
        } else {
          await tx.query(
            "UPDATE agent_task_steps SET state='done', result=$3::jsonb, progress=NULL, waiting=NULL, error=NULL, finished_at=now() WHERE task_id=$1 AND idx=$2",
            [
              taskId,
              step.idx,
              // every finished step carries the ids it worked on, so a client can load the real objects
              JSON.stringify({
                ...outcome.result,
                refs: {
                  ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
                  ...(ctx.runId ? { runId: ctx.runId } : {}),
                  ...(ctx.capsuleId ? { capsuleId: ctx.capsuleId } : {}),
                  ...(ctx.proofId ? { proofId: ctx.proofId } : {}),
                  ...(ctx.publicationId ? { publicationId: ctx.publicationId } : {}),
                  ...(ctx.hypothesisId ? { hypothesisId: ctx.hypothesisId } : {}),
                  ...(ctx.thesisId ? { thesisId: ctx.thesisId } : {}),
                  ...(outcome.result.refs ?? {}),
                },
              }),
            ],
          );
          await tx.query("UPDATE agent_tasks SET current_step=$2 WHERE id=$1", [taskId, step.idx + 1]);
        }
        return true;
      });
      if (!stillActive || outcome.kind === "waiting") return;
    }
  }

  private async failStep(user: AgentUser, taskId: string, idx: number, error: StepError): Promise<void> {
    await this.d.store.inTx(userOf(user), async (tx) => {
      const t = await tx.query<{ state: string }>("SELECT state FROM agent_tasks WHERE id=$1 FOR UPDATE", [
        taskId,
      ]);
      if (!t.rows[0] || t.rows[0].state === "cancelled") return;
      await tx.query(
        "UPDATE agent_task_steps SET state='failed', error=$3::jsonb, progress=NULL, waiting=NULL, finished_at=now() WHERE task_id=$1 AND idx=$2",
        [taskId, idx, JSON.stringify(error)],
      );
      await tx.query(
        "UPDATE agent_tasks SET state='failed', current_step=$2, finished_at=now() WHERE id=$1",
        [taskId, idx],
      );
    });
  }

  private async complete(
    user: AgentUser,
    taskId: string,
    threadId: string,
    title: string,
    steps: StepRow[],
  ): Promise<void> {
    // the thesis leads: its links come first and its own summary is part of the finished message
    const lead = [...steps].reverse().find((s) => s.key === "thesis.build" && s.state === "done");
    const ordered = lead ? [lead, ...steps.filter((s) => s !== lead)] : steps;
    const items = ordered.flatMap((s) =>
      (s.result?.items ?? []).map((i) => ({ ...i, label: `${s.title}: ${i.label}` })),
    );
    const result: StepResult = {
      summary:
        `Finished "${title}": ${steps.filter((s) => s.state === "done").length} of ${steps.length} steps done.` +
        (lead?.result?.summary ? ` ${lead.result.summary}` : ""),
      items: items.slice(0, 60),
    };
    const done = await this.d.store.inTx(userOf(user), async (tx) => {
      const r = await tx.query(
        "UPDATE agent_tasks SET state='completed', finished_at=now(), credits_held_usd=0 WHERE id=$1 AND state IN ('running','waiting_user')",
        [taskId],
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (done) await this.d.onCompleted?.(user, { id: taskId, threadId, title, result });
  }

  // ---------------------------------------------------------------- commands
  async start(user: AgentUser, taskId: string, consent: ConsentKey[]): Promise<void> {
    const ctxU = userOf(user);
    try {
      await this.d.store.inTx(ctxU, async (tx) => {
        const t = await tx.query<{
          state: string;
          consent_required: Array<{ key: ConsentKey }>;
          test_plan: TaskTestPlan | null;
        }>("SELECT state, consent_required, test_plan FROM agent_tasks WHERE id=$1 FOR UPDATE", [taskId]);
        const row = t.rows[0];
        if (!row) throw new KernelError("NOT_FOUND", "TASK_NOT_FOUND", "Task not found.");
        if (row.state !== "proposed")
          throw new KernelError("STALE_VERSION", "TASK_NOT_PROPOSED", `The task is already ${row.state}.`);
        const missing = row.consent_required.map((c) => c.key).filter((k) => !consent.includes(k));
        if (missing.length)
          throw new KernelError(
            "VALIDATION_FAILED",
            "CONSENT_MISSING",
            `Consent is missing for: ${missing.join(", ")}.`,
            {
              details: missing.map((issue) => ({ path: "consent", issue })),
            },
          );
        // Start locks a written test plan: the time and the hash of its canonical fields, before anything runs
        const locked = row.test_plan ? lockPlan(row.test_plan, new Date(this.now())) : null;
        await tx.query(
          "UPDATE agent_tasks SET state='running', consent_given=$2::jsonb, started_at=now(), current_step=0, test_plan=$3::jsonb WHERE id=$1",
          [taskId, JSON.stringify(consent), locked ? JSON.stringify(locked) : null],
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new KernelError(
          "STALE_VERSION",
          "TASK_ALREADY_RUNNING",
          "Another task is already running for you.",
        );
      throw e;
    }
    this.drive(user, taskId);
  }

  async retry(user: AgentUser, taskId: string, acknowledge?: string[]): Promise<void> {
    const ctxU = userOf(user);
    try {
      await this.d.store.inTx(ctxU, async (tx) => {
        const t = await tx.query<{ state: string }>("SELECT state FROM agent_tasks WHERE id=$1 FOR UPDATE", [
          taskId,
        ]);
        if (!t.rows[0]) throw new KernelError("NOT_FOUND", "TASK_NOT_FOUND", "Task not found.");
        if (t.rows[0].state !== "failed")
          throw new KernelError("STALE_VERSION", "TASK_NOT_FAILED", "Only a failed task can be retried.");
        const f = await tx.query<{ idx: number; key: string; error: StepError | null }>(
          "SELECT idx, key, error FROM agent_task_steps WHERE task_id=$1 AND state='failed' ORDER BY idx LIMIT 1",
          [taskId],
        );
        const step = f.rows[0];
        if (!step)
          throw new KernelError("STALE_VERSION", "NO_FAILED_STEP", "There is no failed step to retry.");
        if (
          step.error &&
          step.error.retryable === false &&
          !(step.key === "capsule.publish" && acknowledge?.length)
        )
          throw new KernelError(
            "STALE_VERSION",
            "STEP_NOT_RETRYABLE",
            "This step cannot be retried; start a new task.",
          );
        const ack = step.key === "capsule.publish" && acknowledge?.length ? acknowledge : null;
        await tx.query(
          `UPDATE agent_task_steps SET state='pending', error=NULL, progress=NULL, finished_at=NULL,
                  params = params || jsonb_build_object('_attempt', COALESCE((params->>'_attempt')::int, 0) + 1)
                                  || CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('acknowledge', $3::jsonb) END
            WHERE task_id=$1 AND idx=$2`,
          [taskId, step.idx, ack ? JSON.stringify(ack) : null],
        );
        await tx.query("UPDATE agent_tasks SET state='running', finished_at=NULL WHERE id=$1", [taskId]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new KernelError(
          "STALE_VERSION",
          "TASK_ALREADY_RUNNING",
          "Another task is already running for you.",
        );
      throw e;
    }
    this.drive(user, taskId);
  }

  /** Forwards the user's decision on the waiting approval to the run route, then resumes (approve) or ends the task (reject). */
  async decide(user: AgentUser, taskId: string, idx: number, decision: "approve" | "reject"): Promise<void> {
    const ctxU = userOf(user);
    const raw = await this.d.store.loadRaw(ctxU, taskId);
    if (!raw) throw new KernelError("NOT_FOUND", "TASK_NOT_FOUND", "Task not found.");
    const step = raw.steps.find((s) => s.idx === idx);
    if (!step) throw new KernelError("NOT_FOUND", "STEP_NOT_FOUND", "Step not found.");
    if (raw.task.state !== "waiting_user" || step.state !== "waiting_user" || !step.waiting)
      throw new KernelError("STALE_VERSION", "STEP_NOT_WAITING", "This step is not waiting for a decision.");
    const w = step.waiting;
    const ap = await call<{ approvals?: Array<Record<string, unknown>> }>(
      this.d.api,
      user,
      "GET",
      `/v1/runs/${w.runId}/approvals`,
    ).catch((e) => {
      if (e instanceof ApiError) throw new KernelError("UPSTREAM_DEGRADED", e.reasonCode, e.message);
      throw e;
    });
    const target = (ap.body.approvals ?? []).find(
      (a) => String(a.approvalId) === w.approvalId && a.status === "pending",
    );
    if (!target)
      throw new KernelError("STALE_VERSION", "APPROVAL_NOT_PENDING", "That approval is no longer pending.");
    await call(
      this.d.api,
      user,
      "POST",
      `/v1/runs/${w.runId}/approvals/${w.approvalId}`,
      { decision, actionHash: String(target.actionHash) },
      { "idempotency-key": `agent:${taskId}:${idx}:a${w.approvalId}:${decision}` },
    ).catch((e) => {
      if (e instanceof ApiError) throw new KernelError("UPSTREAM_DEGRADED", e.reasonCode, e.message);
      throw e;
    });
    if (decision === "reject") {
      await this.failStep(user, taskId, idx, {
        reasonCode: "APPROVAL_REJECTED",
        message: `You rejected the ${w.approvalKind} approval, so the run cannot continue.`,
        retryable: false,
      });
      return;
    }
    await this.d.store.inTx(ctxU, async (tx) => {
      await tx.query(
        "UPDATE agent_task_steps SET state='pending', waiting=NULL WHERE task_id=$1 AND idx=$2",
        [taskId, idx],
      );
      await tx.query("UPDATE agent_tasks SET state='running' WHERE id=$1 AND state='waiting_user'", [taskId]);
    });
    this.drive(user, taskId);
  }

  /** Cancels the task, cancels its run through the run route, and lets an in-flight proof settle its own credits. */
  async cancel(user: AgentUser, taskId: string): Promise<void> {
    const ctxU = userOf(user);
    const info = await this.d.store.inTx(ctxU, async (tx) => {
      const t = await tx.query<{ state: string; ctx: TaskCtx; thread_id: string }>(
        "SELECT state, ctx, thread_id FROM agent_tasks WHERE id=$1 FOR UPDATE",
        [taskId],
      );
      const row = t.rows[0];
      if (!row) throw new KernelError("NOT_FOUND", "TASK_NOT_FOUND", "Task not found.");
      if (TERMINAL.has(row.state))
        throw new KernelError("STALE_VERSION", "TASK_NOT_CANCELLABLE", `The task is already ${row.state}.`);
      const active = await tx.query<{ idx: number; key: string; state: string }>(
        "SELECT idx, key, state FROM agent_task_steps WHERE task_id=$1 AND state IN ('running','waiting_user')",
        [taskId],
      );
      await tx.query(
        `UPDATE agent_task_steps SET state='skipped', progress=NULL, waiting=NULL, finished_at=now(),
                error = CASE WHEN state IN ('running','waiting_user') THEN '{"reasonCode":"CANCELLED","message":"Cancelled by you.","retryable":false}'::jsonb ELSE error END
          WHERE task_id=$1 AND state IN ('pending','running','waiting_user')`,
        [taskId],
      );
      await tx.query("UPDATE agent_tasks SET state='cancelled', finished_at=now() WHERE id=$1", [taskId]);
      return { ctx: row.ctx, threadId: row.thread_id, active: active.rows };
    });
    // The run keeps going unless it is cancelled through its own route.
    const runStep = info.active.find((s) => s.key === "run.await");
    if (runStep && info.ctx.runId) {
      try {
        const run = await call<{ version?: number; terminal?: boolean }>(
          this.d.api,
          user,
          "GET",
          `/v1/runs/${info.ctx.runId}`,
        );
        if (!run.body.terminal)
          await call(this.d.api, user, "POST", `/v1/runs/${info.ctx.runId}/cancel`, {
            expectedVersion: run.body.version ?? 0,
          });
      } catch {
        /* best effort: the task is cancelled either way and the run's own state stays visible in the workspace */
      }
    }
    // A proof job cannot be aborted once submitted: it settles its own hold; record what it cost when it does.
    const proofStep = info.active.find((s) => s.key === "capsule.prove");
    if (proofStep && info.ctx.proofId)
      this.settleDetached(user, taskId, info.threadId, proofStep.idx, info.ctx.proofId);
  }

  private settleDetached(
    user: AgentUser,
    taskId: string,
    threadId: string,
    idx: number,
    proofId: string,
  ): void {
    const p = (async () => {
      const raw = await this.d.store.loadRaw(userOf(user), taskId);
      const step = raw?.steps.find((s) => s.idx === idx);
      if (!raw || !step) return;
      const env = this.makeEnv(
        user,
        taskId,
        threadId,
        step,
        { ...raw.task.ctx },
        this.now(),
        raw.task.test_plan ?? null,
      );
      env.cancelled = async () => false;
      try {
        const proof = await awaitProof(env, proofId);
        await recordProofCosts(env, proofId, proof);
      } catch {
        /* the credits stay held until the proof settles; the ledger remains the source of truth */
      }
    })().finally(() => this.active.delete(`settle:${proofId}`));
    this.active.set(`settle:${proofId}`, p);
  }

  /**
   * Startup recovery (contract): a task found running gets its running step failed with INTERRUPTED (retryable); a task
   * waiting for the user stays waiting (the approval route resumes it). Pending replies whose work died are marked failed.
   */
  async recover(): Promise<{ tasks: number; messages: number }> {
    const rows = await this.d.db.txGlobal(async (tx) => {
      const r = await tx.query<{ kind: string; id: string; org_id: string; user_id: string; state: string }>(
        "SELECT kind, id, org_id, user_id, state FROM agent_recovery_scan()",
      );
      return r.rows;
    });
    let tasks = 0;
    let messages = 0;
    for (const r of rows) {
      const ctxU = { orgId: r.org_id, userId: r.user_id };
      if (r.kind === "message") {
        await this.d.store.inTx(ctxU, (tx) =>
          tx.query(
            `UPDATE agent_messages SET state='failed', kind='notice', text='The reply was interrupted by a restart. Send the message again.',
                    error='{"reasonCode":"INTERRUPTED","message":"The server restarted while this reply was being prepared."}'::jsonb
              WHERE id=$1 AND state='pending'`,
            [r.id],
          ),
        );
        messages++;
      } else if (r.state === "running") {
        await this.d.store.inTx(ctxU, async (tx) => {
          const s = await tx.query<{ idx: number }>(
            "SELECT idx FROM agent_task_steps WHERE task_id=$1 AND state='running' ORDER BY idx LIMIT 1",
            [r.id],
          );
          const idx = s.rows[0]?.idx;
          if (idx !== undefined)
            await tx.query(
              `UPDATE agent_task_steps SET state='failed', progress=NULL, finished_at=now(),
                      error='{"reasonCode":"INTERRUPTED","message":"The server restarted while this step was running. Retry resumes from here.","retryable":true}'::jsonb
                WHERE task_id=$1 AND idx=$2`,
              [r.id, idx],
            );
          await tx.query(
            "UPDATE agent_tasks SET state='failed', finished_at=now() WHERE id=$1 AND state='running'",
            [r.id],
          );
        });
        tasks++;
      }
    }
    return { tasks, messages };
  }
}
