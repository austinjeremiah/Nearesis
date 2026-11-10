import { randomUUID } from "node:crypto";
import { WorkspaceCommand, CommandAccepted as CommandAcceptedSchema } from "@nearesis/contracts";
import type { DomainEventType } from "@nearesis/contracts";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { canAdmin, canWrite } from "./auth.ts";
import type { Session } from "./auth.ts";
import type { Db, Tx } from "./db/pool.ts";
import { KernelError, isUniqueViolation } from "./errors.ts";
import { EventJournal, writeAudit } from "./journal.ts";
import { noWorkspaceAccess, zodDetails } from "./workspace.ts";

export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>;

export interface CommandContext {
  tx: Tx;
  session: Session;
  workspace: { id: string; orgId: string; version: number; activeBranchId: string | null };
  commandId: string;
}
export interface HandlerResult {
  eventType: DomainEventType;
  data: Record<string, unknown>;
  /** Included in the result fingerprint (deterministic outcome of the command). */
  result: Record<string, unknown>;
}
export interface CommandHandler {
  /** "admin" => owner/admin only; otherwise any writer role. */
  minRole?: "admin";
  handle(ctx: CommandContext, payload: Record<string, unknown>): Promise<HandlerResult>;
}

export interface PluginWorkspaceOps {
  enableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult>;
  disableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult>;
}

const ObjectiveUpdate = z.strictObject({ objective: z.string().min(1).max(4000) });
const MarkerCreate = z.strictObject({
  panelId: z.uuid(),
  markerId: z.uuid().optional(),
  anchor: z.record(z.string(), z.unknown()),
});
const PluginRef = z.strictObject({ pluginId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) });

function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
  const r = schema.safeParse(payload);
  if (!r.success) {
    throw new KernelError("VALIDATION_FAILED", "INVALID_PAYLOAD", "Invalid command payload.", {
      details: zodDetails(r.error),
    });
  }
  return r.data;
}

/**
 * Transactional command bus (ch.10). One DB transaction per command:
 * lock workspace row -> ACL -> idempotency replay -> expected_version CAS -> apply -> event -> outbox -> commit.
 */
