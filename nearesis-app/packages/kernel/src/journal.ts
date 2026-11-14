import { randomUUID } from "node:crypto";
import type { DomainEvent, DomainEventType } from "@nearesis/contracts";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { Tx } from "./db/pool.ts";
import { redact } from "./redact.ts";

export interface AppendArgs {
  orgId: string;
  workspaceId: string;
  type: DomainEventType;
  actorId: string | null;
  data: Record<string, unknown>;
  causationId?: string | null;
  correlationId?: string | null;
  sourceRevision?: number | null;
}

/** Append-only workspace event journal + outbox. Must be called inside the command transaction. */
export class EventJournal {
  /** Caller must hold the workspace row lock so seq assignment is serialized. */
  async append(tx: Tx, a: AppendArgs): Promise<{ eventId: string; seq: number }> {
    const data = redact(a.data) as Record<string, unknown>;
    const seq = (
      await tx.query<{ seq: number }>(
        "SELECT coalesce(max(seq), 0) + 1 AS seq FROM workspace_events WHERE workspace_id = $1",
        [a.workspaceId],
      )
    ).rows[0]!.seq;
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO workspace_events(event_id, org_id, workspace_id, seq, event_type, payload, payload_hash, actor_id,
         causation_id, correlation_id, source_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        eventId,
        a.orgId,
        a.workspaceId,
        seq,
        a.type,
        JSON.stringify(data),
        sha256Hex(canonicalJson(data)),
        a.actorId,
        a.causationId ?? null,
        a.correlationId ?? null,
        a.sourceRevision ?? null,
      ],
    );
    await tx.query("INSERT INTO outbox(id, event_id, org_id, workspace_id, topic) VALUES ($1,$2,$3,$4,$5)", [
      randomUUID(),
      eventId,
      a.orgId,
      a.workspaceId,
      "workspace.entity.changed.v1",
    ]);
    return { eventId, seq };
  }

  async read(tx: Tx, workspaceId: string, afterSeq = 0, limit = 500): Promise<DomainEvent[]> {
    const r = await tx.query(
      `SELECT * FROM workspace_events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [workspaceId, afterSeq, limit],
    );
    return r.rows.map((e) => ({
      eventId: e.event_id,
      orgId: e.org_id,
      workspaceId: e.workspace_id,
      seq: e.seq,
      type: e.event_type,
      causationId: e.causation_id,
      correlationId: e.correlation_id,
      actorId: e.actor_id,
      emittedAt: new Date(e.occurred_at).toISOString(),
      schemaVersion: e.schema_version,
      payloadHash: e.payload_hash,
      sourceRevision: e.source_revision,
      data: e.payload,
    }));
  }
}

export interface AuditArgs {
  orgId: string | null;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  subject?: string | null;
  outcome: "ok" | "denied" | "failed";
  reasonCode?: string | null;
  detail?: Record<string, unknown>;
  traceId?: string | null;
}

export async function writeAudit(tx: Tx, a: AuditArgs): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO audit_events(id, org_id, workspace_id, actor_id, action, subject, outcome, reason_code, detail, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      a.orgId,
      a.workspaceId ?? null,
      a.actorId ?? null,
      a.action,
      a.subject ?? null,
      a.outcome,
      a.reasonCode ?? null,
      JSON.stringify(redact(a.detail ?? {})),
      a.traceId ?? null,
    ],
  );
  return id;
}
