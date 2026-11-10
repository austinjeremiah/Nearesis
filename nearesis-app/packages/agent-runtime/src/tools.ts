import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecutionRequest, ExecutionResponse, Principal, ToolGateway } from "@nearesis/contracts";
import type pg from "pg";
import { AgentRuntimeError } from "./errors.ts";
import { hashOf } from "./canonical.ts";
import { withTenant } from "./tenant.ts";
import type { AuditSink } from "./audit.ts";
import type { Policy } from "./policy.ts";

export interface ToolSpec {
  id: string;
  input: z.ZodType<unknown>;
  sideEffect: "read_only" | "workspace_write" | "paid_call" | "chain_write";
}

const s = z.string().min(1).max(2000);
const obj = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

/** Known tool catalog. A tool the model invents that is not here never reaches the gateway (A04). */
export const TOOL_CATALOG: ToolSpec[] = [
  { id: "agent.spawn@1", input: obj({ role: s, objective: s }), sideEffect: "workspace_write" },
  { id: "evidence.inspect@1", input: obj({ evidenceId: s }), sideEffect: "read_only" },
  { id: "evidence.read@1", input: obj({ evidenceId: s }), sideEffect: "read_only" },
  { id: "plan.propose@1", input: obj({ plan: z.record(z.string(), z.unknown()) }), sideEffect: "read_only" },
  { id: "semantic.discover@1", input: obj({ metrics: z.array(s).max(50) }), sideEffect: "read_only" },
  {
    id: "semantic.query@1",
    input: obj({ metric: s, from: s.optional(), to: s.optional() }),
    sideEffect: "read_only",
  },
  { id: "registry.read@1", input: obj({ key: s }), sideEffect: "read_only" },
  { id: "adapter.docs@1", input: obj({ adapter: s }), sideEffect: "read_only" },
  { id: "web.fetch_approved@1", input: obj({ url: s }), sideEffect: "read_only" },
  {
    id: "research.run_model@1",
    input: obj({ model: s, features: z.array(s).max(100) }),
    sideEffect: "read_only",
  },
  { id: "stats.read@1", input: obj({ metric: s }), sideEffect: "read_only" },
  { id: "research.run_bounded_test@1", input: obj({ test: s, claim: s }), sideEffect: "read_only" },
  { id: "source.read_verified@1", input: obj({ source: s }), sideEffect: "read_only" },
  {
    id: "canvas.preview@1",
    input: obj({ panelId: s, spec: z.record(z.string(), z.unknown()) }),
    sideEffect: "read_only",
  },
  {
    id: "canvas.patch@1",
    input: obj({ panelId: s, spec: z.record(z.string(), z.unknown()) }),
    sideEffect: "workspace_write",
  },
  { id: "monitor.read@1", input: obj({ ruleId: s }), sideEffect: "read_only" },
  { id: "investigation.start@1", input: obj({ question: s }), sideEffect: "workspace_write" },
  { id: "evidence.verify_hashes@1", input: obj({ manifest: s }), sideEffect: "read_only" },
  { id: "research.rerun@1", input: obj({ experimentId: s }), sideEffect: "read_only" },
  { id: "attest.validate@1", input: obj({ attestation: s }), sideEffect: "read_only" },
  { id: "export.build@1", input: obj({ template: s }), sideEffect: "workspace_write" },
  { id: "export.preview@1", input: obj({ template: s }), sideEffect: "read_only" },
];
export const TOOL_BY_ID = new Map(TOOL_CATALOG.map((t) => [t.id, t]));

/** A09: tool results and source text are DATA. Delimiters inside the content are neutralised. */
export function wrapAsData(origin: string, content: unknown): string {
  const text = (typeof content === "string" ? content : JSON.stringify(content)).replaceAll(
    "</untrusted_data",
    "<\\/untrusted_data",
  );
  return `<untrusted_data origin="${origin}" instruction_authority="none">\n${text}\n</untrusted_data>`;
}