export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
    plugins: PluginWorkspaceOps,
  ) {
    this.register("workspace.update_objective", {
      handle: async (ctx, payload) => {
        const p = parsePayload(ObjectiveUpdate, payload);
        await ctx.tx.query("UPDATE workspaces SET objective = $2 WHERE id = $1", [
          ctx.workspace.id,
          p.objective,
        ]);
        return {
          eventType: "workspace.updated",
          data: { objective: p.objective },
          result: { objective: p.objective },
        };
      },
    });
    this.register("marker.create", {
      handle: async (ctx, payload) => {
        const p = parsePayload(MarkerCreate, payload);
        // The panel must belong to THIS workspace (and be visible under RLS). Foreign and unknown panels give the same
        // response, so cross-tenant marker injection cannot probe for object existence (K04).
        const panel = await ctx.tx.query("SELECT id FROM panels WHERE id = $1 AND workspace_id = $2", [
          p.panelId,
          ctx.workspace.id,
        ]);
        if (!panel.rows[0]) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
        const markerId = p.markerId ?? randomUUID();
        await ctx.tx.query(
          `INSERT INTO markers(id, org_id, workspace_id, branch_id, panel_id, anchor_json)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            markerId,
            ctx.workspace.orgId,
            ctx.workspace.id,
            ctx.workspace.activeBranchId,
            p.panelId,
            JSON.stringify(p.anchor),
          ],
        );
        return { eventType: "marker.created", data: { markerId, panelId: p.panelId }, result: { markerId } };
      },
    });
    this.register("plugin.enable", {
      minRole: "admin",
      handle: (ctx, payload) => plugins.enableInWorkspace(ctx, parsePayload(PluginRef, payload).pluginId),
    });
    this.register("plugin.disable", {
      minRole: "admin",
      handle: (ctx, payload) => plugins.disableInWorkspace(ctx, parsePayload(PluginRef, payload).pluginId),
    });
  }

  register(commandType: string, handler: CommandHandler): void {
    this.handlers.set(commandType, handler);
  }

  async execute(
    session: Session,
    workspaceId: string,
    rawCommand: unknown,
    opts: { idempotencyKey?: string; expectedVersion?: number; traceId?: string } = {},
  ): Promise<CommandAccepted> {
    const parsed = WorkspaceCommand.safeParse(rawCommand);
    if (!parsed.success) {
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid command.", {
        details: zodDetails(parsed.error),
      });
    }
    const cmd = parsed.data;
    const expectedVersion = opts.expectedVersion ?? cmd.expectedVersion;
    const key = opts.idempotencyKey ?? cmd.commandId;
    const ctx = { orgId: session.principal.orgId, userId: session.userId };
    try {
      return await this.attempt(session, workspaceId, cmd, expectedVersion, key);
    } catch (e) {
      if (isUniqueViolation(e)) {
        // A concurrent twin committed first; the retry takes the replay path.
        return this.attempt(session, workspaceId, cmd, expectedVersion, key);
      }
      if (e instanceof KernelError && e.code === "FORBIDDEN") {
        await this.auditDeny(ctx, session, workspaceId, e, opts.traceId);
      }
      throw e;
    }
  }

  private async auditDeny(
    ctx: { orgId: string; userId: string },
    session: Session,
    workspaceId: string,
    e: KernelError,
    traceId?: string,
  ): Promise<void> {
    try {
      await this.db.tx(ctx, (tx) =>
        writeAudit(tx, {
          orgId: ctx.orgId,
          actorId: session.userId,
          action: "access.denied",
          subject: "command",
          outcome: "denied",
          reasonCode: e.reasonCode,
          detail: { requestedWorkspace: workspaceId },
          traceId,
        }),
      );
    } catch {
      /* auditing a denial must not mask the denial */
    }
  }

  private attempt(
    session: Session,
    workspaceId: string,
    cmd: WorkspaceCommand,
    expectedVersion: number,
    key: string,
  ): Promise<CommandAccepted> {
    const payloadHash = sha256Hex(canonicalJson({ t: cmd.commandType, p: cmd.payload }));
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      // 1. Lock + ACL. RLS hides other tenants' rows; absent and foreign are the same outcome.
      const ws = (
        await tx.query(
          "SELECT id, org_id, version, active_branch_id, archived_at FROM workspaces WHERE id = $1 FOR UPDATE",
          [workspaceId],
        )
      ).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const handler = this.handlers.get(cmd.commandType);
      if (!handler) {
        throw new KernelError(
          "VALIDATION_FAILED",
          "UNKNOWN_COMMAND",
          `Unsupported command ${cmd.commandType}.`,
        );
      }
      if (!canWrite(session.role) || (handler.minRole === "admin" && !canAdmin(session.role))) {
        throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted for this command.");
      }
      // 2. Idempotency replay (before CAS: a retry after success must not look stale).
      const prior = await tx.query(
        "SELECT id, payload_hash, applied_seq, workspace_version, result_fingerprint FROM commands WHERE workspace_id = $1 AND idempotency_key = $2",
        [workspaceId, key],
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (p.payload_hash !== payloadHash) {
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key reused with a different command.",
          );
        }
        return {
          commandId: p.id,
          workspaceVersion: p.workspace_version,
          eventSeq: p.applied_seq,
          resultFingerprint: p.result_fingerprint,
        };
      }
      // 3. Optimistic concurrency.
      if (ws.version !== expectedVersion) {
        throw new KernelError("STALE_VERSION", "STALE_VERSION", "Workspace changed since it was read.", {
          retryable: true,
          lastStableRevision: ws.version,
          nextAction: "Re-read the workspace and resubmit with the current version.",
        });
      }
      // 4. Apply, 5. event + outbox, 6. bump version.
      const hctx: CommandContext = {
        tx,
        session,
        workspace: { id: ws.id, orgId: ws.org_id, version: ws.version, activeBranchId: ws.active_branch_id },
        commandId: cmd.commandId,
      };
      const out = await handler.handle(hctx, cmd.payload);
      const newVersion = ws.version + 1;
      await tx.query("UPDATE workspaces SET version = $2 WHERE id = $1", [workspaceId, newVersion]);
      const ev = await this.journal.append(tx, {
        orgId: ws.org_id,
        workspaceId,
        type: out.eventType,
        actorId: session.userId,
        data: out.data,
        causationId: cmd.commandId,
        sourceRevision: newVersion,
      });
      const fingerprint = sha256Hex(
        canonicalJson({ t: cmd.commandType, h: payloadHash, v: newVersion, s: ev.seq, r: out.result }),
      );
      await tx.query(
        `INSERT INTO commands(id, tenant_id, workspace_id, idempotency_key, expected_version, actor_id, command_type,
           payload_hash, applied_seq, workspace_version, result_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          cmd.commandId,
          ws.org_id,
          workspaceId,
          key,
          expectedVersion,
          session.userId,
          cmd.commandType,
          payloadHash,
          ev.seq,
          newVersion,
          fingerprint,
        ],
      );
      return {
        commandId: cmd.commandId,
        workspaceVersion: newVersion,
        eventSeq: ev.seq,
        resultFingerprint: fingerprint,
      };
    });
  }
}
