import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { DomainEventType } from "@nearesis/contracts";
import { canWrite } from "../auth.ts";
import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import type { EventJournal } from "../journal.ts";
import { noWorkspaceAccess, zodDetails } from "../workspace.ts";

/** Deterministic uuid from a command id, so a replayed command resolves to the same entity ids. */
export function idFor(commandId: string, tag: string): string {
  const h = createHash("sha256").update(`${commandId}:${tag}`).digest("hex");
  const v = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
      details: zodDetails(r.error),
    });
  return r.data;
}

export interface HistoryCtx {
  tx: Tx;
  session: Session;
  commandId: string;
  workspace: { id: string; orgId: string; version: number; activeBranchId: string | null };
}
export interface HistoryHandlerResult<R> {
  eventType: DomainEventType;
  data: Record<string, unknown>;
  result: R;
}
export interface HistoryCommand<R> {
  commandType: string;
  commandId?: string;
  idempotencyKey?: string;
  expectedVersion: number;
  payload: unknown;
  /** Human principal required (merge acceptance, certified verdict changes). */
  humanOnly?: boolean;
  handle(ctx: HistoryCtx): Promise<HistoryHandlerResult<R>>;
}
export interface HistoryAccepted<R> {
  commandId: string;
  workspaceVersion: number;
  eventSeq: number;
  resultFingerprint: string;
  replayed: boolean;
  result: R;
}

/**
 * Transactional runner for history and evidence commands. Same discipline as the kernel CommandBus (ch.10): lock the
 * workspace row, ACL, idempotency replay, expected_version CAS, apply, event + outbox, one commit. Kept separate
 * because the contract command envelope enum is owned by the monitoring contracts (see INTEGRATION_QUEUE).
 */
export class HistoryRunner {
  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
  ) {}

  async run<R>(session: Session, workspaceId: string, cmd: HistoryCommand<R>): Promise<HistoryAccepted<R>> {
    const commandId = cmd.commandId ?? randomUUID();
    const key = cmd.idempotencyKey ?? commandId;
    const payloadHash = sha256Hex(canonicalJson({ t: cmd.commandType, p: cmd.payload }));
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const ws = (
        await tx.query(
          "SELECT id, org_id, version, active_branch_id FROM workspaces WHERE id = $1 FOR UPDATE",
          [workspaceId],
        )
      ).rows[0];
      if (!ws) throw noWorkspaceAccess();
      if (!canWrite(session.role))
        throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted for this command.");
      if (cmd.humanOnly && session.principal.kind !== "human")
        throw new KernelError(
          "FORBIDDEN",
          "HUMAN_ACCEPTANCE_REQUIRED",
          "A human principal must accept this.",
        );
      const prior = (
        await tx.query(
          "SELECT id, payload_hash, applied_seq, workspace_version, result_fingerprint FROM commands WHERE workspace_id = $1 AND idempotency_key = $2",
          [workspaceId, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash)
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key reused with a different command.",
          );
        const ev = (
          await tx.query("SELECT payload FROM workspace_events WHERE workspace_id = $1 AND seq = $2", [
            workspaceId,
            prior.applied_seq,
          ])
        ).rows[0];
        return {
          commandId: prior.id,
          workspaceVersion: prior.workspace_version,
          eventSeq: prior.applied_seq,
          resultFingerprint: prior.result_fingerprint,
          replayed: true,
          result: (ev?.payload?.result ?? null) as R,
        };
      }
      if (ws.version !== cmd.expectedVersion)
        throw new KernelError("STALE_VERSION", "STALE_VERSION", "Workspace changed since it was read.", {
          retryable: true,
          lastStableRevision: ws.version,
          nextAction: "Re-read the workspace and resubmit with the current version.",
        });
      const out = await cmd.handle({
        tx,
        session,
        commandId,
        workspace: { id: ws.id, orgId: ws.org_id, version: ws.version, activeBranchId: ws.active_branch_id },
      });
      const newVersion = ws.version + 1;
      await tx.query("UPDATE workspaces SET version = $2 WHERE id = $1", [workspaceId, newVersion]);
      const ev = await this.journal.append(tx, {
        orgId: ws.org_id,
        workspaceId,
        type: out.eventType,
        actorId: session.userId,
        data: { ...out.data, commandType: cmd.commandType, result: out.result },
        causationId: commandId,
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
          commandId,
          ws.org_id,
          workspaceId,
          key,
          cmd.expectedVersion,
          session.userId,
          cmd.commandType,
          payloadHash,
          ev.seq,
          newVersion,
          fingerprint,
        ],
      );
      return {
        commandId,
        workspaceVersion: newVersion,
        eventSeq: ev.seq,
        resultFingerprint: fingerprint,
        replayed: false,
        result: out.result,
      };
    });
  }
}
