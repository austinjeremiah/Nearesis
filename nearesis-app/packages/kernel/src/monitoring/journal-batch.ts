import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { Tx } from "../db/pool.ts";
import type { AppendArgs } from "../journal.ts";
import { redact } from "../redact.ts";

/**
 * Appends several journal events and their outbox rows with two statements (plus one seq read) instead of three round
 * trips per event (PERF03). Row content is identical to `EventJournal.append`: same redaction, same canonical payload
 * hash, same outbox topic, seq assigned consecutively in call order. The caller must hold the workspace row lock, and
 * all events must belong to one workspace.
 */
export async function appendBatch(
  tx: Tx,
  events: AppendArgs[],
): Promise<Array<{ eventId: string; seq: number }>> {
  if (events.length === 0) return [];
  const workspaceId = events[0]!.workspaceId;
  if (events.some((e) => e.workspaceId !== workspaceId))
    throw new Error("appendBatch: events must belong to one workspace");
  const first = (
    await tx.query<{ seq: number }>(
      "SELECT coalesce(max(seq), 0) + 1 AS seq FROM workspace_events WHERE workspace_id = $1",
      [workspaceId],
    )
  ).rows[0]!.seq;
  const out = events.map((_, i) => ({ eventId: randomUUID(), seq: Number(first) + i }));
  const CHUNK = 500;
  for (let s = 0; s < events.length; s += CHUNK) {
    const slice = events.slice(s, s + CHUNK);
    const params: unknown[] = [];
    const rows = slice.map((a, j) => {
      const data = redact(a.data) as Record<string, unknown>;
      const o = out[s + j]!;
      const b = params.length;
      params.push(
        o.eventId,
        a.orgId,
        a.workspaceId,
        o.seq,
        a.type,
        JSON.stringify(data),
        sha256Hex(canonicalJson(data)),
        a.actorId,
        a.causationId ?? null,
        a.correlationId ?? null,
        a.sourceRevision ?? null,
      );
      return `(${Array.from({ length: 11 }, (_, k) => `$${b + k + 1}`).join(",")})`;
    });
    await tx.query(
      `INSERT INTO workspace_events(event_id, org_id, workspace_id, seq, event_type, payload, payload_hash, actor_id,
         causation_id, correlation_id, source_revision) VALUES ${rows.join(",")}`,
      params,
    );
    const op: unknown[] = [];
    const orows = slice.map((a, j) => {
      const b = op.length;
      op.push(randomUUID(), out[s + j]!.eventId, a.orgId, a.workspaceId, "workspace.entity.changed.v1");
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
    });
    await tx.query(
      `INSERT INTO outbox(id, event_id, org_id, workspace_id, topic) VALUES ${orows.join(",")}`,
      op,
    );
  }
  return out;
}
