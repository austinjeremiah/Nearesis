import type { DomainEvent } from "@nearesis/contracts";
import type { Db, Tx } from "./db/pool.ts";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { fanoutEvent } from "./classification.ts";
import { IntegrityGuard } from "./integrity.ts";
import { redactString } from "./redact.ts";

export interface ConsumerContext {
  tx: Tx;
  event: DomainEvent;
}
/** A consumer's effect runs inside the same transaction as its receipt insert, so effect + dedupe commit atomically. */
export type Consumer = (ctx: ConsumerContext) => Promise<void>;

interface ClaimRow {
  outbox_id: string;
  event_id: string;
  org_id: string;
  workspace_id: string;
  attempts: number;
  seq: number;
  event_type: DomainEvent["type"];
  payload: Record<string, unknown>;
  payload_hash: string;
  actor_id: string | null;
  occurred_at: Date;
  causation_id: string | null;
  correlation_id: string | null;
  source_revision: number | null;
  schema_version: number;
}

export function rowToEvent(e: ClaimRow): DomainEvent {
  return {
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
  };
}

/** Polls the outbox with FOR UPDATE SKIP LOCKED and delivers to consumers; at-least-once, deduped by receipts. */
export class OutboxPublisher {
  private readonly consumers = new Map<string, Consumer>();
  private timer: NodeJS.Timeout | undefined;

  private readonly integrity: IntegrityGuard;

  constructor(private readonly db: Db) {
    this.integrity = new IntegrityGuard(db);
  }

  /** Re-hashes the stored payload against `payload_hash` before any consumer sees it; a mismatch quarantines the event. */
  async verifyRow(row: ClaimRow): Promise<void> {
    await this.integrity.verify(
      { orgId: row.org_id, userId: null },
      "outbox_event",
      row.event_id,
      row.payload_hash,
      sha256Hex(canonicalJson(row.payload)),
    );
  }

  private readonly broad = new Set<string>();

  /**
   * `broad` consumers sit outside the workspace (telemetry, cross-tenant fan-out): they receive `fanoutEvent(event)`,
   * identifiers and enums only, never labels, notes or data bodies (SEC21).
   */
  register(name: string, consumer: Consumer, opts: { broad?: boolean } = {}): void {
    this.consumers.set(name, consumer);
    if (opts.broad) this.broad.add(name);
  }

  /** Deliver one event to every consumer. Returns the number of consumers whose effect actually ran. */
  async deliver(event: DomainEvent): Promise<number> {
    let ran = 0;
    for (const [name, consumer] of this.consumers) {
      const did = await this.db.tx(
        { orgId: event.orgId, userId: event.actorId ?? event.orgId, actorKind: "service" },
        async (tx) => {
          const r = await tx.query(
            "INSERT INTO consumer_receipts(consumer, event_id, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
            [name, event.eventId, event.orgId],
          );
          if (r.rowCount === 0) return false; // duplicate delivery: no second effect
          await consumer({ tx, event: this.broad.has(name) ? fanoutEvent(event) : event });
          return true;
        },
      );
      if (did) ran++;
    }
    return ran;
  }

  /** One poll. Claimed rows stay locked (SKIP LOCKED for other publishers) until this transaction ends. */
  async runOnce(batch = 50): Promise<{ delivered: number; failed: number }> {
    return this.db.txGlobal(async (tx) => {
      const rows = (await tx.query<ClaimRow>("SELECT * FROM outbox_claim($1)", [batch])).rows;
      let delivered = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await this.verifyRow(row);
          await this.deliver(rowToEvent(row));
          await tx.query("SELECT outbox_settle($1, true, NULL)", [row.outbox_id]);
          delivered++;
        } catch (e) {
          await tx.query("SELECT outbox_settle($1, false, $2)", [
            row.outbox_id,
            redactString((e as Error).message),
          ]);
          failed++;
        }
      }
      return { delivered, failed };
    });
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