/** Atomic, replay-safe per-hypothesis tool-call meter (A12 c). */
export class ToolCallMeter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: Policy,
    private readonly audit: AuditSink,
  ) {}

  async consume(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    taskId: string;
    hypothesisId: string;
    callKey: string;
    tool: string;
  }): Promise<number> {
    const n = await withTenant(this.pool, a.tenantId, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tc:${a.runId}:${a.hypothesisId}`]);
      const ex = await c.query<{ n: number }>(
        "SELECT n FROM tool_call_log WHERE run_id=$1 AND hypothesis_id=$2 AND call_key=$3",
        [a.runId, a.hypothesisId, a.callKey],
      );
      if (ex.rows[0]) return ex.rows[0].n;
      const cnt = await c.query<{ c: string }>(
        "SELECT count(*)::text AS c FROM tool_call_log WHERE run_id=$1 AND hypothesis_id=$2",
        [a.runId, a.hypothesisId],
      );
      const next = Number(cnt.rows[0]!.c) + 1;
      if (next > this.policy.maxToolCallsPerHypothesis) return -1;
      await c.query(
        "INSERT INTO tool_call_log (tenant_id, run_id, hypothesis_id, call_key, n, tool) VALUES ($1,$2,$3,$4,$5,$6)",
        [a.tenantId, a.runId, a.hypothesisId, a.callKey, next, a.tool],
      );
      return next;
    });
    if (n === -1) {
      await this.audit.write({
        tenantId: a.tenantId,
        workspaceId: a.workspaceId,
        runId: a.runId,
        taskId: a.taskId,
        kind: "limit.rejected",
        reasonCode: "TOOL_CALL_BUDGET",
        detail: { hypothesisId: a.hypothesisId, limit: this.policy.maxToolCallsPerHypothesis, tool: a.tool },
      });
      throw new AgentRuntimeError(
        "TOOL_CALL_BUDGET",
        `tool call ${this.policy.maxToolCallsPerHypothesis + 1} for hypothesis rejected`,
        { hypothesisId: a.hypothesisId },
      );
    }
    return n;
  }
}

export type ToolOutcome =
  | { ok: true; tool: string; response: ExecutionResponse; wrapped: string; resultHash: string }
  | { ok: false; tool: string; reasonCode: string; detail: string };

export interface ToolClientCtx {
  gateway: ToolGateway;
  audit: AuditSink;
  meter: ToolCallMeter;
  tenantId: string;
  workspaceId: string;
  runId: string;
  taskId: string;
  hypothesisId: string;
  role: string;
}

/**
 * Agent-side tool access. Local checks: catalog membership and input schema (A04); per-hypothesis budget (A12).
 * The gateway alone decides grants (the model can never alter authority, A09); the principal is built from
 * server-held context, never from model output.
 */
export class AgentToolClient {
  constructor(private readonly ctx: ToolClientCtx) {}

  async call(tool: string, input: unknown, callKey: string): Promise<ToolOutcome> {
    const c = this.ctx;
    const spec = TOOL_BY_ID.get(tool);
    const base = {
      tenantId: c.tenantId,
      workspaceId: c.workspaceId,
      runId: c.runId,
      taskId: c.taskId,
      actor: `agent:${c.role}`,
    };
    if (!spec) {
      await c.audit.write({ ...base, kind: "tool.rejected", reasonCode: "UNKNOWN_TOOL", detail: { tool } });
      return { ok: false, tool, reasonCode: "UNKNOWN_TOOL", detail: "tool not in catalog; not executed" };
    }
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) {
      await c.audit.write({
        ...base,
        kind: "tool.rejected",
        reasonCode: "TOOL_INPUT_INVALID",
        detail: { tool, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`) },
      });
      return {
        ok: false,
        tool,
        reasonCode: "TOOL_INPUT_INVALID",
        detail: "input failed schema; not executed",
      };
    }
    await c.meter.consume({
      tenantId: c.tenantId,
      workspaceId: c.workspaceId,
      runId: c.runId,
      taskId: c.taskId,
      hypothesisId: c.hypothesisId,
      callKey,
      tool,
    });
    const principal: Principal = {
      kind: "agent",
      actorId: c.taskId,
      orgId: c.tenantId,
      parentRunId: c.runId,
    };
    const request: ExecutionRequest = {
      requestId: randomUUID(),
      idempotencyKey: `${c.taskId}:${callKey}`.slice(0, 200).padEnd(8, "_"),
      tenantId: c.tenantId,
      workspaceId: c.workspaceId,
      actor: { kind: "agent", actorId: c.taskId, parentRunId: c.runId },
      capability: tool,
      input: parsed.data,
      deadlineMs: 60_000,
      trace: { traceId: `${c.runId}/${c.taskId}`, researchRunId: c.runId },
    };
    const response = await c.gateway.invoke(principal, request);
    if (response.state !== "ok" && response.state !== "partial") {
      return {
        ok: false,
        tool,
        reasonCode: response.reasonCode ?? response.state.toUpperCase(),
        detail: response.warnings.join("; ").slice(0, 500),
      };
    }
    return {
      ok: true,
      tool,
      response,
      wrapped: wrapAsData(tool, response.payload),
      resultHash: response.provenance.resultSha256 || hashOf(response.payload),
    };
  }
}
