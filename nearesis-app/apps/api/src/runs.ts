import { createHash, randomUUID } from "node:crypto";
import { MIN_QUESTION_BUDGET, SubmitQuestionRequest } from "@nearesis/contracts";
import type {
  InterpretedFinding,
  RunBudgetUsage,
  RunInterpretation,
  RunListResponse,
  SourceListResponse,
  WorkspaceListResponse,
} from "@nearesis/contracts";
import { KernelError, canWrite, redact, writeAudit, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session, Tx } from "@nearesis/kernel";
import { z } from "zod";
import type { Occupancy, Priority, TenantAdmission } from "./overload/index.ts";

/** The slice of @nearesis/workflow the API needs. The real implementation is `temporalEngine()` (src/temporal-engine.ts). */
export interface InvestigationEngine {
  start(input: {
    workspaceId: string;
    investigationId: string;
    questionId: string;
    snapshotRef: string;
    budgetId: string;
    tenantId: string;
    runId: string;
    question: string;
    source?: "fixture" | "live";
    preregistrationHash?: string;
    grants?: string[];
  }): Promise<{ runId: string; workflowId: string }>;
  /** Signal names are the workflow's: `approve`, `reject`, `cancel`. */
  signal(
    workflowId: string,
    name: "approve" | "reject" | "cancel",
    payload: Record<string, unknown>,
  ): Promise<void>;
}

/** Run states in which agents are actually executing. A run waiting for a human decision holds no slot. */
const OCCUPYING_STATES = ["REQUESTED", "PLANNING", "EXECUTING", "EVIDENCE_REVIEW", "CANVAS_PATCH_REVIEW"];
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

const TERMINAL_STATES = new Set(["COMPLETE", "PARTIAL", "BLOCKED", "BLOCKED_SOURCE", "CANCELLED"]);

export const notFound = (): KernelError => new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");

/** Deterministic UUID (v4-shaped) from a seed, so an Idempotency-Key maps to one run. */
function deriveUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function runtimeUnavailable(e: unknown): never {
  const c = (e as { code?: string } | null)?.code;
  if (c === "42P01" || c === "3F000" || c === "42501")
    throw new KernelError(
      "UPSTREAM_DEGRADED",
      "RUNTIME_UNAVAILABLE",
      "Run state is temporarily unavailable.",
      {
        retryable: true,
        nextAction: "Retry shortly.",
      },
    );
  throw e;
}

interface RunRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  budget_id?: string;
  state: string;
  /** Which semantic layer the run's agents query: the SYNTHETIC fixture cubes or the LIVE real-data layer. */
  source?: string;
  /** The run's frozen dispatch hashes (question, snapshot, metric-version map, preregistration), once bound. */
  context?: { hashes?: Record<string, string> } | null;
  failure: unknown;
  result: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalView {
  approvalId: string;
  actionHash: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  kind: string | null;
  network: string | null;
  costLimit: number | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

const CancelBody = z.strictObject({ expectedVersion: z.number().int().nonnegative().optional() });
const DecisionBody = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  actionHash: z.string().min(1).max(200),
});

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
      details: zodDetails(r.error),
    });
  return r.data;
}

/**
 * Investigation API (ch.11): questions, run reads, cancel and approvals. Runs are owned by @nearesis/workflow; this class
 * only starts and signals workflows through `InvestigationEngine` and reads the `runtime` schema (read-only), except for
 * the budget row a question needs. Access is the kernel's: a run is visible only to members of its workspace, and a
 * foreign run is indistinguishable from an unknown one (404).
 */
export class RunsService {
  constructor(
    private readonly kernel: Kernel,
    private readonly engine: InvestigationEngine,
    /** Per-tenant concurrency cap and bounded wait queue for new investigations (ch.13 Backpressure). Absent = uncapped. */
    public admission?: TenantAdmission,
  ) {}

