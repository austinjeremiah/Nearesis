import type pg from "pg";
import type { z } from "zod";
import type { AgentRole, SpawnRequest as SpawnRequestSchema } from "@nearesis/contracts";
type SpawnRequest = z.infer<typeof SpawnRequestSchema>;
import { AgentRuntimeError, type ReasonCode } from "./errors.ts";
import { sha256Hex, canonicalJson } from "./canonical.ts";
import type { AuditSink } from "./audit.ts";
import type { Policy } from "./policy.ts";
import type { RoleConfig } from "./roles.ts";
import { withTenant } from "./tenant.ts";

export interface DedupKey {
  workspaceId: string;
  investigationId: string;
  task: string;
  modelVersion: string;
  inputSnapshot: string;
}
export const dedupHashOf = (k: DedupKey): string =>
  sha256Hex(
    canonicalJson({
      workspaceId: k.workspaceId,
      investigationId: k.investigationId,
      task: k.task,
      modelVersion: k.modelVersion,
      inputSnapshot: k.inputSnapshot,
    }),
  );
/** Deterministic task id derived from the dedup identity (valid RFC 4122 v4-shaped UUID). */
export function taskIdFromHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Budget {
  tokens: number;
  toolCalls: number;
  usd: number;
}
/** Dev cost model for the scripted/mock provider: 0.002 USD per 1k tokens. */
export const usdForTokens = (tokens: number): number => Math.round((tokens / 1000) * 0.002 * 1e8) / 1e8;

export interface SpawnContext {
  tenantId: string;
  runId: string;
  budgetId: string;
  /** Server-held parent facts. The depth and capabilities are NEVER read from the request. */
  parent: { taskId: string | null; depth: number; allowedCapabilities: string[] };
  dedupKey: DedupKey;
  hypothesisId: string;
}
export interface SpawnResult {
  taskId: string;
  depth: number;
  created: boolean;
  dedupHash: string;
  status: string;
  clampedMaxChildDepth: number;
}

export class Supervisor {
  constructor(
    private readonly pool: pg.Pool,
    readonly policy: Policy,
    private readonly audit: AuditSink,
    private readonly roles: Map<AgentRole, RoleConfig>,
  ) {}

  private async reject(
    ctx: SpawnContext,
    workspaceId: string,
    code: ReasonCode,
    msg: string,
    detail: Record<string, unknown> = {},
  ): Promise<never> {
    await this.audit.write({
      tenantId: ctx.tenantId,
      workspaceId,
      runId: ctx.runId,
      taskId: ctx.parent.taskId,
      actor: "supervisor",
      kind: "spawn.rejected",
      reasonCode: code,
      detail,
    });
    throw new AgentRuntimeError(code, msg, detail);
  }

