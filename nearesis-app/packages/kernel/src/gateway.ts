import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { ExecutionRequest, gatedSpend, spendKey } from "@nearesis/contracts";
import type { ExecutionResponse, Principal, ToolGateway } from "@nearesis/contracts";
import { canonicalJson, grantKey, sha256Hex } from "@nearesis/plugin-sdk";
import type { ApprovalService } from "./approvals.ts";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";
import { grantFingerprint } from "./leases.ts";
import type { LeaseService } from "./leases.ts";
import type { PluginManager, ResolvedPlugin } from "./plugins/manager.ts";
import { egressFetchFor } from "./egress.ts";
import { internalEndpointsOf, outsideConfinement, runConfined } from "./plugins/confine.ts";
import type { Confinement } from "./plugins/confine.ts";
import { PluginLimitError } from "./plugins/sandbox-exec.ts";
import { redact, redactString } from "./redact.ts";
import { zodDetails } from "./workspace.ts";

const MAINNET_MENTION = /main[\s_.-]*net/i;

type Denial = { state: "blocked" | "failed"; reasonCode: string; message: string };

/** ToolGateway implementation: ch.04 "Internal execution path" steps 1-7. */
export class KernelToolGateway implements ToolGateway {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly db: Db,
    private readonly plugins: PluginManager,
    private readonly leases: LeaseService,
    private readonly approvals?: ApprovalService,
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
      const ws = await tx.query("SELECT id, network_scope FROM workspaces WHERE id = $1", [req.workspaceId]);
      if (!ws.rows[0]) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
      const networkScope = ws.rows[0].network_scope as string;

      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `inv:${req.workspaceId}:${req.idempotencyKey}`,
      ]);
      const prior = await tx.query(
        `SELECT id, state, response,
                (COALESCE(deadline_at, started_at + interval '10 minutes') < now()) AS expired
           FROM tool_invocations WHERE workspace_id = $1 AND idempotency_key = $2`,
        [req.workspaceId, req.idempotencyKey],
      );
      // A `running` record whose deadline has passed belongs to a dead worker: a replay may claim it (FND-036).
      let takeoverId: string | undefined;
      if (prior.rows[0]) {
        if (prior.rows[0].state === "running" && prior.rows[0].expired) {
          takeoverId = prior.rows[0].id as string;
        } else if (prior.rows[0].state === "running") {
          return {
            kind: "replay",
            response: this.respond(req, undefined, req.capability, {
              state: "blocked",
              reasonCode: "DUPLICATE_IN_FLIGHT",
              message: "An identical request is still running.",
            }),
          };
        } else return { kind: "replay", response: prior.rows[0].response as ExecutionResponse };
      }

      const invocationId = takeoverId ?? randomUUID();
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
        if (takeoverId) {
          const cas = await tx.query(
            `UPDATE tool_invocations SET state = $2, reason_code = $3, result_sha256 = $4, response = $5, completed_at = now()
              WHERE id = $1 AND state = 'running'`,
            [invocationId, d.state, d.reasonCode, response.provenance.resultSha256, JSON.stringify(response)],
          );
          if (cas.rowCount !== 1)
            return {
              kind: "replay",
              response: this.respond(req, undefined, req.capability, {
                state: "blocked",
                reasonCode: "DUPLICATE_IN_FLIGHT",
                message: "An identical request is still running.",
              }),
            };
        } else {
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
        }
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

      // Abandoned in-flight invocation: only an idempotent capability may be re-executed; anything else needs a human.
      if (takeoverId && !capability.idempotent) {
        return deny(
          {
            state: "failed",
            reasonCode: "IN_FLIGHT_ABANDONED",
            message:
              "A previous attempt of this non-idempotent call did not complete and may have taken effect; it needs human review.",
          },
          prov,
        );
      }

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

      // Step 3a (ch.12 "Chain commitment policy"): a chain write is only possible in a testnet workspace, never names
      // mainnet, and is never approvable into a read-only or fixture workspace. Evaluated before any approval is consumed.
      if (capability.sideEffect === "chain_write") {
        const why =
          networkScope !== "near-testnet"
            ? {
                reasonCode: "CHAIN_WRITE_SCOPE",
                message: "Chain writes are only permitted in a near-testnet workspace.",
              }
            : MAINNET_MENTION.test(JSON.stringify(req.input ?? null))
              ? {
                  reasonCode: "MAINNET_WRITE_REFUSED",
                  message: "Mainnet writes are refused; they are a human-only release step.",
                }
              : null;
        if (why) return deny({ state: "blocked", reasonCode: why.reasonCode, message: why.message }, prov);
      }

      // Step 3b (ch.05): paid and chain-writing calls by an agent need a kernel-verified approval of this exact call,
      // consumed in this transaction. Denied calls are audited but not recorded, so a retry after approval can run.
      if (
        !takeoverId &&
        principal.kind === "agent" &&
        (capability.sideEffect === "paid_call" || capability.sideEffect === "chain_write")
      ) {
        try {
          if (!this.approvals)
            throw new KernelError("APPROVAL_REQUIRED", "APPROVAL_MISSING", "No approvals.");
          const hash = sha256Hex(canonicalJson({ capability: req.capability, input: req.input }));
          await this.approvals.consume(tx, {
            workspaceId: req.workspaceId,
            runId: principal.parentRunId,
            usedBy: req.requestId,
            matches: (h) => h === hash,
            // ch.12 chain commitment policy: a chain write needs an owner's approval, not any member's
            ...(capability.sideEffect === "chain_write" ? { approverRoles: ["owner"] as const } : {}),
          });
        } catch (e) {
          if (!(e instanceof KernelError)) throw e;
          await writeAudit(tx, {
            ...auditBase,
            action: "tool.invoke.denied",
            subject: req.capability,
            outcome: "denied",
            reasonCode: e.reasonCode,
            detail: { requestId: req.requestId, sideEffect: capability.sideEffect },
          });
          return {
            kind: "done",
            response: this.respond(req, prov, req.capability, {
              state: "blocked",
              reasonCode: "APPROVAL_REQUIRED",
              message: "This call needs an approval matching its exact capability and input.",
            }),
          };
        }
      }

      // Step 4: audit intent + idempotency record.
      const deadlineMs = String(Math.min(capability.timeoutMs, req.deadlineMs) + 1000);
      if (takeoverId) {
        const cas = await tx.query(
          `UPDATE tool_invocations SET request_id = $2, installation_id = $3, plugin_version = $4, started_at = now(),
                  deadline_at = now() + ($5 || ' milliseconds')::interval, takeover_count = takeover_count + 1
            WHERE id = $1 AND state = 'running' RETURNING id`,
          [invocationId, req.requestId, installation.id, installation.version, deadlineMs],
        );
        if (cas.rowCount !== 1)
          return {
            kind: "replay",
            response: this.respond(req, undefined, req.capability, {
              state: "blocked",
              reasonCode: "DUPLICATE_IN_FLIGHT",
              message: "An identical request is still running.",
            }),
          };
      } else {
        await tx.query(
          `INSERT INTO tool_invocations(id, org_id, workspace_id, request_id, idempotency_key, actor_id, capability, installation_id, plugin_version, state, deadline_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running', now() + ($10 || ' milliseconds')::interval)`,
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
            deadlineMs,
          ],
        );
      }
      await writeAudit(tx, {
        ...auditBase,
        action: "tool.invoke.intent",
        subject: req.capability,
        outcome: "ok",
        detail: {
          requestId: req.requestId,
          pluginVersion: installation.version,
          ...(takeoverId ? { takeover: true } : {}),
        },
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
    // Internal endpoints: only a signature-verified manifest from a publisher named in `internalPublishers` (default
    // none) gets direct access, and only to the exact internal ip:port pairs it declares. Everything else is refused.
    const publishers = this.plugins.config.execution?.internalPublishers ?? [];
    const internal =
      installation.trust === "production" && publishers.includes(installation.manifest.publisher)
        ? internalEndpointsOf(installation.manifest.networkHosts)
        : new Set<string>();
    const confinement: Confinement = {
      pluginId: installation.pluginId,
      capability: req.capability,
      violations: [],
      ...(internal.size > 0 ? { internalEndpoints: internal } : {}),
    };
    let lastError: unknown;
    const TIMEOUT = Symbol("timeout");
    let outcome: { ok: true; value: unknown } | { ok: false; timeout: boolean; error: string };
    try {
      const handler = module.handlers[req.capability]!;
      const proxy = egressFetchFor(
        installation.manifest.networkHosts,
        this.plugins.config.execution?.egressDeps,
        this.plugins.config.execution?.egressPolicy,
      );
      // ch.12 tool proxy: the only sanctioned way for a plugin to reach the network (allowlist + SSRF filter). It leaves
      // the confinement scope before opening a socket; a denial is itself recorded as a violation of the plugin's policy.
      const egress: Parameters<typeof handler>[1]["egress"] = async (url, init) => {
        try {
          const gate = this.plugins.config.execution?.spendGate?.({
            tenantId: principal.orgId,
            workspaceId: req.workspaceId,
          });
          if (!gate) return await outsideConfinement(() => proxy(url, init));
          let host = "";
          try {
            host = new URL(url).hostname;
          } catch {
            // an unparsable URL is refused by the egress guard below, after (and only if) the spend is authorised
          }
          const paidOp = this.plugins.config.execution?.paidEgressOp?.(host);
          return await gatedSpend(
            gate,
            {
              key: spendKey("egress"),
              dimension: "external_requests",
              quantity: 1,
              ...(paidOp ? { paidOp } : {}),
              detail: { host, capability: req.capability },
            },
            async () => {
              const r = await outsideConfinement(() => proxy(url, init));
              await gate.observe({
                key: spendKey("egress-bytes"),
                dimension: "network_egress_bytes",
                quantity: (init?.body ? Buffer.byteLength(init.body) : 0) + r.body.length,
                detail: { host },
              });
              return { result: r, quantity: 1 };
            },
          );
        } catch (e) {
          const code = (e as { reasonCode?: string }).reasonCode;
          if (code && code.startsWith("EGRESS_") && code !== "EGRESS_TIMEOUT")
            confinement.violations.push({ kind: "egress.denied", detail: code });
          throw e;
        }
      };
      const run = Promise.resolve(
        runConfined(confinement, () =>
          handler(req.input, {
            signal: ac.signal,
            requestId: req.requestId,
            workspaceId: req.workspaceId,
            principal,
            capability: req.capability,
            egress,
          }),
        ),
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
      lastError = e;
      outcome = {
        ok: false,
        timeout: false,
        error: redactString(e instanceof Error ? e.message : String(e)),
      };
    } finally {
      clearTimeout(timer);
    }
    if (!outcome.ok && outcome.timeout) ac.abort();
    // Any attempt to leave the sanctioned network path voids the result, whatever the handler returned.
    if (confinement.violations.length > 0 && !(outcome.ok === false && outcome.timeout))
      outcome = {
        ok: false,
        timeout: false,
        error: `egress violation: ${confinement.violations.map((v) => v.kind).join(",")}`,
      };
    const limitCode = lastError instanceof PluginLimitError ? lastError.reasonCode : undefined;
    const violated = confinement.violations.length > 0;

    // ---- Phase C: validate/redact, commit fingerprint + final audit.
    let response: ExecutionResponse;
    let incident: { kind: string; detail: string; degradeNow: boolean } | undefined;
    if (!outcome.ok) {
      response = this.respond(req, prov, req.capability, {
        state: "failed",
        reasonCode: violated
          ? "PLUGIN_EGRESS_VIOLATION"
          : (limitCode ?? (outcome.timeout ? "PLUGIN_TIMEOUT" : "PLUGIN_ERROR")),
        message: violated
          ? "Plugin attempted network or process access outside the egress proxy."
          : limitCode
            ? `Plugin exceeded a sandbox resource limit (${limitCode}).`
            : outcome.timeout
              ? `Plugin exceeded its ${timeoutMs}ms time limit.`
              : "Plugin raised an error.",
        warnings: a.warnings,
      });
      incident = {
        kind: violated
          ? "egress_violation"
          : limitCode
            ? "resource_limit"
            : outcome.timeout
              ? "timeout"
              : "plugin_error",
        detail: outcome.error,
        degradeNow: violated || !!limitCode || outcome.timeout,
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
      for (const v of confinement.violations)
        await writeAudit(tx, {
          ...auditBase,
          action: "plugin.violation",
          subject: req.capability,
          outcome: "denied",
          reasonCode: v.kind,
          detail: { requestId: req.requestId, pluginId: installation.pluginId, what: v.detail },
        });
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
