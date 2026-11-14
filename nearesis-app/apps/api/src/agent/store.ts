import type { Db, TenantContext, Tx } from "@nearesis/kernel";
import type {
  ConsentKey,
  ConsentRequirement,
  CostEntryView,
  MessageView,
  StepError,
  StepResult,
  StepState,
  StepView,
  StepWaiting,
  TaskCtx,
  TaskState,
  TaskView,
  ThreadView,
} from "./types.ts";

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
/** numeric(x,6) amounts come back as "1.230000". */
const usd = (v: unknown): string => Number(String(v ?? 0)).toFixed(6);

interface ThreadRow {
  id: string;
  title: string;
  workspace_id: string | null;
  created_at: Date;
  updated_at: Date;
}
interface MessageRow {
  id: string;
  role: "user" | "assistant";
  state: "pending" | "ready" | "failed";
  kind: MessageView["kind"];
  text: string | null;
  answer: unknown;
  result: StepResult | null;
  task_id: string | null;
  model_usd: string;
  model_calls: number;
  error: { reasonCode: string; message: string } | null;
  created_at: Date;
}
interface TaskRow {
  id: string;
  thread_id: string;
  workspace_id: string | null;
  title: string;
  state: TaskState;
  current_step: number;
  consent_required: ConsentRequirement[];
  consent_given: ConsentKey[];
  estimate: { creditsMaxUsd?: string | null; modelUsdMax: string };
  ctx: TaskCtx;
  model_usd: string;
  model_calls: number;
  credits_charged_usd: string;
  credits_held_usd: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
export interface StepRow {
  task_id: string;
  idx: number;
  key: string;
  params: Record<string, unknown>;
  title: string;
  detail: string;
  state: StepState;
  started_at: Date | null;
  finished_at: Date | null;
  progress: string | null;
  result: StepResult | null;
  waiting: StepWaiting | null;
  error: StepError | null;
  model_usd: string;
  model_calls: number;
  credits_usd: string;
}
interface CostRow {
  id: string;
  created_at: Date;
  thread_id: string | null;
  task_id: string | null;
  step_idx: number | null;
  step_key: string | null;
  label: string;
  unit: "usd" | "yoctoNEAR";
  amount: string;
  tx_hash: string | null;
  category: "model" | "onchain";
  detail: Record<string, unknown> | null;
}

export const threadView = (r: ThreadRow): ThreadView => ({
  id: r.id,
  title: r.title,
  workspaceId: r.workspace_id,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});
export const messageView = (r: MessageRow): MessageView => ({
  id: r.id,
  role: r.role,
  state: r.state,
  createdAt: iso(r.created_at)!,
  kind: r.kind,
  text: r.text,
  answer: r.answer ?? null,
  rows: r.result?.items ?? null,
  taskId: r.task_id,
  cost: { modelUsd: usd(r.model_usd), modelCalls: r.model_calls },
  error: r.error ?? null,
});
/** Legacy yoctoNEAR entries (before USD credits) have no rate and are not shown. */
const usdOnly = (rows: CostRow[]): CostRow[] => rows.filter((r) => r.unit === "usd");
const costEntry = (r: CostRow): CostEntryView => ({
  label: r.label,
  unit: "usd",
  amount: usd(r.amount),
  txHash: r.tx_hash,
  ...(r.detail ? { detail: r.detail } : {}),
});
export const stepView = (r: StepRow, entries: CostRow[] = []): StepView => ({
  idx: r.idx,
  key: r.key,
  title: r.title,
  detail: r.detail,
  state: r.state,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  progress: r.progress,
  result: r.result ?? null,
  waiting: r.waiting ?? null,
  cost: {
    modelUsd: usd(r.model_usd),
    modelCalls: r.model_calls,
    creditsUsd: usd(r.credits_usd),
    entries: usdOnly(entries).map(costEntry),
  },
  error: r.error ?? null,
});
export const taskView = (t: TaskRow, steps: StepRow[], costs: CostRow[]): TaskView => ({
  id: t.id,
  threadId: t.thread_id,
  workspaceId: t.workspace_id,
  title: t.title,
  state: t.state,
  currentStep: t.current_step,
  steps: steps.map((s) =>
    stepView(
      s,
      costs.filter((c) => c.step_idx === s.idx),
    ),
  ),
  consent: {
    required: t.consent_required.map((c) => {
      const { maxUsd, ...rest } = c as ConsentRequirement & { maxYocto?: unknown };
      delete (rest as { maxYocto?: unknown }).maxYocto;
      return { ...rest, maxUsd: maxUsd ?? null };
    }),
    given: t.consent_given,
  },
  estimate: { creditsMaxUsd: t.estimate.creditsMaxUsd ?? null, modelUsdMax: t.estimate.modelUsdMax },
  cost: {
    modelUsd: usd(t.model_usd),
    modelCalls: t.model_calls,
    creditsUsd: usd(t.credits_charged_usd),
    creditsHeldUsd: usd(t.credits_held_usd),
    entries: usdOnly(costs).map(costEntry),
  },
  links: {
    workspaceId: t.ctx.workspaceId ?? t.workspace_id ?? null,
    runId: t.ctx.runId ?? null,
    capsuleId: t.ctx.capsuleId ?? null,
    proofId: t.ctx.proofId ?? null,
    publicationId: t.ctx.publicationId ?? null,
    reportUrl: t.ctx.reportUrl ?? null,
  },
  createdAt: iso(t.created_at)!,
  startedAt: iso(t.started_at),
  finishedAt: iso(t.finished_at),
});

export interface NewStep {
  key: string;
  params: Record<string, unknown>;
  title: string;
  detail: string;
}
export interface CostInput {
  threadId: string | null;
  taskId: string | null;
  messageId?: string | null;
  stepIdx: number | null;
  stepKey: string | null;
  label: string;
  unit: "usd";
  amount: string;
  /** `onchain` = OutLayer / anchor gas charged to the user's credits (USD, with the NEAR detail); `model` = model spend. */
  category?: "model" | "onchain";
  detail?: Record<string, unknown> | null;
  txHash?: string | null;
  sourceKey?: string | null;
}

/** Postgres access for the agent tables. Every call runs in a tenant transaction: row-level security scopes it to the user. */
export class AgentStore {
  constructor(private readonly db: Db) {}