  /** What the admission controller compares with the cap: this tenant's unfinished runs, read from the runtime schema. */
  occupancyOf = async (tenantId: string, heldIds: string[]): Promise<Occupancy> => {
    try {
      return await this.kernel.db.tx(
        { orgId: tenantId, userId: SYSTEM_USER, actorKind: "service" },
        async (tx) => {
          const active = await tx.query<{ id: string }>(
            "SELECT id::text AS id FROM runtime.runs WHERE tenant_id = $1 AND state = ANY($2::text[])",
            [tenantId, OCCUPYING_STATES],
          );
          const held = heldIds.length
            ? await tx.query<{ id: string }>(
                "SELECT id::text AS id FROM runtime.runs WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND NOT (state = ANY($3::text[]))",
                [tenantId, heldIds, OCCUPYING_STATES],
              )
            : { rows: [] as Array<{ id: string }> };
          return { activeIds: active.rows.map((r) => r.id), terminalIds: held.rows.map((r) => r.id) };
        },
      );
    } catch (e) {
      // No runtime schema (or no access) means no run is recorded: only this process's own admissions count.
      const c = (e as { code?: string } | null)?.code;
      if (c === "42P01" || c === "3F000" || c === "42501") return { activeIds: [], terminalIds: [] };
      throw e;
    }
  };