  /** Server-enforced `agent.spawn`: depth, fan-out, capability subset, budget reserve, dedup (A12, A18, A05). */
  async spawn(req: SpawnRequest, ctx: SpawnContext): Promise<SpawnResult> {
    const clamped = Math.min(req.maxChildDepth, this.policy.maxDepth);
    const depth = ctx.parent.depth + 1;
    if (depth > this.policy.maxDepth)
      await this.reject(
        ctx,
        req.workspaceId,
        "DEPTH_LIMIT",
        `depth ${depth} exceeds ${this.policy.maxDepth}`,
        {
          requestedDepth: depth,
          limit: this.policy.maxDepth,
          requestedMaxChildDepth: req.maxChildDepth,
        },
      );
    const roleCfg = this.roles.get(req.role);
    const parentCaps = new Set(ctx.parent.allowedCapabilities);
    const escalation = req.allowedCapabilities.filter(
      (c) => !parentCaps.has(c) || !roleCfg?.allowedTools.includes(c),
    );
    if (!roleCfg || escalation.length)
      await this.reject(
        ctx,
        req.workspaceId,
        "CAPABILITY_ESCALATION",
        "child capabilities exceed parent/role",
        {
          denied: escalation,
          role: req.role,
        },
      );
    const hash = dedupHashOf(ctx.dedupKey);
    const taskId = taskIdFromHash(hash);

    type Outcome =
      | { kind: "ok"; result: SpawnResult }
      | { kind: "reject"; code: ReasonCode; msg: string; detail: Record<string, unknown> };
    const outcome: Outcome = await withTenant(this.pool, ctx.tenantId, async (c): Promise<Outcome> => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`spawn:${req.workspaceId}`]);
      const ex = await c.query<{ id: string; depth: number; status: string }>(
        "SELECT id, depth, status FROM tasks WHERE dedup_hash=$1",
        [hash],
      );
      if (ex.rows[0])
        return {
          kind: "ok",
          result: {
            taskId: ex.rows[0].id,
            depth: ex.rows[0].depth,
            created: false,
            dedupHash: hash,
            status: ex.rows[0].status,
            clampedMaxChildDepth: clamped,
          },
        };
      const active = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tasks WHERE workspace_id=$1 AND depth >= 1
         AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
        [req.workspaceId],
      );
      if (Number(active.rows[0]!.n) >= this.policy.maxConcurrentChildrenPerWorkspace)
        return {
          kind: "reject",
          code: "FANOUT_LIMIT",
          msg: "concurrent children limit reached",
          detail: { active: Number(active.rows[0]!.n), limit: this.policy.maxConcurrentChildrenPerWorkspace },
        };
      const b = await this.budgetCheck(c, ctx.budgetId, req.budget);
      if (b) return { kind: "reject", code: "BUDGET_EXCEEDED", msg: "budget reserve refused", detail: b };
      await c.query(
        `INSERT INTO tasks (id, tenant_id, workspace_id, run_id, parent_task_id, role, depth, dedup_hash, dedup_key,
           hypothesis_id, status, objective, allowed_capabilities, budget_reserved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RUNNING',$11,$12,$13)`,
        [
          taskId,
          ctx.tenantId,
          req.workspaceId,
          ctx.runId,
          ctx.parent.taskId,
          req.role,
          depth,
          hash,
          JSON.stringify(ctx.dedupKey),
          ctx.hypothesisId,
          req.objective,
          JSON.stringify(req.allowedCapabilities),
          JSON.stringify(req.budget),
        ],
      );
      await c.query(
        `INSERT INTO budget_ledger (tenant_id, workspace_id, budget_id, run_id, task_id, entry_key, kind, tokens, tool_calls, usd)
         VALUES ($1,$2,$3,$4,$5,$6,'reserve',$7,$8,$9) ON CONFLICT (entry_key) DO NOTHING`,
        [
          ctx.tenantId,
          req.workspaceId,
          ctx.budgetId,
          ctx.runId,
          taskId,
          `reserve:${taskId}`,
          req.budget.tokens,
          req.budget.toolCalls,
          req.budget.usd,
        ],
      );
      return {
        kind: "ok",
        result: {
          taskId,
          depth,
          created: true,
          dedupHash: hash,
          status: "RUNNING",
          clampedMaxChildDepth: clamped,
        },
      };
    });
    if (outcome.kind === "reject")
      return this.reject(ctx, req.workspaceId, outcome.code, outcome.msg, outcome.detail);
    if (outcome.result.created && clamped !== req.maxChildDepth)
      await this.audit.write({
        tenantId: ctx.tenantId,
        workspaceId: req.workspaceId,
        runId: ctx.runId,
        taskId: outcome.result.taskId,
        actor: "supervisor",
        kind: "spawn.clamped",
        detail: { requestedMaxChildDepth: req.maxChildDepth, effective: clamped },
      });
    return outcome.result;
  }

  /** Creates the depth-0 director task and reserves its budget. Idempotent. */
  async createRootTask(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    investigationId: string;
    budgetId: string;
    snapshotRef: string;
    role: AgentRole;
    capabilities: string[];
    budget: Budget;
  }): Promise<{ taskId: string; created: boolean }> {
    const key: DedupKey = {
      workspaceId: a.workspaceId,
      investigationId: a.investigationId,
      task: `root:${a.role}`,
      modelVersion: "-",
      inputSnapshot: a.snapshotRef,
    };
    const hash = dedupHashOf(key);
    const id = taskIdFromHash(hash);
    const created = await withTenant(this.pool, a.tenantId, async (c) => {
      const ins = await c.query(
        `INSERT INTO tasks (id, tenant_id, workspace_id, run_id, parent_task_id, role, depth, dedup_hash, dedup_key,
           hypothesis_id, status, objective, allowed_capabilities, budget_reserved)
         VALUES ($1,$2,$3,$4,NULL,$5,0,$6,$7,'root','RUNNING','investigation',$8,$9)
         ON CONFLICT (dedup_hash) DO NOTHING RETURNING id`,
        [
          id,
          a.tenantId,
          a.workspaceId,
          a.runId,
          a.role,
          hash,
          JSON.stringify(key),
          JSON.stringify(a.capabilities),
          JSON.stringify(a.budget),
        ],
      );
      if (!ins.rowCount) return false;
      const b = await this.budgetCheck(c, a.budgetId, a.budget);
      if (b) throw new AgentRuntimeError("BUDGET_EXCEEDED", "root budget refused", b);
      await c.query(
        `INSERT INTO budget_ledger (tenant_id, workspace_id, budget_id, run_id, task_id, entry_key, kind, tokens, tool_calls, usd)
         VALUES ($1,$2,$3,$4,$5,$6,'reserve',$7,$8,$9) ON CONFLICT (entry_key) DO NOTHING`,
        [
          a.tenantId,
          a.workspaceId,
          a.budgetId,
          a.runId,
          id,
          `reserve:${id}`,
          a.budget.tokens,
          a.budget.toolCalls,
          a.budget.usd,
        ],
      );
      return true;
    });
    return { taskId: id, created };
  }

  /** Returns detail when the reserve would exceed the budget allowance, else null. Caller holds a tx. */
  private async budgetCheck(
    c: pg.PoolClient,
    budgetId: string,
    want: Budget,
  ): Promise<Record<string, unknown> | null> {
    const b = await c.query<{ tokens_total: string; tool_calls_total: number; usd_total: string }>(
      "SELECT tokens_total, tool_calls_total, usd_total FROM budgets WHERE id=$1 FOR UPDATE",
      [budgetId],
    );
    const row = b.rows[0];
    if (!row) return { reason: "unknown budget", budgetId };
    const used = await c.query<{ t: string; c: string; u: string }>(
      `SELECT COALESCE(SUM(CASE kind WHEN 'reserve' THEN tokens WHEN 'release' THEN -tokens ELSE 0 END),0)::text AS t,
              COALESCE(SUM(CASE kind WHEN 'reserve' THEN tool_calls WHEN 'release' THEN -tool_calls ELSE 0 END),0)::text AS c,
              COALESCE(SUM(CASE kind WHEN 'reserve' THEN usd WHEN 'release' THEN -usd ELSE 0 END),0)::text AS u
       FROM budget_ledger WHERE budget_id=$1`,
      [budgetId],
    );
    const u = used.rows[0]!;
    if (
      Number(u.t) + want.tokens > Number(row.tokens_total) ||
      Number(u.c) + want.toolCalls > row.tool_calls_total ||
      Number(u.u) + want.usd > Number(row.usd_total)
    )
      return {
        requested: want,
        reserved: { tokens: Number(u.t), toolCalls: Number(u.c), usd: Number(u.u) },
        allowance: {
          tokens: Number(row.tokens_total),
          toolCalls: row.tool_calls_total,
          usd: Number(row.usd_total),
        },
      };
    return null;
  }

  /**
   * Records actual consumption. Idempotent by `entryKey`. Exceeding the task's reservation records an audit row
   * with the cost and throws BUDGET_EXCEEDED (A05); the overage is not charged.
   */
  async charge(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    budgetId: string;
    taskId: string;
    entryKey: string;
    usage: Budget;
  }): Promise<void> {
    const over = await withTenant(this.pool, a.tenantId, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`charge:${a.taskId}`]);
      const dup = await c.query("SELECT 1 FROM budget_ledger WHERE entry_key=$1", [a.entryKey]);
      if (dup.rowCount) return null;
      const t = await c.query<{ budget_reserved: Budget }>("SELECT budget_reserved FROM tasks WHERE id=$1", [
        a.taskId,
      ]);
      const reserved = t.rows[0]?.budget_reserved ?? { tokens: 0, toolCalls: 0, usd: 0 };
      const spent = await c.query<{ t: string; c: string; u: string }>(
        `SELECT COALESCE(SUM(tokens),0)::text AS t, COALESCE(SUM(tool_calls),0)::text AS c, COALESCE(SUM(usd),0)::text AS u
         FROM budget_ledger WHERE task_id=$1 AND kind='charge'`,
        [a.taskId],
      );
      const s = spent.rows[0]!;
      const total = {
        tokens: Number(s.t) + a.usage.tokens,
        toolCalls: Number(s.c) + a.usage.toolCalls,
        usd: Number(s.u) + a.usage.usd,
      };
      if (
        total.tokens > reserved.tokens ||
        total.toolCalls > reserved.toolCalls ||
        total.usd > reserved.usd + 1e-12
      )
        return {
          reserved,
          spent: { tokens: Number(s.t), toolCalls: Number(s.c), usd: Number(s.u) },
          attempted: a.usage,
        };
      await c.query(
        `INSERT INTO budget_ledger (tenant_id, workspace_id, budget_id, run_id, task_id, entry_key, kind, tokens, tool_calls, usd)
         VALUES ($1,$2,$3,$4,$5,$6,'charge',$7,$8,$9) ON CONFLICT (entry_key) DO NOTHING`,
        [
          a.tenantId,
          a.workspaceId,
          a.budgetId,
          a.runId,
          a.taskId,
          a.entryKey,
          a.usage.tokens,
          a.usage.toolCalls,
          a.usage.usd,
        ],
      );
      return null;
    });
    if (over) {
      await this.audit.write({
        tenantId: a.tenantId,
        workspaceId: a.workspaceId,
        runId: a.runId,
        taskId: a.taskId,
        actor: "supervisor",
        kind: "budget.exceeded",
        reasonCode: "BUDGET_EXCEEDED",
        detail: over,
      });
      throw new AgentRuntimeError("BUDGET_EXCEEDED", "task exceeded its reserved budget", over);
    }
  }

  /** Marks a task terminal and releases its unused reservation (idempotent). */
  async completeTask(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    budgetId: string;
    taskId: string;
    status: "DONE" | "FAILED" | "CANCELLED";
    outputRef?: string | null;
  }): Promise<void> {
    await withTenant(this.pool, a.tenantId, async (c) => {
      await c.query(
        "UPDATE tasks SET status=$2, output_ref=COALESCE($3,output_ref), updated_at=now() WHERE id=$1",
        [a.taskId, a.status, a.outputRef ?? null],
      );
      const r = await c.query<{ budget_reserved: Budget | null }>(
        "SELECT budget_reserved FROM tasks WHERE id=$1",
        [a.taskId],
      );
      const res = r.rows[0]?.budget_reserved;
      if (!res) return;
      const sp = await c.query<{ t: string; c: string; u: string }>(
        `SELECT COALESCE(SUM(tokens),0)::text AS t, COALESCE(SUM(tool_calls),0)::text AS c, COALESCE(SUM(usd),0)::text AS u
         FROM budget_ledger WHERE task_id=$1 AND kind='charge'`,
        [a.taskId],
      );
      const s = sp.rows[0]!;
      await c.query(
        `INSERT INTO budget_ledger (tenant_id, workspace_id, budget_id, run_id, task_id, entry_key, kind, tokens, tool_calls, usd)
         VALUES ($1,$2,$3,$4,$5,$6,'release',$7,$8,$9) ON CONFLICT (entry_key) DO NOTHING`,
        [
          a.tenantId,
          a.workspaceId,
          a.budgetId,
          a.runId,
          a.taskId,
          `release:${a.taskId}`,
          Math.max(0, res.tokens - Number(s.t)),
          Math.max(0, res.toolCalls - Number(s.c)),
          Math.max(0, res.usd - Number(s.u)),
        ],
      );
    });
  }

  async activeChildren(tenantId: string, workspaceId: string): Promise<number> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tasks WHERE workspace_id=$1 AND depth>=1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
        [workspaceId],
      );
      return Number(r.rows[0]!.n);
    });
  }
}
