import { registerHistoryCommands } from "./history-commands.ts";
import { registerMonitoringCommands } from "./monitoring/commands.ts";
import {
  CommandType,
  WorkspaceCommand as ContractWorkspaceCommand,
  CommandAccepted as CommandAcceptedSchema,
} from "@nearesis/contracts";
import type { DomainEventType } from "@nearesis/contracts";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { operationIdFromActionHash } from "./approvals.ts";
import type { ApprovalService } from "./approvals.ts";
import { canAdmin, canWrite } from "./auth.ts";
import type { Session } from "./auth.ts";
import type { Db, Tx } from "./db/pool.ts";
import { KernelError, isUniqueViolation } from "./errors.ts";
import { EventJournal, writeAudit } from "./journal.ts";
import { noWorkspaceAccess, zodDetails } from "./workspace.ts";

/**
 * Kernel command envelope: the contract envelope plus commands the kernel added ahead of the contract enum
 * (`graph.save_layout`; see the contract-change entry in INTEGRATION_QUEUE.md).
 */
export const KERNEL_EXTRA_COMMANDS = ["graph.save_layout"] as const;
const WorkspaceCommand = ContractWorkspaceCommand.extend({
  commandType: z.enum([...CommandType.options, ...KERNEL_EXTRA_COMMANDS]),
});
type WorkspaceCommand = z.infer<typeof WorkspaceCommand>;

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

/**
 * Commands an agent principal may only run with a kernel-verified approval (ch.05). Humans are unaffected: their
 * authority is their role. Plugin lifecycle is listed for completeness (agents are never admins).
 */
export const PRIVILEGED_AGENT_COMMANDS: ReadonlySet<string> = new Set([
  "canvas.apply_patch",
  "workspace.update_objective",
  "plugin.enable",
  "plugin.disable",
]);

export interface PluginWorkspaceOps {
  enableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult>;
  disableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult>;
}

const ObjectiveUpdate = z.strictObject({ objective: z.string().min(1).max(4000) });
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
    private readonly approvals?: ApprovalService,
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
    registerMonitoringCommands(this);
    this.register("plugin.enable", {
      minRole: "admin",
      handle: (ctx, payload) => plugins.enableInWorkspace(ctx, parsePayload(PluginRef, payload).pluginId),
    });
    this.register("plugin.disable", {
      minRole: "admin",
      handle: (ctx, payload) => plugins.disableInWorkspace(ctx, parsePayload(PluginRef, payload).pluginId),
    });
    registerHistoryCommands(this);
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
    // A canvas patch's operationId is its natural idempotency key (ch.26): a retried operation replays, never re-applies.
    const opId =
      cmd.commandType === "canvas.apply_patch"
        ? (cmd.payload as { operationId?: unknown }).operationId
        : undefined;
    const key = opts.idempotencyKey ?? (typeof opId === "string" ? `op:${opId}` : cmd.commandId);
    const ctx = { orgId: session.principal.orgId, userId: session.userId };
    try {
      return await this.attempt(session, workspaceId, cmd, expectedVersion, key);
    } catch (e) {
      if (isUniqueViolation(e)) {
        // A concurrent twin committed first; the retry takes the replay path.
        return this.attempt(session, workspaceId, cmd, expectedVersion, key);
      }
      if (e instanceof KernelError && (e.code === "FORBIDDEN" || e.code === "APPROVAL_REQUIRED")) {
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
      // 3b. Agent principals need an approval that matches this exact command; consumed atomically with the mutation.
      if (session.principal.kind === "agent" && PRIVILEGED_AGENT_COMMANDS.has(cmd.commandType)) {
        if (!this.approvals)
          throw new KernelError(
            "APPROVAL_REQUIRED",
            "APPROVAL_MISSING",
            "Approval verification is unavailable.",
          );
        const opId = (cmd.payload as { operationId?: unknown }).operationId;
        await this.approvals.consume(tx, {
          workspaceId,
          runId: session.principal.parentRunId,
          usedBy: cmd.commandId,
          // The kernel's canonical hash of the exact command, or (canvas patches) the approved action hash the runtime
          // bound into the patch's operationId.
          matches: (h) =>
            h === payloadHash ||
            (cmd.commandType === "canvas.apply_patch" &&
              typeof opId === "string" &&
              operationIdFromActionHash(h) === opId),
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
