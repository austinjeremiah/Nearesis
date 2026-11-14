import { KernelError, guardInference, isGuardedInference, modelPolicyFromEnv } from "@nearesis/kernel";
import type { Db, Session } from "@nearesis/kernel";
import type { InferenceProvider } from "@nearesis/contracts";
import {
  assistantModelOver,
  assistantProviderFromEnv,
  externalModelSpend,
  readGlobalSpend,
} from "@nearesis/workflow";
import type { AssistantModelPort, AssistantSpendGate } from "@nearesis/workflow";
import { ApiError, apiErrorOf, call } from "./api-client.ts";
import type { AgentApi, AgentUser } from "./api-client.ts";
import { consentFor, detailOf, modelUsdMaxFor, titleOf } from "./catalog.ts";
import type { PlannedStep } from "./catalog.ts";
import { Executor } from "./executor.ts";
import { DIRECT_LOOKUPS, planMessage } from "./planner.ts";
import type { DirectLookup } from "./planner.ts";
import { AgentStore } from "./store.ts";
import type { MessageView, StepResult, StepResultItem } from "./types.ts";

export interface AgentServiceOptions {
  db: Db;
  api: AgentApi;
  /** Test seam: the planner's model. Default: the configured model through the guarded provider and the global USD ceiling. */
  model?: (user: AgentUser & { session?: Session }) => Promise<AssistantModelPort>;
  inference?: { provider: InferenceProvider; model: string };
  externalModelSpend?: () => Promise<number>;
  executor?: Partial<ConstructorParameters<typeof Executor>[0]>;
  now?: () => Date;
  /** Messages per user per window (default 20 per minute). */
  messagesPerWindow?: number;
  windowMs?: number;
}

const ctxOf = (u: AgentUser) => ({ orgId: u.orgId, userId: u.userId });

/** The model port every planner call goes through: same guard, same spend gate, same global USD ceiling as the quick answer. */
export function makeModelFactory(o: {
  db: Db;
  inference?: { provider: InferenceProvider; model: string };
  externalModelSpend?: () => Promise<number>;
}): (u: AgentUser) => Promise<AssistantModelPort> {
  const external = o.externalModelSpend ?? externalModelSpend();
  return async (u) => {
    const chosen = o.inference ?? assistantProviderFromEnv();
    const provider = isGuardedInference(chosen.provider)
      ? chosen.provider
      : guardInference(chosen.provider, modelPolicyFromEnv());
    if (provider.id === "mock" && !o.inference)
      throw new KernelError("UPSTREAM_DEGRADED", "MODEL_NOT_CONFIGURED", "No live model is configured.", {
        retryable: false,
      });
    const read = () =>
      o.db.tx(ctxOf(u), async (tx) => {
        await tx.query("SELECT set_config('search_path', 'runtime, public', true)");
        const g = await readGlobalSpend(tx, new Date(), external);
        return { committed: g.committedUsd, ceiling: g.ceilingUsd };
      });
    const first = await read();
    const gate: AssistantSpendGate = {
      ceilingUsd: first.ceiling,
      committedUsd: async () => (await read()).committed,
    };
    return assistantModelOver(provider, chosen.model, gate);
  };
}

const item = (label: string, value: string, href: string | null = null): StepResultItem => ({
  label,
  value,
  href,
});
type Obj = Record<string, unknown>;

export class AgentService {
  readonly store: AgentStore;
  readonly executor: Executor;
  readonly api: AgentApi;
  private readonly modelFor: (u: AgentUser) => Promise<AssistantModelPort>;
  private readonly inflight = new Set<Promise<void>>();
  private readonly buckets = new Map<string, { start: number; n: number }>();

  constructor(private readonly o: AgentServiceOptions) {
    this.store = new AgentStore(o.db);
    this.api = o.api;
    this.modelFor =
      o.model ??
      makeModelFactory({
        db: o.db,
        ...(o.inference ? { inference: o.inference } : {}),
        ...(o.externalModelSpend ? { externalModelSpend: o.externalModelSpend } : {}),
      });
    this.executor = new Executor({
      db: o.db,
      store: this.store,
      api: o.api,
      ...(o.executor ?? {}),
      onCompleted: async (user, t) => {
        await this.store.addMessage(ctxOf(user), {
          threadId: t.threadId,
          role: "assistant",
          state: "ready",
          kind: "result",
          text: t.result.summary,
          taskId: t.id,
        });
        // the structured result goes on the same message
        await this.o.db.tx(ctxOf(user), (tx) =>
          tx.query(
            `UPDATE agent_messages SET result = $2::jsonb WHERE id = (SELECT id FROM agent_messages WHERE task_id=$1 AND kind='result' ORDER BY seq DESC LIMIT 1)`,
            [t.id, JSON.stringify(t.result)],
          ),
        );
        await this.store.touchThread(ctxOf(user), t.threadId);
      },
    });
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await this.executor.idle();
  }

