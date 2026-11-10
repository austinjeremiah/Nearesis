import type { ExecutionRequest, ExecutionResponse, Principal, ToolGateway } from "@nearesis/contracts";
import type pg from "pg";
import { hashOf } from "../canonical.ts";
import type { AuditSink } from "../audit.ts";
import { runInternalEffect } from "../ledger.ts";
import { withTenant } from "../tenant.ts";
import type { RoleConfig } from "../roles.ts";

/**
 * FAKE ToolGateway used until the kernel gateway is connected (same `ToolGateway` interface). It is a test double:
 * it enforces leases and role allowlists, writes audit rows for denials, executes deterministic handlers, and makes
 * execution idempotent by idempotencyKey. It is NOT the kernel policy engine; tests that need K10 semantics are
 * recorded against the real gateway only when integrated.
 */
export interface Lease {
  role: string;
  capabilities: ReadonlySet<string>;
  revoked: boolean;
}
export interface LeaseStore {
  get(tenantId: string, taskId: string): Promise<Lease | null>;
}

export class InMemoryLeases implements LeaseStore {
  private readonly m = new Map<string, Lease>();
  issue(taskId: string, role: string, capabilities: string[]): void {
    this.m.set(taskId, { role, capabilities: new Set(capabilities), revoked: false });
  }
  revoke(taskId: string): void {
    const l = this.m.get(taskId);
    if (l) this.m.set(taskId, { ...l, revoked: true });
  }
  async get(_t: string, taskId: string): Promise<Lease | null> {
    return this.m.get(taskId) ?? null;
  }
}

/** Leases read from the `tasks` row (shared by every worker process). */
export class PgLeases implements LeaseStore {
  constructor(private readonly pool: pg.Pool) {}
  async get(tenantId: string, taskId: string): Promise<Lease | null> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ role: string; allowed_capabilities: string[]; lease_revoked: boolean }>(
        "SELECT role, allowed_capabilities, lease_revoked FROM tasks WHERE id=$1",
        [taskId],
      );
      const row = r.rows[0];
      return row
        ? { role: row.role, capabilities: new Set(row.allowed_capabilities), revoked: row.lease_revoked }
        : null;
    });
  }
  async revoke(tenantId: string, taskId: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query("UPDATE tasks SET lease_revoked=true WHERE id=$1", [taskId]),
    );
  }
}

export type Handler = (input: unknown, req: ExecutionRequest) => Promise<unknown> | unknown;
export class SourceUnavailable extends Error {
  constructor(readonly source: string) {
    super(`source unavailable: ${source}`);
  }
}

export interface FakeGatewayOpts {
  leases: LeaseStore;
  audit: AuditSink;
  roles: Map<string, RoleConfig>;
  handlers: Record<string, Handler>;
  /** When set, execution is idempotent across processes by idempotencyKey via the side-effect ledger. */
  pool?: pg.Pool;
}

export class FakeToolGateway implements ToolGateway {
  /** capability -> number of real executions (in-memory view; DB view is agent_side_effects kind gw:*). */
  readonly executed = new Map<string, number>();
  readonly decisions: Array<{
    taskId: string;
    capability: string;
    decision: "allow" | "deny";
    reason?: string;
  }> = [];
  constructor(private readonly o: FakeGatewayOpts) {}

  async invoke(principal: Principal, req: ExecutionRequest): Promise<ExecutionResponse> {
    const taskId = principal.actorId;
    const base = {
      tenantId: req.tenantId,
      workspaceId: req.workspaceId,
      runId: req.trace.researchRunId ?? null,
      taskId,
      actor: `${principal.kind}:${taskId}`,
    };
    const lease = await this.o.leases.get(req.tenantId, taskId);
    const roleCfg = lease ? this.o.roles.get(lease.role) : undefined;
    let deny: string | null = null;
    if (principal.orgId !== req.tenantId) deny = "TENANT_MISMATCH";
    else if (principal.kind === "service")
      deny = null; // kernel-brokered system call (plan validation); not an agent grant
    else if (!lease) deny = "TOOL_NOT_GRANTED";
    else if (lease.revoked) deny = "TOOL_NOT_GRANTED";
    else if (!lease.capabilities.has(req.capability)) deny = "TOOL_NOT_GRANTED";
    else if (!roleCfg?.allowedTools.includes(req.capability)) deny = "TOOL_NOT_GRANTED";
    if (deny) {
      this.decisions.push({ taskId, capability: req.capability, decision: "deny", reason: deny });
      await this.o.audit.write({
        ...base,
        kind: "gateway.denied",
        reasonCode: deny,
        detail: { capability: req.capability, revoked: lease?.revoked ?? null },
      });
      return this.respond(req, "blocked", null, ["denied by gateway"], deny);
    }
    const handler = this.o.handlers[req.capability];
    if (!handler) return this.respond(req, "failed", null, ["no handler"], "NO_HANDLER");
    this.decisions.push({ taskId, capability: req.capability, decision: "allow" });
    const exec = async () => {
      this.executed.set(req.capability, (this.executed.get(req.capability) ?? 0) + 1);
      try {
        return { ok: true as const, payload: await handler(req.input, req) };
      } catch (e) {
        if (e instanceof SourceUnavailable)
          return { ok: false as const, reason: "SOURCE_UNAVAILABLE", msg: e.message };
        throw e;
      }
    };
    const out = this.o.pool
      ? (
          await runInternalEffect(
            this.o.pool,
            {
              tenantId: req.tenantId,
              runId: req.trace.researchRunId ?? "00000000-0000-0000-0000-000000000000",
              effectKey: `gw:${req.capability}:${req.idempotencyKey}`,
              kind: `gw:${req.capability}`,
            },
            exec,
          )
        ).result
      : await exec();
    await this.o.audit.write({
      ...base,
      kind: "gateway.executed",
      detail: { capability: req.capability, ok: out.ok },
    });
    return out.ok
      ? this.respond(req, "ok", out.payload, [])
      : this.respond(req, "failed", null, [out.msg], out.reason);
  }

  private respond(
    req: ExecutionRequest,
    state: ExecutionResponse["state"],
    payload: unknown,
    warnings: string[],
    reasonCode?: string,
  ): ExecutionResponse {
    return {
      requestId: req.requestId,
      state,
      payload,
      sourceRefs: [],
      provenance: {
        pluginId: "fake-gateway",
        pluginVersion: "0.0.1",
        capability: req.capability,
        resultSha256: hashOf(payload ?? null),
      },
      warnings,
      outputSchemaVersion: 1,
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
}
