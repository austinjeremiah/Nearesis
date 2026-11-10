import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { ExecutionRequest } from "@nearesis/contracts";
import type { ExecutionResponse, Principal, ToolGateway } from "@nearesis/contracts";
import { canonicalJson, grantKey, sha256Hex } from "@nearesis/plugin-sdk";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";
import { grantFingerprint } from "./leases.ts";
import type { LeaseService } from "./leases.ts";
import type { PluginManager, ResolvedPlugin } from "./plugins/manager.ts";
import { redact, redactString } from "./redact.ts";
import { zodDetails } from "./workspace.ts";

type Denial = { state: "blocked" | "failed"; reasonCode: string; message: string };

/** ToolGateway implementation: ch.04 "Internal execution path" steps 1-7. */
export class KernelToolGateway implements ToolGateway {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly db: Db,
    private readonly plugins: PluginManager,
    private readonly leases: LeaseService,
  ) {}

  private validator(schema: Record<string, unknown>): ValidateFunction {
    const key = sha256Hex(canonicalJson(schema));
    let v = this.validators.get(key);
    if (!v) {
      v = this.ajv.compile(schema);
      this.validators.set(key, v);
    }
    return v;
  }

  private respond(
    req: { requestId: string },
    inst: { pluginId: string; version: string } | undefined,
    capability: string,
    r: {
      state: ExecutionResponse["state"];
      payload?: unknown;
      reasonCode?: string;
      message?: string;
      warnings?: string[];
    },
  ): ExecutionResponse {
    const payload = r.payload ?? (r.message ? { message: r.message } : null);
    return {
      requestId: req.requestId,
      state: r.state,
      payload,
      sourceRefs: [],
      provenance: {
        pluginId: inst?.pluginId ?? "unresolved",
        pluginVersion: inst?.version ?? "0.0.0",
        capability: capability as ExecutionResponse["provenance"]["capability"],
        resultSha256: sha256Hex(canonicalJson(payload)),
      },
      warnings: r.warnings ?? [],
      outputSchemaVersion: 1,
      ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    };
  }

  async invoke(principal: Principal, rawRequest: ExecutionRequest): Promise<ExecutionResponse> {
    const parsed = ExecutionRequest.safeParse(rawRequest);
    if (!parsed.success) {
      throw new KernelError("VALIDATION_FAILED", "INVALID_EXECUTION_REQUEST", "Invalid execution request.", {
        details: zodDetails(parsed.error),
      });
    }
    const req = parsed.data;
    // Step 1: authority comes from the server-side principal; the request body only echoes it.
    if (
      req.tenantId !== principal.orgId ||
      req.actor.actorId !== principal.actorId ||
      req.actor.kind !== principal.kind
    ) {
      throw new KernelError(
        "FORBIDDEN",
        "PRINCIPAL_MISMATCH",
        "Request does not match the authenticated principal.",
      );
    }
    if ((principal.kind as string) === "service")
      throw new KernelError("FORBIDDEN", "PRINCIPAL_KIND", "Service principals cannot invoke tools.");
    const tctx = { orgId: principal.orgId, userId: principal.actorId, actorKind: principal.kind } as const;
    const auditBase = {
      orgId: principal.orgId,
      workspaceId: req.workspaceId,
      actorId: principal.actorId,
      traceId: req.trace.traceId,
    };

    // ---- Phase A (one tx): workspace ACL, idempotency, capability health, lease, input schema, intent record.
    type PhaseA =
      | { kind: "replay"; response: ExecutionResponse }
      | { kind: "done"; response: ExecutionResponse }
      | { kind: "run"; resolved: ResolvedPlugin; invocationId: string; warnings: string[] };
    const a: PhaseA = await this.db.tx(tctx, async (tx): Promise<PhaseA> => {
      const ws = await tx.query("SELECT id FROM workspaces WHERE id = $1", [req.workspaceId]);
      if (!ws.rows[0]) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");

      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `inv:${req.workspaceId}:${req.idempotencyKey}`,
      ]);
      const prior = await tx.query(
        "SELECT state, response FROM tool_invocations WHERE workspace_id = $1 AND idempotency_key = $2",
        [req.workspaceId, req.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].state === "running") {
          return {
            kind: "replay",
            response: this.respond(req, undefined, req.capability, {
              state: "blocked",
              reasonCode: "DUPLICATE_IN_FLIGHT",
              message: "An identical request is still running.",
            }),
          };
        }
        return { kind: "replay", response: prior.rows[0].response as ExecutionResponse };
      }

      const invocationId = randomUUID();
      const deny = async (
        d: Denial,
        inst?: { pluginId: string; version: string },
        internal?: string,
      ): Promise<PhaseA> => {
        const response = this.respond(req, inst, req.capability, {
          state: d.state,
          reasonCode: d.reasonCode,
          message: d.message,
        });
        await tx.query(
          `INSERT INTO tool_invocations(id, org_id, workspace_id, request_id, idempotency_key, actor_id, capability, plugin_version, state, reason_code, result_sha256, response, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
          [
            invocationId,
            principal.orgId,
            req.workspaceId,
            req.requestId,
            req.idempotencyKey,
            principal.actorId,
            req.capability,
            inst?.version ?? null,
            d.state,
            d.reasonCode,
            response.provenance.resultSha256,
            JSON.stringify(response),
          ],
        );
        await writeAudit(tx, {
          ...auditBase,
          action: "tool.invoke.denied",
          subject: req.capability,
          outcome: "denied",
          reasonCode: internal ?? d.reasonCode,
          detail: { requestId: req.requestId, state: d.state },
        });
        return { kind: "done", response };
      };

      // Step 2: capability exists, is enabled for this workspace, and is healthy.
      const res = await this.plugins.resolve(tx, req.workspaceId, req.capability);
      if (!res.ok) {
        const hidden = res.reasonCode === "CAPABILITY_NOT_FOUND" || res.reasonCode === "PLUGIN_NOT_ENABLED";
        return deny(
          {
            state: "blocked",
            reasonCode: hidden ? "CAPABILITY_NOT_AVAILABLE" : res.reasonCode,
            message: hidden ? "Capability is not available in this workspace." : res.message,
          },
          res.installation && !hidden
            ? { pluginId: res.installation.pluginId, version: res.installation.version }
            : undefined,
          res.reasonCode,
        );
      }
      const { installation, capability } = res.resolved;
      const prov = { pluginId: installation.pluginId, version: installation.version };

      // Authoritative lease lookup; a client grantFingerprint is only echoed.
      const warnings: string[] = [];
      const leases = await this.leases.validLeasesFor(tx, req.workspaceId, principal.actorId, req.capability);
      const now = Date.now();
      const held = new Map<string, number>();
      for (const l of leases) {
        for (const g of l.grants) if (Date.parse(g.expiresAt) > now) held.set(grantKey(g), g.maxCost);
      }
      const missing = capability.requiredGrants.filter((g) => !held.has(g));
      if (leases.length === 0 || missing.length) {
        return deny(
          {
            state: "blocked",
            reasonCode: "TOOL_NOT_GRANTED",
            message: "No valid lease grants this capability.",
          },
          prov,
        );
      }
      if (req.grantFingerprint && !leases.some((l) => grantFingerprint(l.grants) === req.grantFingerprint)) {
        warnings.push(
          "grantFingerprint does not match the authoritative lease; authority was resolved server-side",
        );
      }

      // Step 3: input schema.
      const vin = this.validator(capability.inputSchema);
      if (!vin(req.input)) {
        return deny(
          {
            state: "failed",
            reasonCode: "INPUT_SCHEMA_INVALID",
            message: `Input rejected: ${this.ajv.errorsText(vin.errors, { dataVar: "input" })}`.slice(0, 500),
          },
          prov,
        );
      }

      // Step 4: audit intent + idempotency record.
      await tx.query(
        `INSERT INTO tool_invocations(id, org_id, workspace_id, request_id, idempotency_key, actor_id, capability, installation_id, plugin_version, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running')`,
        [
          invocationId,
          principal.orgId,
          req.workspaceId,
          req.requestId,
          req.idempotencyKey,
          principal.actorId,
          req.capability,
          installation.id,
          installation.version,
        ],
      );
      await writeAudit(tx, {
        ...auditBase,
        action: "tool.invoke.intent",
        subject: req.capability,
        outcome: "ok",
        detail: { requestId: req.requestId, pluginVersion: installation.version },
      });
      return { kind: "run", resolved: res.resolved, invocationId, warnings };
    });
    if (a.kind !== "run") return a.response;

    // ---- Phase B: run with a bounded timeout. The resolved version object was captured in phase A (in-flight pinning).
    const { installation, capability, module } = a.resolved;
    const prov = { pluginId: installation.pluginId, version: installation.version };
    const timeoutMs = Math.min(capability.timeoutMs, req.deadlineMs);
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const TIMEOUT = Symbol("timeout");
    let outcome: { ok: true; value: unknown } | { ok: false; timeout: boolean; error: string };
    try {
      const handler = module.handlers[req.capability]!;
      const run = Promise.resolve(
        handler(req.input, {
          signal: ac.signal,
          requestId: req.requestId,
          workspaceId: req.workspaceId,
          principal,
          capability: req.capability,
        }),
      );
      run.catch(() => undefined); // a late rejection after timeout must not be unhandled
      const value = await Promise.race([
        run,
        new Promise<typeof TIMEOUT>((res) => {
          timer = setTimeout(() => res(TIMEOUT), timeoutMs);
        }),
      ]);
      outcome =
        value === TIMEOUT
          ? { ok: false, timeout: true, error: `timed out after ${timeoutMs}ms` }
          : { ok: true, value };
    } catch (e) {
      outcome = {
        ok: false,
        timeout: false,
        error: redactString(e instanceof Error ? e.message : String(e)),
      };
    } finally {
      clearTimeout(timer);
    }
    if (!outcome.ok && outcome.timeout) ac.abort();

    // ---- Phase C: validate/redact, commit fingerprint + final audit.
    let response: ExecutionResponse;
    let incident: { kind: string; detail: string; degradeNow: boolean } | undefined;
    if (!outcome.ok) {
      response = this.respond(req, prov, req.capability, {
        state: "failed",
        reasonCode: outcome.timeout ? "PLUGIN_TIMEOUT" : "PLUGIN_ERROR",
        message: outcome.timeout
          ? `Plugin exceeded its ${timeoutMs}ms time limit.`
          : "Plugin raised an error.",
        warnings: a.warnings,
      });
      incident = {
        kind: outcome.timeout ? "timeout" : "plugin_error",
        detail: outcome.error,
        degradeNow: outcome.timeout,
      };
    } else {
      const vout = this.validator(capability.outputSchema);
      const size = Buffer.byteLength(JSON.stringify(outcome.value ?? null));
      if (!vout(outcome.value)) {
        response = this.respond(req, prov, req.capability, {
          state: "failed",
          reasonCode: "OUTPUT_SCHEMA_INVALID",
          message: "Plugin output violated its declared schema.",
          warnings: a.warnings,
        });
        incident = {
          kind: "output_schema_invalid",
          detail: this.ajv.errorsText(vout.errors),
          degradeNow: false,
        };
      } else if (size > capability.maxOutputBytes) {
        response = this.respond(req, prov, req.capability, {
          state: "failed",
          reasonCode: "OUTPUT_TOO_LARGE",
          message: "Plugin output exceeded maxOutputBytes.",
          warnings: a.warnings,
        });
        incident = { kind: "output_too_large", detail: `${size} bytes`, degradeNow: false };
      } else {
        response = this.respond(req, prov, req.capability, {
          state: "ok",
          payload: redact(outcome.value),
          warnings: a.warnings,
        });
      }
    }
    if (incident)
      await this.plugins.reportInvocationFailure(
        installation.id,
        incident.kind,
        incident.detail,
        incident.degradeNow,
      );
    else await this.plugins.reportInvocationSuccess(installation.id);

    await this.db.tx(tctx, async (tx) => {
      await tx.query(
        "UPDATE tool_invocations SET state = $2, reason_code = $3, result_sha256 = $4, response = $5, completed_at = now() WHERE id = $1",
        [
          a.invocationId,
          response.state,
          response.reasonCode ?? null,
          response.provenance.resultSha256,
          JSON.stringify(response),
        ],
      );
      await writeAudit(tx, {
        ...auditBase,
        action: "tool.invoke.completed",
        subject: req.capability,
        outcome: response.state === "ok" ? "ok" : "failed",
        reasonCode: response.reasonCode ?? null,
        detail: {
          requestId: req.requestId,
          pluginVersion: installation.version,
          resultSha256: response.provenance.resultSha256,
        },
      });
    });
    return response;
  }
}