  private throttle(userId: string): number | null {
    const windowMs = this.o.windowMs ?? 60_000;
    const limit = this.o.messagesPerWindow ?? 20;
    const t = Date.now();
    let b = this.buckets.get(userId);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      this.buckets.set(userId, b);
    }
    b.n++;
    if (this.buckets.size > 5000)
      for (const [k, v] of this.buckets) if (t - v.start >= windowMs) this.buckets.delete(k);
    return b.n <= limit ? null : Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
  }

  /** POST /threads/:id/messages: store the user message and a pending reply, then fill the reply in the background. */
  async postMessage(user: AgentUser, threadId: string, text: string, workspaceId?: string) {
    const ctx = ctxOf(user);
    const thread = await this.store.getThread(ctx, threadId);
    if (!thread) throw new KernelError("NOT_FOUND", "THREAD_NOT_FOUND", "Thread not found.");
    const wait = this.throttle(user.userId);
    if (wait !== null)
      throw new KernelError("RATE_LIMITED", "TOO_MANY_MESSAGES", "Too many messages in a short time.", {
        retryable: true,
        nextAction: `Retry after ${wait} seconds.`,
      });
    if (workspaceId) {
      const r = await this.o.api(user, "GET", `/v1/workspaces/${workspaceId}`);
      if (r.status !== 200) throw new KernelError("NOT_FOUND", "NOT_FOUND", "Workspace not found.");
      await this.store.patchThread(ctx, threadId, { workspaceId });
    }
    const history = (await this.store.listMessages(ctx, threadId, 8)).filter((m) => m.state === "ready");
    const userMessage = await this.store.addMessage(ctx, {
      threadId,
      role: "user",
      state: "ready",
      kind: "text",
      text,
    });
    const reply = await this.store.addMessage(ctx, {
      threadId,
      role: "assistant",
      state: "pending",
      kind: "text",
    });
    await this.store.touchThread(ctx, threadId, text.replace(/\s+/g, " ").slice(0, 60));
    const wsId = workspaceId ?? thread.workspaceId;
    const p = this.fillReply(user, threadId, reply.id, text, history, wsId).finally(() =>
      this.inflight.delete(p),
    );
    this.inflight.add(p);
    return { userMessage, reply };
  }

  private async fail(user: AgentUser, replyId: string, err: unknown, usd = 0, calls = 0): Promise<void> {
    let reasonCode = "AGENT_FAILED";
    let message = "The agent could not answer just now.";
    if (err instanceof KernelError || err instanceof ApiError) {
      reasonCode = err.reasonCode;
      message = err.message;
    } else if ((err as { code?: unknown } | null)?.code === "BUDGET_EXCEEDED") {
      reasonCode = "GLOBAL_CEILING";
      message = "The model-spend ceiling is reached.";
    } else if ((err as { name?: string } | null)?.name === "ZodError") {
      reasonCode = "MODEL_OUTPUT_INVALID";
      message = "The model returned an unusable plan.";
    }
    await this.store.finishMessage(ctxOf(user), replyId, {
      state: "failed",
      kind: "notice",
      text: message,
      modelUsd: usd,
      modelCalls: calls,
      error: { reasonCode, message },
    });
  }

  private async fillReply(
    user: AgentUser,
    threadId: string,
    replyId: string,
    text: string,
    history: MessageView[],
    workspaceId: string | null,
  ): Promise<void> {
    const ctx = ctxOf(user);
    let model: AssistantModelPort;
    let totalUsd = 0;
    let totalCalls = 0;
    const recordCost = async (label: string, usd: number, calls: number, key: string) => {
      totalUsd += usd;
      totalCalls += calls;
      if (usd > 0)
        await this.store.addCost(ctx, {
          threadId,
          taskId: null,
          messageId: replyId,
          stepIdx: null,
          stepKey: null,
          label,
          unit: "usd",
          amount: usd.toFixed(6),
          sourceKey: `msg:${replyId}:${key}`,
        });
    };
    try {
      model = await this.modelFor(user);
      const ws = await this.o.api(user, "GET", "/v1/workspaces");
      const workspaces = (
        (ws.body as { workspaces?: Array<{ id: string; objective: string }> } | null)?.workspaces ?? []
      ).map((w) => ({ id: w.id, objective: w.objective }));
      // What the current workspace already holds, so the planner neither asks for nor re-runs what exists.
      let current: { finishedRuns: number; capsules: number } | null = null;
      if (workspaceId) {
        const [r, c] = await Promise.all([
          this.o.api(user, "GET", `/v1/workspaces/${workspaceId}/runs`),
          this.o.api(user, "GET", `/v1/workspaces/${workspaceId}/capsules`),
        ]);
        const runs = (r.body as { runs?: Array<{ state?: string }> } | null)?.runs;
        const caps = (c.body as { capsules?: unknown[] } | null)?.capsules;
        if (Array.isArray(runs) && Array.isArray(caps))
          current = {
            finishedRuns: runs.filter((x) => x.state === "COMPLETE").length,
            capsules: caps.length,
          };
      }
      const hist = history.map((m) => ({
        role: m.role,
        text: (m.text ?? (m.answer as { summary?: string } | null)?.summary ?? "").slice(0, 2000),
      }));
      let decision;
      try {
        decision = await planMessage(
          model,
          {
            messageId: replyId,
            text,
            history: hist.filter((h) => h.text),
            threadWorkspaceId: workspaceId,
            current,
            workspaces,
            now: (this.o.now ?? (() => new Date()))(),
          },
          workspaceId ? { workspaceId } : {},
        );
      } finally {
        const u = model.usage();
        await recordCost("Planner", u.usd, u.modelCalls, "planner");
      }
      switch (decision.kind) {
        case "text":
        case "clarify":
          await this.store.finishMessage(ctx, replyId, {
            state: "ready",
            kind: "text",
            text: decision.text,
            modelUsd: totalUsd,
            modelCalls: totalCalls,
          });
          return;
        case "answer": {
          const r = await this.o.api(user, "POST", "/v1/assistant/answer", {
            question: text,
            ...(hist.length ? { history: hist.filter((h) => h.text).slice(-6) } : {}),
          });
          if (r.status !== 200) throw apiErrorOf(r);
          const a = r.body as { cost?: { usd?: number; modelCalls?: number }; summary?: string | null };
          await recordCost("Quick answer", a.cost?.usd ?? 0, a.cost?.modelCalls ?? 0, "answer");
          await this.store.finishMessage(ctx, replyId, {
            state: "ready",
            kind: "answer",
            text: a.summary ?? null,
            answer: a,
            modelUsd: totalUsd,
            modelCalls: totalCalls,
          });
          return;
        }
        case "direct": {
          const result = await this.lookup(user, decision.lookup, decision.workspaceId);
          await this.store.finishMessage(ctx, replyId, {
            state: "ready",
            kind: "result",
            text: result.summary,
            result,
            modelUsd: totalUsd,
            modelCalls: totalCalls,
          });
          return;
        }
        case "plan": {
          const taskId = await this.createTask(user, threadId, workspaceId, decision.title, decision.steps);
          await this.store.finishMessage(ctx, replyId, {
            state: "ready",
            kind: "plan",
            text: decision.title,
            taskId,
            modelUsd: totalUsd,
            modelCalls: totalCalls,
          });
          return;
        }
      }
    } catch (e) {
      await this.fail(user, replyId, e, totalUsd, totalCalls);
    }
  }

  /** Server-side consent and estimates: computed from the validated steps, never from the model. */
  async createTask(
    user: AgentUser,
    threadId: string,
    workspaceId: string | null,
    title: string,
    steps: PlannedStep[],
  ): Promise<string> {
    let proofEstimate: string | null = null;
    if (steps.some((s) => s.key === "capsule.prove")) {
      const known = steps.find((s) => s.key === "capsule.prove")?.params.capsuleId;
      const url =
        typeof known === "string" ? `/v1/credits?capsuleId=${encodeURIComponent(known)}` : "/v1/credits";
      const r = await this.o.api(user, "GET", url);
      const est = (r.body as { proofEstimateYocto?: unknown } | null)?.proofEstimateYocto;
      proofEstimate = r.status === 200 && typeof est === "string" && /^\d+$/.test(est) ? est : null;
    }
    const required = consentFor(steps, proofEstimate);
    const spend = required.find((c) => c.key === "spend_credits");
    return this.store.createTask(ctxOf(user), {
      threadId,
      workspaceId,
      title,
      consentRequired: required,
      estimate: { creditsMaxYocto: spend?.maxYocto ?? null, modelUsdMax: modelUsdMaxFor(steps) },
      steps: steps.map((s) => ({ key: s.key, params: s.params, title: titleOf(s), detail: detailOf(s) })),
    });
  }

  // ------------------------------------------------------------ direct lookups (read-only, as the user)
  async lookup(user: AgentUser, kind: DirectLookup, workspaceId: string | null): Promise<StepResult> {
    if (!DIRECT_LOOKUPS.includes(kind))
      throw new KernelError("VALIDATION_FAILED", "UNKNOWN_LOOKUP", "Unknown lookup.");
    const get = async <T = Obj>(url: string) => (await call<T>(this.o.api, user, "GET", url)).body;
    const needWs = (): string => {
      if (!workspaceId)
        throw new KernelError("VALIDATION_FAILED", "WORKSPACE_REQUIRED", "Tell me which workspace you mean.");
      return workspaceId;
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError) throw new KernelError("NOT_FOUND", e.reasonCode, e.message);
        throw e;
      }
    };
    return wrap(async () => {
      switch (kind) {
        case "workspaces": {
          const r = await get<{ workspaces?: Array<{ id: string; objective: string }> }>("/v1/workspaces");
          const ws = r.workspaces ?? [];
          return {
            summary: ws.length
              ? `You have ${ws.length} workspace${ws.length === 1 ? "" : "s"}.`
              : "You have no workspaces yet.",
            items: ws.slice(0, 50).map((w) => item(w.objective.slice(0, 140), w.id, `/w/${w.id}`)),
          };
        }
        case "monitors": {
          const id = needWs();
          const r = await get<{ rules?: Array<Obj> }>(`/v1/workspaces/${id}/monitors`);
          const rules = r.rules ?? [];
          return {
            summary: rules.length
              ? `${rules.length} monitor rule${rules.length === 1 ? "" : "s"}.`
              : "This workspace has no monitor rules.",
            items: rules
              .slice(0, 50)
              .map((m) =>
                item(String(m.name), m.enabled === false ? "disabled" : "enabled", `/w/${id}/monitors`),
              ),
          };
        }
        case "hypotheses": {
          const id = needWs();
          const r = await get<{ hypotheses?: Array<Obj> }>(`/v1/workspaces/${id}/hypotheses`);
          const hs = r.hypotheses ?? [];
          return {
            summary: hs.length
              ? `${hs.length} hypothes${hs.length === 1 ? "is" : "es"}.`
              : "This workspace has no hypotheses.",
            items: hs
              .slice(0, 50)
              .map((h) =>
                item(String(h.proposition).slice(0, 140), String(h.status ?? "draft"), `/w/${id}/hypotheses`),
              ),
          };
        }
        case "findings":
        case "approvals": {
          const id = needWs();
          const runs = await get<{ runs?: Array<{ runId: string; state: string }> }>(
            `/v1/workspaces/${id}/runs`,
          );
          const latest = runs.runs?.[0];
          if (!latest) return { summary: "This workspace has no runs yet.", items: [] };
          if (kind === "findings") {
            const run = await get<{ findings?: Array<Obj> }>(`/v1/runs/${latest.runId}`);
            const fs = run.findings ?? [];
            return {
              summary: fs.length
                ? `${fs.length} finding${fs.length === 1 ? "" : "s"} in the latest run (${latest.state}).`
                : `The latest run (${latest.state}) has no written findings.`,
              items: fs
                .slice(0, 50)
                .map((f) =>
                  item(
                    String(f.statement).slice(0, 200),
                    String(f.status),
                    `/w/${id}/investigate?run=${latest.runId}`,
                  ),
                ),
            };
          }
          const ap = await get<{ approvals?: Array<Obj> }>(`/v1/runs/${latest.runId}/approvals`);
          const aps = ap.approvals ?? [];
          return {
            summary: aps.length
              ? `${aps.length} pending approval${aps.length === 1 ? "" : "s"} on the latest run.`
              : "Nothing is waiting for your approval on the latest run.",
            items: aps.map((a) =>
              item(String(a.kind), `cost limit ${a.costLimit ?? "not set"}`, `/w/${id}/approvals`),
            ),
          };
        }
        case "credits": {
          const c = await get<{ balanceYocto: string; heldYocto: string; availableYocto: string }>(
            "/v1/credits",
          );
          return {
            summary: `Available credits: ${c.availableYocto} yoctoNEAR.`,
            items: [
              item("Balance (yoctoNEAR)", c.balanceYocto, "/credits"),
              item("Held (yoctoNEAR)", c.heldYocto, "/credits"),
              item("Available (yoctoNEAR)", c.availableYocto, "/credits"),
            ],
          };
        }
      }
    });
  }
}