  /** True when this Idempotency-Key already produced a run: a replay must not take (or wait for) a new slot. */
  private async runExists(s: Session, runId: string): Promise<boolean> {
    try {
      return await this.kernel.db.tx(this.ctx(s), async (tx) => {
        const r = await tx.query("SELECT 1 FROM runtime.runs WHERE id = $1", [runId]);
        return r.rows.length > 0;
      });
    } catch {
      return false;
    }
  }

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId };
  }

  /** Loads a run the caller may see; throws the uniform 404 otherwise. Caller holds a tenant tx. */
  private async load(tx: Tx, s: Session, runId: string): Promise<RunRow> {
    let run: RunRow | undefined;
    try {
      run = (await tx.query<RunRow>("SELECT * FROM runtime.runs WHERE id = $1", [runId])).rows[0];
    } catch (e) {
      runtimeUnavailable(e);
    }
    if (!run) throw notFound();
    // Workspace membership is the kernel's RLS: same-org non-members and foreign orgs see no row.
    const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [run.workspace_id]);
    if (!ws.rows[0]) throw notFound();
    void s;
    return run;
  }

  private async version(tx: Tx, runId: string): Promise<number> {
    const r = await tx.query<{ v: number }>(
      "SELECT COALESCE(MAX(seq), 0)::int AS v FROM runtime.run_events WHERE run_id = $1 AND source = 'run'",
      [runId],
    );
    return r.rows[0]!.v;
  }

  async submitQuestion(
    s: Session,
    workspaceId: string,
    rawBody: unknown,
    opts: { idempotencyKey?: string; priority?: Priority } = {},
  ): Promise<{ runId: string; workflowId: string }> {
    const body = parse(SubmitQuestionRequest, rawBody);
    const min = MIN_QUESTION_BUDGET;
    if (body.budget.tokens < min.tokens || body.budget.toolCalls < min.toolCalls || body.budget.usd < min.usd)
      throw new KernelError(
        "VALIDATION_FAILED",
        "BUDGET_BELOW_MINIMUM",
        `Budget is below the minimum the runtime must reserve (${min.tokens} tokens, ${min.toolCalls} tool calls, USD ${min.usd}).`,
        {
          details: [{ path: "budget", issue: "below minimum" }],
          nextAction: "Raise the budget and resubmit.",
        },
      );
    const key = opts.idempotencyKey;
    if (key !== undefined && (key.length < 8 || key.length > 200))
      throw new KernelError(
        "VALIDATION_FAILED",
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must be 8-200 characters.",
      );
    const seed = key === undefined ? undefined : `${s.principal.orgId}:${workspaceId}:${key}`;
    const id = (label: string) => (seed ? deriveUuid(`${seed}:${label}`) : randomUUID());
    const ids = {
      runId: id("run"),
      investigationId: id("investigation"),
      questionId: id("question"),
      budgetId: id("budget"),
    };

    // Overload protection: take a per-tenant investigation slot (or wait in the bounded queue, or get 429 + Retry-After)
    // before anything is written. A replayed Idempotency-Key returns the original run and takes no slot.
    let ticket: Awaited<ReturnType<TenantAdmission["admit"]>> | undefined;
    if (this.admission && !(seed && (await this.runExists(s, ids.runId))))
      ticket = await this.admission.admit(s.principal.orgId, {
        priority: opts.priority ?? body.priority ?? "normal",
      });
    try {
      return await this.submitAdmitted(s, workspaceId, body, ids, seed, ticket);
    } finally {
      ticket?.release(); // a no-op once the run is committed to the slot
    }
  }

  private async submitAdmitted(
    s: Session,
    workspaceId: string,
    body: z.infer<typeof SubmitQuestionRequest>,
    ids: { runId: string; investigationId: string; questionId: string; budgetId: string },
    seed: string | undefined,
    ticket: { commit(runId: string): void } | undefined,
  ): Promise<{ runId: string; workflowId: string }> {
    const snapshotRef = await this.kernel.db.tx(this.ctx(s), async (tx) => {
      const ws = (
        await tx.query<{ version: number }>("SELECT version FROM workspaces WHERE id = $1", [workspaceId])
      ).rows[0];
      if (!ws) throw notFound();
      if (!canWrite(s.role))
        throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted to ask questions.");
      try {
        await tx.query(
          `INSERT INTO runtime.budgets (id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [
            ids.budgetId,
            s.principal.orgId,
            workspaceId,
            body.budget.tokens,
            body.budget.toolCalls,
            body.budget.usd,
          ],
        );
      } catch (e) {
        runtimeUnavailable(e);
      }
      await writeAudit(tx, {
        orgId: s.principal.orgId,
        workspaceId,
        actorId: s.userId,
        action: "question.submitted",
        subject: ids.runId,
        outcome: "ok",
        detail: {
          runId: ids.runId,
          snapshotPolicy: body.snapshotPolicy,
          source: body.source,
          budget: body.budget,
        },
      });
      return `${body.snapshotPolicy}:ws-v${ws.version}`;
    });

    try {
      const started = await this.engine.start({
        workspaceId,
        investigationId: ids.investigationId,
        questionId: ids.questionId,
        snapshotRef,
        budgetId: ids.budgetId,
        tenantId: s.principal.orgId,
        runId: ids.runId,
        question: body.question,
        source: body.source,
        ...(body.preregistrationHash ? { preregistrationHash: body.preregistrationHash } : {}),
        ...(body.grants ? { grants: body.grants } : {}),
      });
      ticket?.commit(started.runId);
      return started;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "WorkflowExecutionAlreadyStartedError" && seed)
        // Same Idempotency-Key replayed: the ids are deterministic, so this is the original run.
        return { runId: ids.runId, workflowId: `investigation-${ids.investigationId}-${ids.questionId}` };
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "WORKFLOW_UNAVAILABLE",
        "Could not start the investigation.",
        {
          retryable: true,
          nextAction: "Retry with the same Idempotency-Key.",
        },
      );
    }
  }

  /** Spent (charges) and open reservations (reserve minus release) against the run's budget row. Read-only. */
  private async budgetUsage(tx: Tx, run: RunRow & { budget_id?: string }): Promise<RunBudgetUsage> {
    const total = (
      await tx.query<{ t: string; c: string; u: string }>(
        "SELECT tokens_total::text AS t, tool_calls_total::text AS c, usd_total::text AS u FROM runtime.budgets WHERE id = $1",
        [run.budget_id ?? null],
      )
    ).rows[0];
    const l = (
      await tx.query<{ st: string; sc: string; su: string; rt: string; rc: string; ru: string }>(
        `SELECT COALESCE(SUM(tokens) FILTER (WHERE kind='charge'),0)::text AS st,
                COALESCE(SUM(tool_calls) FILTER (WHERE kind='charge'),0)::text AS sc,
                COALESCE(SUM(usd) FILTER (WHERE kind='charge'),0)::text AS su,
                COALESCE(SUM(CASE kind WHEN 'reserve' THEN tokens WHEN 'release' THEN -tokens ELSE 0 END),0)::text AS rt,
                COALESCE(SUM(CASE kind WHEN 'reserve' THEN tool_calls WHEN 'release' THEN -tool_calls ELSE 0 END),0)::text AS rc,
                COALESCE(SUM(CASE kind WHEN 'reserve' THEN usd WHEN 'release' THEN -usd ELSE 0 END),0)::text AS ru
           FROM runtime.budget_ledger WHERE run_id = $1`,
        [run.id],
      )
    ).rows[0]!;
    const n = (v: string | undefined) => Math.max(0, Number(v ?? 0));
    return {
      total: { tokens: n(total?.t), toolCalls: n(total?.c), usd: n(total?.u) },
      spent: { tokens: n(l.st), toolCalls: n(l.sc), usd: n(l.su) },
      reserved: { tokens: n(l.rt), toolCalls: n(l.rc), usd: n(l.ru) },
    };
  }

  /** Non-archived workspaces of the caller's org, newest first (RLS scopes the rows to the org). Read-only. */
  async listWorkspaces(s: Session): Promise<WorkspaceListResponse> {
    return this.kernel.db.tx(this.ctx(s), async (tx) => {
      const r = await tx.query<{ id: string; objective: string; network_scope: string; created_at: Date }>(
        "SELECT id, objective, network_scope, created_at FROM workspaces WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 100",
      );
      return {
        workspaces: r.rows.map((w) => ({
          id: w.id,
          objective: w.objective,
          networkScope: w.network_scope,
          createdAt: new Date(w.created_at).toISOString(),
        })),
      };
    });
  }

  /** Investigations of a workspace, newest first (sidebar). A workspace the caller cannot see is a 404. */
  async listRuns(s: Session, workspaceId: string): Promise<RunListResponse> {
    return this.kernel.db.tx(this.ctx(s), async (tx) => {
      const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (!ws.rows[0]) throw notFound();
      let rows: Array<{
        id: string;
        state: string;
        created_at: Date;
        updated_at: Date;
        objective: string | null;
        scenario: string | null;
      }>;
      try {
        rows = (
          await tx.query<(typeof rows)[number]>(
            `SELECT r.id, r.state, r.created_at, r.updated_at, r.scenario,
                    (SELECT t.objective FROM runtime.tasks t WHERE t.run_id = r.id AND t.objective IS NOT NULL
                      ORDER BY t.depth, t.created_at, t.id LIMIT 1) AS objective
               FROM runtime.runs r WHERE r.workspace_id = $1 ORDER BY r.created_at DESC, r.id LIMIT 100`,
            [workspaceId],
          )
        ).rows;
      } catch (e) {
        runtimeUnavailable(e);
      }
      return {
        workspaceId,
        runs: rows.map((r) => ({
          runId: r.id,
          questionSummary: (r.objective ?? r.scenario ?? `Investigation ${r.id.slice(0, 8)}`)
            .replace(/^\[scenario=[^\]]*\]\s*/, "")
            .slice(0, 200),
          state: r.state as RunListResponse["runs"][number]["state"],
          terminal: TERMINAL_STATES.has(r.state),
          startedAt: r.created_at.toISOString(),
          updatedAt: r.updated_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Per-source freshness. The kernel keeps no source watermark table and apps/api has no path to the semantic gateway
   * (FND-20261110-041), so the list is empty; the web BFF serves watermarks from /api/semantic/watermarks.
   */
  async listSources(s: Session, workspaceId: string): Promise<SourceListResponse> {
    return this.kernel.db.tx(this.ctx(s), async (tx) => {
      const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (!ws.rows[0]) throw notFound();
      return { workspaceId, sources: [] };
    });
  }

  /**
   * Findings of the interpretation stage and its run-level state. A database without the findings tables (migration 007 not
   * applied yet) reads as "no interpretation", never as an error: the run itself must stay readable.
   */
  private async findingsOf(
    tx: Tx,
    runId: string,
  ): Promise<{ findings: InterpretedFinding[]; interpretation: RunInterpretation }> {
    const none = { findings: [], interpretation: { state: "none" as const, reason: null, findingCount: 0 } };
    try {
      await tx.query("SAVEPOINT run_findings_read");
      const rows = (
        await tx.query<{ finding: InterpretedFinding }>(
          "SELECT finding FROM runtime.run_findings WHERE run_id = $1 ORDER BY position",
          [runId],
        )
      ).rows;
      const st = (
        await tx.query<{ state: RunInterpretation["state"]; reason: string | null; finding_count: number }>(
          "SELECT state, reason, finding_count FROM runtime.run_interpretation WHERE run_id = $1",
          [runId],
        )
      ).rows[0];
      await tx.query("RELEASE SAVEPOINT run_findings_read");
      return {
        findings: rows.map((r) => r.finding),
        interpretation: st
          ? { state: st.state, reason: st.reason, findingCount: st.finding_count }
          : { state: "none", reason: null, findingCount: rows.length },
      };
    } catch (e) {
      await tx.query("ROLLBACK TO SAVEPOINT run_findings_read").catch(() => undefined);
      const c = (e as { code?: string } | null)?.code;
      if (c === "42P01" || c === "3F000" || c === "42501") return none;
      throw e;
    }
  }

  async getRun(s: Session, runId: string) {
    return this.kernel.db.tx(this.ctx(s), async (tx) => {
      const run = await this.load(tx, s, runId);
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
        }>(
          `SELECT id, parent_task_id, role, depth, status, hypothesis_id, objective, output_ref
             FROM runtime.tasks WHERE run_id = $1 ORDER BY created_at, id`,
          [runId],
        )
      ).rows;
      const view = (t: (typeof tasks)[number]) => ({
        taskId: t.id,
        parentTaskId: t.parent_task_id,
        role: t.role,
        depth: t.depth,
        status: t.status,
        hypothesisId: t.hypothesis_id,
        objective: t.objective,
        outputRef: t.output_ref,
      });
      const children = tasks.filter((t) => t.depth > 0).map(view);
      const root = tasks.find((t) => t.depth === 0);
      return {
        runId: run.id,
        workspaceId: run.workspace_id,
        workflowId: run.workflow_id,
        state: run.state,
        terminal: TERMINAL_STATES.has(run.state),
        /** Provenance of every number in this run: `live` real data or `fixture` (SYNTHETIC) data (ch.16 G10 B02). */
        source: run.source === "live" ? "live" : "fixture",
        context: run.context?.hashes ?? null,
        version: await this.version(tx, runId),
        failure: run.failure ?? null,
        result: run.result === null ? null : redact(run.result),
        rootTask: root ? view(root) : null,
        children,
        evidenceLinks: children
          .filter((c) => c.outputRef)
          .map((c) => ({ taskId: c.taskId, outputRef: c.outputRef })),
        createdAt: run.created_at.toISOString(),
        updatedAt: run.updated_at.toISOString(),
        budget: await this.budgetUsage(tx, run),
        ...(await this.findingsOf(tx, runId)),
      };
    });
  }

  async cancel(s: Session, runId: string, rawBody: unknown, ifMatchVersion?: number) {
    const body = parse(CancelBody, rawBody);
    if (
      body.expectedVersion !== undefined &&
      ifMatchVersion !== undefined &&
      body.expectedVersion !== ifMatchVersion
    )
      throw new KernelError(
        "VALIDATION_FAILED",
        "VERSION_MISMATCH",
        "If-Match and body expectedVersion disagree.",
      );
    const expected = body.expectedVersion ?? ifMatchVersion;
    if (expected === undefined)
      throw new KernelError(
        "VALIDATION_FAILED",
        "EXPECTED_VERSION_REQUIRED",
        "expectedVersion (or If-Match) is required.",
        {
          details: [{ path: "expectedVersion", issue: "required" }],
        },
      );
    const run = await this.kernel.db.tx(this.ctx(s), async (tx) => {
      const run = await this.load(tx, s, runId);
      if (!canWrite(s.role))
        throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted to cancel runs.");
      const v = await this.version(tx, runId);
      if (v !== expected)
        throw new KernelError("STALE_VERSION", "STALE_VERSION", "Run changed since it was read.", {
          retryable: true,
          lastStableRevision: v,
          nextAction: "Re-read the run and resubmit with the current version.",
        });
      if (TERMINAL_STATES.has(run.state))
        throw new KernelError("DOMAIN_INVARIANT", "RUN_NOT_CANCELLABLE", `Run is already ${run.state}.`);
      return run;
    });
    await this.signal(run.workflow_id, "cancel", { requestedBy: s.userId });
    await this.record(s, run, "run.cancel_requested", "run.state_changed", {
      runId,
      change: "cancel_requested",
    });
    return {
      runId,
      workflowId: run.workflow_id,
      state: run.state,
      cancelRequested: true,
      requestedBy: s.userId,
      version: expected,
    };
  }

  /** Approval requests derived from the run's event log (`approval.requested` / `approval.invalidated`) and decisions. */
  private async approvalViews(tx: Tx, run: RunRow): Promise<ApprovalView[]> {
    const events = (
      await tx.query<{ id: string; kind: string; detail: Record<string, unknown>; created_at: Date }>(
        `SELECT id, kind, detail, created_at FROM runtime.run_events
          WHERE run_id = $1 AND source = 'run' AND kind IN ('approval.requested','approval.invalidated')
          ORDER BY seq`,
        [run.id],
      )
    ).rows;
    const decisions = (
      await tx.query<{
        action_hash: string;
        decision: "approve" | "reject";
        approved_by: string;
        created_at: Date;
      }>(
        "SELECT action_hash, decision, approved_by, created_at FROM runtime.approvals WHERE run_id = $1 ORDER BY id",
        [run.id],
      )
    ).rows;
    let base: { kind: string | null; network: string | null; costLimit: number | null } = {
      kind: null,
      network: null,
      costLimit: null,
    };
    const views: ApprovalView[] = [];
    events.forEach((ev, i) => {
      const d = ev.detail ?? {};
      const hash = String(ev.kind === "approval.requested" ? d.actionHash : d.newActionHash);
      if (ev.kind === "approval.requested")
        base = {
          kind: typeof d.kind === "string" ? d.kind : null,
          network: typeof d.network === "string" ? d.network : null,
          costLimit: typeof d.costLimit === "number" ? d.costLimit : null,
        };
      const decided = decisions.find((x) => x.action_hash === hash);
      const isCurrent = i === events.length - 1;
      views.push({
        approvalId: String(ev.id),
        actionHash: hash,
        status:
          isCurrent && run.state === "APPROVAL_NEEDED"
            ? "pending"
            : decided
              ? decided.decision === "approve"
                ? "approved"
                : "rejected"
              : "superseded",
        ...base,
        requestedAt: ev.created_at.toISOString(),
        decidedBy: decided?.approved_by ?? null,
        decidedAt: decided ? decided.created_at.toISOString() : null,
      });
    });
    return views;
  }

  async listApprovals(s: Session, runId: string, status: "pending" | "all" = "pending") {
    return this.kernel.db.tx(this.ctx(s), async (tx) => {
      const run = await this.load(tx, s, runId);
      const all = await this.approvalViews(tx, run);
      return {
        runId,
        state: run.state,
        approvals: status === "all" ? all : all.filter((a) => a.status === "pending"),
      };
    });
  }

  async decide(s: Session, runId: string, approvalId: string, rawBody: unknown) {
    const body = parse(DecisionBody, rawBody);
    if (!/^\d{1,18}$/.test(approvalId)) throw notFound();
    type Outcome = { ok: true; run: RunRow } | { ok: false; run: RunRow; error: KernelError };
    const out = await this.kernel.db.tx(this.ctx(s), async (tx): Promise<Outcome> => {
      const run = await this.load(tx, s, runId);
      if (!canWrite(s.role))
        throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted to decide approvals.");
      const views = await this.approvalViews(tx, run);
      const target = views.find((a) => a.approvalId === approvalId);
      if (!target) throw notFound();
      const current = views[views.length - 1];
      if (!current || target.approvalId !== current.approvalId || target.status !== "pending")
        return {
          ok: false,
          run,
          error: new KernelError(
            "STALE_VERSION",
            "APPROVAL_NOT_PENDING",
            "This approval request is no longer pending.",
            {
              nextAction: "List the run's approvals for the current request.",
            },
          ),
        };
      if (body.actionHash !== target.actionHash) {
        await writeAudit(tx, {
          orgId: s.principal.orgId,
          workspaceId: run.workspace_id,
          actorId: s.userId,
          action: "approval.hash_mismatch",
          subject: runId,
          outcome: "denied",
          reasonCode: "ACTION_HASH_MISMATCH",
          detail: { runId, approvalId, presented: body.actionHash.slice(0, 80), expected: target.actionHash },
        });
        return {
          ok: false,
          run,
          error: new KernelError(
            "STALE_VERSION",
            "ACTION_HASH_MISMATCH",
            "The action hash does not match the action awaiting approval.",
            { nextAction: "Re-read the pending approval and decide on its exact action hash." },
          ),
        };
      }
      // The kernel verifies approvals itself when an agent later applies the action (ch.05): record the exact hash.
      if (body.decision === "approve")
        await this.kernel.approvals.grant(tx, {
          orgId: s.principal.orgId,
          workspaceId: run.workspace_id,
          runId: run.id,
          actionHash: target.actionHash,
          approvedBy: s.userId,
        });
      return { ok: true, run };
    });
    if (!out.ok) throw out.error;
    await this.signal(
      out.run.workflow_id,
      body.decision,
      body.decision === "approve"
        ? { actionHash: body.actionHash, approvedBy: s.userId }
        : { actionHash: body.actionHash, rejectedBy: s.userId },
    );
    await this.record(
      s,
      out.run,
      `approval.${body.decision}`,
      body.decision === "approve" ? "approval.granted" : "approval.rejected",
      { runId, approvalId, actionHash: body.actionHash, decidedBy: s.userId },
    );
    return {
      runId,
      approvalId,
      decision: body.decision,
      actionHash: body.actionHash,
      decidedBy: s.userId,
      signalled: true,
    };
  }

  private async signal(
    workflowId: string,
    name: "approve" | "reject" | "cancel",
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.engine.signal(workflowId, name, payload);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "WorkflowNotFoundError")
        throw new KernelError("STALE_VERSION", "RUN_NOT_ACTIVE", "The run is no longer active.");
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "WORKFLOW_UNAVAILABLE",
        "Could not reach the workflow engine.",
        {
          retryable: true,
          nextAction: "Retry the request.",
        },
      );
    }
  }

  /** Audit + journal record of a delivered decision. Best effort: the signal already carried the decision. */
  private async record(
    s: Session,
    run: RunRow,
    action: string,
    eventType: "approval.granted" | "approval.rejected" | "run.state_changed",
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.kernel.db.tx(this.ctx(s), async (tx) => {
        await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [run.workspace_id]);
        await writeAudit(tx, {
          orgId: s.principal.orgId,
          workspaceId: run.workspace_id,
          actorId: s.userId,
          action,
          subject: run.id,
          outcome: "ok",
          detail: data,
        });
        await this.kernel.journal.append(tx, {
          orgId: s.principal.orgId,
          workspaceId: run.workspace_id,
          type: eventType,
          actorId: s.userId,
          data,
          causationId: run.id,
        });
      });
    } catch {
      /* the decision is already delivered; a failed audit write must not turn it into an error */
    }
  }
}
