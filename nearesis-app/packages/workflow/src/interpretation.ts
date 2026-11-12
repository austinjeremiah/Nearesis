/**
 * Interpretation stage of an investigation (final_master_prompt s10/s20). After the owner approved the panels and the
 * canvas patch was applied, an analyst reads the ACTUAL result rows of the run's panels and a skeptic challenges what the
 * analyst wrote. The rows are read through the kernel tool gateway (`semantic.query@1`, a read-only capability held under a
 * derived lease), never by re-querying raw SQL; the model never sees more than a bounded digest and every number it writes
 * must recompute from a cited result cell (see @nearesis/agent-runtime interpretation).
 *
 * The stage degrades, it does not fail the run: a timeout, a budget refusal or a model with no groundable finding leaves the
 * panels untouched and records `interpretation unavailable` with the reason.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { guardInference, modelPolicyFromEnv } from "@nearesis/kernel";
import type {
  AnalyticsOkResult,
  DataFrameEnvelope,
  ExecutionRequest,
  InferenceProvider,
  InterpretedFinding,
  ToolGateway,
} from "@nearesis/contracts";
import {
  LedgerInference,
  interpretRun,
  sha256Hex,
  withTenant,
  type CostGovernor,
  type InterpretationOutcome,
  type LeaseBroker,
  type PanelResult,
  type Supervisor,
} from "@nearesis/agent-runtime";

/** Deterministic agent actor that reads the run's panel results (a semantic_analyst principal under a derived lease). */
export function interpreterActorId(runId: string): string {
  const h = sha256Hex(`run-interpreter:${runId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The executable query behind each previewed panel, recorded with the composer's proposal. */
export interface PanelQuery {
  panelId: string;
  title: string;
  query: unknown;
}
export function previewQueriesOf(input: unknown): PanelQuery[] {
  const reqs = (input as { requests?: Array<Record<string, unknown>> } | null)?.requests;
  if (!Array.isArray(reqs)) return [];
  return reqs
    .filter((r) => typeof r.panelId === "string" && r.query && typeof r.query === "object")
    .map((r) => ({
      panelId: r.panelId as string,
      title: String(r.title ?? "").slice(0, 180),
      query: r.query,
    }));
}

/** An analytics-capability call that produced a panel (ANALYTICS_RESULT): re-executed through the gateway for its rows. */
export interface AnalyticsCallRecord {
  callHash: string;
  capability: string;
  input: unknown;
}
export function analyticsCallOf(
  capability: string,
  input: unknown,
  payload: unknown,
): AnalyticsCallRecord | null {
  const p = payload as { ok?: boolean; outcome?: string; callHash?: string } | null;
  return p?.ok && p.outcome === "OK" && typeof p.callHash === "string"
    ? { callHash: p.callHash, capability, input }
    : null;
}

/** Where the findings go beyond the runtime tables: the evidence graph and the SSE stream (kernel-backed in production). */
export interface FindingSink {
  publish(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    findings: InterpretedFinding[];
    /** Query node material: one entry per distinct panel query the findings cite. */
    queries: Array<{
      queryHash: string;
      semanticVersion: string;
      panelId: string;
      title: string;
      certification: string;
    }>;
  }): Promise<void>;
}

export interface InterpretationDeps {
  pool: pg.Pool;
  gateway: ToolGateway;
  leases: LeaseBroker;
  supervisor: Supervisor;
  provider: InferenceProvider;
  model: string;
  cost?: CostGovernor;
  sink?: FindingSink;
  onProviderResult?: ConstructorParameters<typeof LedgerInference>[3]["onProviderResult"];
  clock?: () => string;
  analystTimeoutMs?: number;
  skepticTimeoutMs?: number;
  /** Bound on concurrent panel reads. */
  readConcurrency?: number;
}

export interface InterpretInputs {
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  directorTaskId: string;
  question: string;
  signal?: AbortSignal;
}

export interface InterpretationSummary {
  state: "ready" | "unavailable" | "none";
  reason: string | null;
  findingCount: number;
}

interface PanelRef {
  panelId: string;
  title: string;
  hash: string;
  completeness: PanelResult["completeness"];
  analytics: boolean;
}

function panelsOfProposal(proposal: unknown): {
  panels: PanelRef[];
  queries: Map<string, PanelQuery>;
  analytics: Map<string, AnalyticsCallRecord>;
} {
  const p = proposal as {
    patch?: { operations?: Array<Record<string, unknown>> };
    queries?: PanelQuery[];
    analyticsCalls?: AnalyticsCallRecord[];
  } | null;
  const panels: PanelRef[] = [];
  for (const op of p?.patch?.operations ?? []) {
    if (op.op !== "addPanel") continue;
    const sp = op.panel as {
      panelId?: string;
      title?: string;
      queryRef?: { hash?: string; resultKind?: string };
      dataBinding?: { completeness?: PanelResult["completeness"] };
    };
    if (!sp?.panelId || !sp.queryRef?.hash) continue;
    panels.push({
      panelId: sp.panelId,
      title: sp.title ?? "Panel",
      hash: sp.queryRef.hash,
      completeness: sp.dataBinding?.completeness ?? "partial",
      analytics: sp.queryRef.resultKind === "analytics_result",
    });
  }
  return {
    panels,
    queries: new Map((p?.queries ?? []).map((q) => [q.panelId, q])),
    analytics: new Map((p?.analyticsCalls ?? []).map((c) => [c.callHash, c])),
  };
}

const COLUMN_TYPES = new Set(["time", "string", "number", "decimal", "boolean"]);

export function panelResultOf(ref: PanelRef, env: DataFrameEnvelope): PanelResult {
  return {
    panelId: ref.panelId,
    title: ref.title,
    queryHash: env.queryHash,
    semanticVersion: env.semanticVersion,
    columns: env.columns.map((c) => ({
      name: c.name,
      type: COLUMN_TYPES.has(c.type) ? c.type : "string",
      unit: c.unit,
    })),
    rows: env.rows as PanelResult["rows"],
    certification: env.certification,
    nullCount: env.nullCount,
    partialCount: env.partialCount,
    gaps: env.gaps,
    sourceWatermarks: env.sourceWatermarks,
    truncated: !!env.truncation,
    completeness: ref.completeness,
  };
}

/** An analytics (ANALYTICS_RESULT) table as a panel result: unknown days are gaps, never zeros; certification is never `certified`. */
export function analyticsResultOf(ref: PanelRef, a: AnalyticsOkResult): PanelResult {
  const days = (xs: string[]) =>
    xs.map((d) => ({ from: d, to: d, reason: "no coverage record (unknown, not zero)" }));
  return {
    panelId: ref.panelId,
    title: ref.title,
    queryHash: a.callHash,
    semanticVersion: a.provenance.metricVersion || "1.0.0",
    columns: a.table.columns.map((c) => ({
      name: c.name,
      type: c.type === "category" ? "string" : c.type,
      unit: c.unit,
    })),
    rows: a.table.rows,
    certification: "experimental",
    nullCount: a.table.rows.reduce((n, r) => n + r.filter((x) => x === null).length, 0),
    partialCount: a.coverage.incompleteDays.length,
    gaps: days(a.coverage.missingDays),
    sourceWatermarks: { analytics: a.provenance.asOf },
    truncated: a.table.truncated,
    completeness: a.coverage.state,
  };
}

/** Reads one panel's result through the gateway. Returns null (with why) when it cannot be read; never throws for a denied or failed read. */
async function readPanel(
  d: InterpretationDeps,
  i: InterpretInputs,
  actor: string,
  ref: PanelRef,
  call: { capability: string; input: unknown },
): Promise<{ ok: true; result: PanelResult } | { ok: false; why: string }> {
  const req: ExecutionRequest = {
    requestId: randomUUID(),
    idempotencyKey: `${i.runId}:interpret-read:${ref.panelId}`,
    tenantId: i.tenantId,
    workspaceId: i.workspaceId,
    actor: { kind: "agent", actorId: actor, parentRunId: i.runId },
    capability: call.capability,
    input: call.input,
    deadlineMs: 60_000,
    trace: { traceId: `${i.runId}/${actor}`, researchRunId: i.runId },
  };
  try {
    const r = await d.gateway.invoke(
      { kind: "agent", actorId: actor, orgId: i.tenantId, parentRunId: i.runId },
      req,
    );
    if (r.state !== "ok" && r.state !== "partial")
      return { ok: false, why: `read ${r.state}${r.reasonCode ? `: ${r.reasonCode}` : ""}` };
    if (call.capability !== "semantic.query@1") {
      const a = r.payload as { ok?: boolean; outcome?: string; error?: { reasonCode?: string } } | null;
      if (!a?.ok || a.outcome !== "OK")
        return { ok: false, why: `read refused: ${a?.error?.reasonCode ?? a?.outcome ?? "no table"}` };
      return { ok: true, result: analyticsResultOf(ref, a as unknown as AnalyticsOkResult) };
    }
    const payload = r.payload as {
      ok?: boolean;
      envelope?: DataFrameEnvelope;
      error?: { reasonCode?: string; message?: string };
    } | null;
    if (!payload?.ok || !payload.envelope)
      return { ok: false, why: `read refused: ${payload?.error?.reasonCode ?? "no envelope"}` };
    return { ok: true, result: panelResultOf(ref, payload.envelope) };
  } catch (e) {
    return { ok: false, why: `read failed: ${(e as Error).message.slice(0, 120)}` };
  }
}

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= xs.length) return;
        out[k] = await f(xs[k]!);
      }
    }),
  );
  return out;
}

export async function runInterpretation(
  d: InterpretationDeps,
  i: InterpretInputs,
): Promise<InterpretationSummary> {
  // Replay-safe: a retried activity returns the recorded outcome instead of paying for a second model call.
  const done = await withTenant(d.pool, i.tenantId, async (c) => {
    const r = await c.query<{
      state: InterpretationSummary["state"];
      reason: string | null;
      finding_count: number;
    }>("SELECT state, reason, finding_count FROM run_interpretation WHERE run_id = $1", [i.runId]);
    return r.rows[0];
  });
  if (done) return { state: done.state, reason: done.reason, findingCount: done.finding_count };

  const composed = await withTenant(d.pool, i.tenantId, async (c) => {
    const r = await c.query<{ proposal: unknown }>(
      "SELECT result->'result'->'proposal' AS proposal FROM tasks WHERE run_id=$1 AND role='composer' AND status='DONE' ORDER BY created_at LIMIT 1",
      [i.runId],
    );
    return r.rows[0]?.proposal ?? null;
  });
  const { panels, queries, analytics } = panelsOfProposal(composed);
  const callFor = (p: PanelRef): { capability: string; input: unknown } | null => {
    if (p.analytics) {
      const c = analytics.get(p.hash);
      return c ? { capability: c.capability, input: c.input } : null;
    }
    const q = queries.get(p.panelId);
    return q ? { capability: "semantic.query@1", input: q.query } : null;
  };

  let outcome: InterpretationOutcome;
  const usedQueries: Array<{
    queryHash: string;
    semanticVersion: string;
    panelId: string;
    title: string;
    certification: string;
  }> = [];
  const readable = panels.filter((p) => callFor(p) !== null);
  if (!readable.length) {
    outcome = {
      state: "none",
      reason: panels.length ? "PANEL_QUERIES_NOT_RECORDED" : "NO_PANELS",
      findings: [],
      rejected: [],
    };
  } else {
    const actor = interpreterActorId(i.runId);
    await d.leases.ensureChild({
      tenantId: i.tenantId,
      workspaceId: i.workspaceId,
      runId: i.runId,
      parentTaskId: i.directorTaskId,
      taskId: actor,
      role: "semantic_analyst",
      capabilities: ["semantic.query@1", "intents.analyze@1", "entities.analyze@1", "accounts.analyze@1"],
    });
    const reads = await mapLimit(readable, d.readConcurrency ?? 4, (p) =>
      readPanel(d, i, actor, p, callFor(p)!),
    );
    const results = reads.flatMap((r) => (r.ok ? [r.result] : []));
    const failures = reads.flatMap((r, k) => (r.ok ? [] : [`${readable[k]!.title}: ${r.why}`]));
    if (!results.length) {
      outcome = {
        state: "unavailable",
        reason: `PANEL_READ_FAILED: ${failures[0] ?? "no panel could be read"}`.slice(0, 280),
        findings: [],
        rejected: [],
      };
    } else {
      const inference = new LedgerInference(
        guardInference(d.provider, modelPolicyFromEnv()),
        d.pool,
        d.supervisor,
        {
          tenantId: i.tenantId,
          workspaceId: i.workspaceId,
          runId: i.runId,
          budgetId: i.budgetId,
          taskId: i.directorTaskId,
          model: d.model,
          ...(d.onProviderResult ? { onProviderResult: d.onProviderResult } : {}),
          ...(i.signal ? { signal: i.signal } : {}),
        },
        d.cost,
      );
      outcome = await interpretRun({
        tenantId: i.tenantId,
        workspaceId: i.workspaceId,
        runId: i.runId,
        question: i.question,
        panels: results,
        model: inference,
        ...(d.clock ? { clock: d.clock } : {}),
        ...(d.analystTimeoutMs ? { analystTimeoutMs: d.analystTimeoutMs } : {}),
        ...(d.skepticTimeoutMs ? { skepticTimeoutMs: d.skepticTimeoutMs } : {}),
      });
      // a panel that could not be read is a stated limitation of every finding, not a silent omission
      if (outcome.state === "ready" && failures.length)
        outcome = {
          ...outcome,
          findings: outcome.findings.map((f) => ({
            ...f,
            limitations: [
              ...f.limitations,
              ...failures.map((x) => `A panel could not be read for interpretation (${x}).`),
            ].slice(0, 50),
          })),
        };
      for (const r of results)
        usedQueries.push({
          queryHash: r.queryHash,
          semanticVersion: r.semanticVersion,
          panelId: r.panelId,
          title: r.title,
          certification: r.certification,
        });
    }
  }

  await withTenant(d.pool, i.tenantId, async (c) => {
    for (const [pos, f] of outcome.findings.entries())
      await c.query(
        "INSERT INTO run_findings (id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (run_id, position) DO NOTHING",
        [f.id, i.tenantId, i.workspaceId, i.runId, pos, JSON.stringify(f)],
      );
    await c.query(
      `INSERT INTO run_interpretation (run_id, tenant_id, workspace_id, state, reason, finding_count, rejected)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (run_id) DO NOTHING`,
      [
        i.runId,
        i.tenantId,
        i.workspaceId,
        outcome.state,
        outcome.reason,
        outcome.findings.length,
        JSON.stringify(outcome.rejected),
      ],
    );
  });

  // Evidence graph + SSE are best effort: the findings are already durable and readable from the run.
  if (outcome.findings.length && d.sink)
    await d.sink
      .publish({
        tenantId: i.tenantId,
        workspaceId: i.workspaceId,
        runId: i.runId,
        findings: outcome.findings,
        queries: usedQueries,
      })
      .catch(() => undefined);
  return { state: outcome.state, reason: outcome.reason, findingCount: outcome.findings.length };
}