  // ---- threads
  async listThreads(
    ctx: TenantContext,
  ): Promise<Array<ThreadView & { preview: string; activeTaskId: string | null }>> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<ThreadRow & { preview: string | null; active: string | null }>(
        `SELECT t.id, t.title, t.workspace_id, t.created_at, t.updated_at,
                (SELECT left(coalesce(m.text, ''), 140) FROM agent_messages m WHERE m.thread_id = t.id ORDER BY m.seq DESC LIMIT 1) AS preview,
                (SELECT k.id FROM agent_tasks k WHERE k.thread_id = t.id AND k.state IN ('running','waiting_user') LIMIT 1) AS active
           FROM agent_threads t WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC LIMIT 200`,
      );
      return r.rows.map((x) => ({ ...threadView(x), preview: x.preview ?? "", activeTaskId: x.active }));
    });
  }
  async createThread(ctx: TenantContext, title: string | undefined, workspaceId: string | null) {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<ThreadRow>(
        `INSERT INTO agent_threads(org_id, user_id, title, workspace_id) VALUES ($1,$2,$3,$4)
         RETURNING id, title, workspace_id, created_at, updated_at`,
        [ctx.orgId, ctx.userId, title ?? "New conversation", workspaceId],
      );
      return threadView(r.rows[0]!);
    });
  }
  async getThread(ctx: TenantContext, id: string): Promise<ThreadView | null> {
    return this.db.tx(ctx, async (tx) => this.threadIn(tx, id));
  }
  async threadIn(tx: Tx, id: string): Promise<ThreadView | null> {
    const r = await tx.query<ThreadRow>(
      "SELECT id, title, workspace_id, created_at, updated_at FROM agent_threads WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return r.rows[0] ? threadView(r.rows[0]) : null;
  }
  async patchThread(
    ctx: TenantContext,
    id: string,
    p: { title?: string; workspaceId?: string | null },
  ): Promise<ThreadView | null> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<ThreadRow>(
        `UPDATE agent_threads SET title = COALESCE($2, title),
                workspace_id = CASE WHEN $3::boolean THEN $4::uuid ELSE workspace_id END, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id, title, workspace_id, created_at, updated_at`,
        [id, p.title ?? null, p.workspaceId !== undefined, p.workspaceId ?? null],
      );
      return r.rows[0] ? threadView(r.rows[0]) : null;
    });
  }
  async deleteThread(ctx: TenantContext, id: string): Promise<boolean> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query(
        "UPDATE agent_threads SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [id],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }
  async touchThread(ctx: TenantContext, id: string, titleIfDefault?: string): Promise<void> {
    await this.db.tx(ctx, async (tx) => {
      await tx.query(
        `UPDATE agent_threads SET updated_at = now(),
                title = CASE WHEN title = 'New conversation' AND $2::text IS NOT NULL THEN $2 ELSE title END WHERE id = $1`,
        [id, titleIfDefault ?? null],
      );
    });
  }

  // ---- messages
  async addMessage(
    ctx: TenantContext,
    m: {
      threadId: string;
      role: "user" | "assistant";
      state: "pending" | "ready" | "failed";
      kind: MessageView["kind"];
      text?: string | null;
      taskId?: string | null;
    },
  ): Promise<MessageView> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<MessageRow>(
        `INSERT INTO agent_messages(thread_id, org_id, user_id, role, state, kind, text, task_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [m.threadId, ctx.orgId, ctx.userId, m.role, m.state, m.kind, m.text ?? null, m.taskId ?? null],
      );
      return messageView(r.rows[0]!);
    });
  }
  async finishMessage(
    ctx: TenantContext,
    id: string,
    p: {
      state: "ready" | "failed";
      kind: MessageView["kind"];
      text?: string | null;
      answer?: unknown;
      result?: StepResult | null;
      taskId?: string | null;
      modelUsd?: number;
      modelCalls?: number;
      error?: { reasonCode: string; message: string; details?: Record<string, unknown> } | null;
    },
  ): Promise<void> {
    await this.db.tx(ctx, async (tx) => {
      await tx.query(
        `UPDATE agent_messages SET state=$2, kind=$3, text=$4, answer=$5::jsonb, result=$6::jsonb, task_id=$7,
                model_usd=$8, model_calls=$9, error=$10::jsonb WHERE id=$1`,
        [
          id,
          p.state,
          p.kind,
          p.text ?? null,
          p.answer === undefined || p.answer === null ? null : JSON.stringify(p.answer),
          p.result ? JSON.stringify(p.result) : null,
          p.taskId ?? null,
          (p.modelUsd ?? 0).toFixed(6),
          p.modelCalls ?? 0,
          p.error ? JSON.stringify(p.error) : null,
        ],
      );
    });
  }
  async listMessages(ctx: TenantContext, threadId: string, limit = 500): Promise<MessageView[]> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<MessageRow>(
        "SELECT * FROM (SELECT * FROM agent_messages WHERE thread_id = $1 ORDER BY seq DESC LIMIT $2) x ORDER BY seq",
        [threadId, limit],
      );
      return r.rows.map(messageView);
    });
  }
  async getMessage(ctx: TenantContext, id: string): Promise<(MessageView & { threadId: string }) | null> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<MessageRow & { thread_id: string }>(
        "SELECT * FROM agent_messages WHERE id = $1",
        [id],
      );
      return r.rows[0] ? { ...messageView(r.rows[0]), threadId: r.rows[0].thread_id } : null;
    });
  }

  // ---- tasks
  async createTask(
    ctx: TenantContext,
    t: {
      threadId: string;
      workspaceId: string | null;
      title: string;
      consentRequired: ConsentRequirement[];
      estimate: { creditsMaxUsd: string | null; modelUsdMax: string };
      steps: NewStep[];
    },
  ): Promise<string> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO agent_tasks(thread_id, org_id, user_id, workspace_id, title, state, consent_required, estimate, ctx)
         VALUES ($1,$2,$3,$4,$5,'proposed',$6::jsonb,$7::jsonb,$8::jsonb) RETURNING id`,
        [
          t.threadId,
          ctx.orgId,
          ctx.userId,
          t.workspaceId,
          t.title,
          JSON.stringify(t.consentRequired),
          JSON.stringify(t.estimate),
          JSON.stringify(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
        ],
      );
      const id = r.rows[0]!.id;
      for (const [i, s] of t.steps.entries())
        await tx.query(
          `INSERT INTO agent_task_steps(task_id, idx, org_id, user_id, key, params, title, detail)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
          [id, i, ctx.orgId, ctx.userId, s.key, JSON.stringify(s.params), s.title, s.detail],
        );
      return id;
    });
  }
  async taskRows(tx: Tx, id: string, lock = false) {
    const t = await tx.query<TaskRow>(`SELECT * FROM agent_tasks WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [
      id,
    ]);
    if (!t.rows[0]) return null;
    const steps = await tx.query<StepRow>("SELECT * FROM agent_task_steps WHERE task_id = $1 ORDER BY idx", [
      id,
    ]);
    const costs = await tx.query<CostRow>(
      "SELECT * FROM agent_cost_entries WHERE task_id = $1 ORDER BY seq",
      [id],
    );
    return { task: t.rows[0], steps: steps.rows, costs: costs.rows };
  }
  async getTask(ctx: TenantContext, id: string): Promise<TaskView | null> {
    return this.db.tx(ctx, async (tx) => {
      const x = await this.taskRows(tx, id);
      return x ? taskView(x.task, x.steps, x.costs) : null;
    });
  }
  async tasksOfThread(ctx: TenantContext, threadId: string): Promise<TaskView[]> {
    return this.db.tx(ctx, async (tx) => {
      const ids = await tx.query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE thread_id = $1 ORDER BY created_at, id",
        [threadId],
      );
      const out: TaskView[] = [];
      for (const { id } of ids.rows) {
        const x = await this.taskRows(tx, id);
        if (x) out.push(taskView(x.task, x.steps, x.costs));
      }
      return out;
    });
  }
  /** Raw rows for the executor. */
  async loadRaw(ctx: TenantContext, id: string) {
    return this.db.tx(ctx, (tx) => this.taskRows(tx, id));
  }
  async inTx<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.tx(ctx, fn);
  }

  // ---- costs
  async addCost(ctx: TenantContext, c: CostInput): Promise<boolean> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query(
        `INSERT INTO agent_cost_entries(org_id, user_id, thread_id, task_id, message_id, step_idx, step_key, label, unit, amount, tx_hash, source_key, category, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING`,
        [
          ctx.orgId,
          ctx.userId,
          c.threadId,
          c.taskId,
          c.messageId ?? null,
          c.stepIdx,
          c.stepKey,
          c.label,
          c.unit,
          c.amount,
          c.txHash ?? null,
          c.sourceKey ?? null,
          c.category ?? "model",
          c.detail ? JSON.stringify(c.detail) : null,
        ],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }
  async costs(ctx: TenantContext, threadId: string | null, limit: number) {
    return this.db.tx(ctx, async (tx) => {
      const where = threadId ? "WHERE thread_id = $1" : "WHERE $1::uuid IS NULL";
      const totals = await tx.query<{ category: string; total: string; n: string }>(
        `SELECT category, sum(amount)::text AS total, count(*)::text AS n FROM agent_cost_entries ${where} AND unit = 'usd' GROUP BY category`,
        [threadId],
      );
      const calls = await tx.query<{ calls: string }>(
        `SELECT (coalesce((SELECT sum(model_calls) FROM agent_messages ${where}), 0)
                + coalesce((SELECT sum(model_calls) FROM agent_tasks ${where}), 0))::text AS calls`,
        [threadId],
      );
      const items = await tx.query<CostRow>(
        `SELECT * FROM agent_cost_entries ${where} ORDER BY seq DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
        [threadId],
      );
      const t = (c: string) => Number(totals.rows.find((x) => x.category === c)?.total ?? "0");
      return {
        totals: {
          modelUsd: usd(t("model")),
          modelCalls: Number(calls.rows[0]?.calls ?? 0),
          onChainUsd: usd(t("onchain")),
          totalUsd: usd(t("model") + t("onchain")),
        },
        items: usdOnly(items.rows).map((r) => ({
          id: r.id,
          at: iso(r.created_at)!,
          threadId: r.thread_id,
          taskId: r.task_id,
          stepIdx: r.step_idx,
          stepKey: r.step_key,
          label: r.label,
          unit: "usd" as const,
          category: r.category,
          amount: usd(r.amount),
          txHash: r.tx_hash,
          ...(r.detail ? { detail: r.detail } : {}),
        })),
      };
    });
  }
}
