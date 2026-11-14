import type { FastifyPluginAsync } from "fastify";
import { KernelError } from "@nearesis/kernel";
import { Uuid, ctxOf, iso } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);
const n = (v: unknown): number => Number(v ?? 0);

/**
 * Per-task detail of a run, read from the existing runtime tables (read-only):
 *   GET /v1/runs/:id/tasks  -> { runId, tasks: [{taskId, role, status, startedAt, endedAt, cost, toolCalls, rejectedToolCalls}], totals }
 * Cost is the task's `budget_ledger` entries (charged = what was consumed; reserved/released are shown separately).
 * Tool calls come from `tool_call_log`, which is keyed by (run, hypothesis), not by task: when several tasks of the run
 * share a hypothesis id the calls are listed under each of them with `attribution: "shared_hypothesis"` and counted once in `totals`.
 */
export const runDetailRoutes: FastifyPluginAsync<ProductDeps> = async (app, { kernel, authenticate }) => {
  app.get<{ Params: { id: string } }>("/v1/runs/:id/tasks", async (req) => {
    const s = await authenticate(req);
    const notFound = () => new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
    if (!Uuid.safeParse(req.params.id).success) throw notFound();
    return kernel.db.tx(ctxOf(s), async (tx) => {
      let run: { workspace_id: string } | undefined;
      try {
        run = (
          await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM runtime.runs WHERE id = $1", [
            req.params.id,
          ])
        ).rows[0];
      } catch (e) {
        const c = (e as { code?: string } | null)?.code;
        if (c === "42P01" || c === "3F000" || c === "42501")
          throw new KernelError(
            "UPSTREAM_DEGRADED",
            "RUNTIME_UNAVAILABLE",
            "Run state is temporarily unavailable.",
            { retryable: true },
          );
        throw e;
      }
      if (!run) throw notFound();
      if (!(await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [run.workspace_id])).rows[0])
        throw notFound();

      const tasks = (
        await tx.query<{
          id: string;
          parent_task_id: string | null;
          role: string;
          depth: number;
          status: string;
          hypothesis_id: string;
          objective: string | null;
          output_ref: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          "SELECT id, parent_task_id, role, depth, status, hypothesis_id, objective, output_ref, created_at, updated_at FROM runtime.tasks WHERE run_id = $1 ORDER BY created_at, id",
          [req.params.id],
        )
      ).rows;
      const ledger = (
        await tx.query<{
          task_id: string;
          kind: string;
          tokens: string;
          tool_calls: number;
          usd: string;
          entries: string;
          priced: string;
        }>(
          `SELECT task_id, kind, sum(tokens)::text AS tokens, sum(tool_calls)::int AS tool_calls, sum(usd)::text AS usd, count(*)::text AS entries, count(*)::text AS priced
             FROM runtime.budget_ledger WHERE run_id = $1 AND task_id IS NOT NULL GROUP BY task_id, kind`,
          [req.params.id],
        )
      ).rows;
      const calls = (
        await tx.query<{
          hypothesis_id: string;
          n: number;
          tool: string;
          created_at: Date;
          call_key: string;
        }>(
          "SELECT hypothesis_id, n, tool, created_at, call_key FROM runtime.tool_call_log WHERE run_id = $1 ORDER BY hypothesis_id, n",
          [req.params.id],
        )
      ).rows;
      const rejected = (
        await tx.query<{
          task_id: string;
          kind: string;
          reason_code: string | null;
          detail: Record<string, unknown>;
          created_at: Date;
        }>(
          "SELECT task_id, kind, reason_code, detail, created_at FROM runtime.agent_audit WHERE run_id = $1 AND task_id IS NOT NULL AND kind IN ('tool.rejected','limit.rejected') ORDER BY created_at, id",
          [req.params.id],
        )
      ).rows;

      const sharing = new Map<string, number>();
      for (const t of tasks) sharing.set(t.hypothesis_id, (sharing.get(t.hypothesis_id) ?? 0) + 1);
      const costOf = (taskId: string) => {
        const g = (kind: string) => ledger.find((l) => l.task_id === taskId && l.kind === kind);
        const pick = (l: ReturnType<typeof g>) => ({
          usd: n(l?.usd),
          tokens: n(l?.tokens),
          toolCalls: n(l?.tool_calls),
          entries: n(l?.entries),
        });
        const charged = pick(g("charge"));
        return {
          charged,
          reserved: pick(g("reserve")),
          released: pick(g("release")),
          hasLedger: charged.entries + n(g("reserve")?.entries) > 0,
        };
      };
      const view = tasks.map((t) => {
        const c = costOf(t.id);
        const shared = (sharing.get(t.hypothesis_id) ?? 1) > 1;
        return {
          taskId: t.id,
          parentTaskId: t.parent_task_id,
          role: t.role,
          depth: t.depth,
          status: t.status,
          objective: t.objective,
          outputRef: t.output_ref,
          startedAt: iso(t.created_at),
          endedAt: TERMINAL.has(t.status) ? iso(t.updated_at) : null,
          // `usd: null` when the ledger holds no entry for the task: unknown is not zero.
          cost: c.hasLedger
            ? {
                usd: c.charged.usd,
                tokens: c.charged.tokens,
                toolCalls: c.charged.toolCalls,
                reservedUsd: c.reserved.usd,
                releasedUsd: c.released.usd,
              }
            : { usd: null, tokens: null, toolCalls: null, reservedUsd: null, releasedUsd: null },
          toolCalls: calls
            .filter((x) => x.hypothesis_id === t.hypothesis_id)
            .map((x) => ({ n: x.n, tool: x.tool, at: iso(x.created_at), callKey: x.call_key })),
          toolCallAttribution: shared ? ("shared_hypothesis" as const) : ("task" as const),
          rejectedToolCalls: rejected
            .filter((x) => x.task_id === t.id)
            .map((x) => ({
              kind: x.kind,
              reasonCode: x.reason_code,
              tool: typeof x.detail?.tool === "string" ? x.detail.tool : null,
              at: iso(x.created_at),
            })),
        };
      });
      const chargedUsd = ledger.filter((l) => l.kind === "charge").reduce((a, l) => a + n(l.usd), 0);
      return {
        runId: req.params.id,
        workspaceId: run.workspace_id,
        tasks: view,
        totals: { chargedUsd, toolCalls: calls.length, tasks: tasks.length },
      };
    });
  });
};
