import type { DomainEvent } from "@nearesis/contracts";
import type { Session } from "./auth.ts";
import type { Db } from "./db/pool.ts";
import type { EventJournal } from "./journal.ts";
import { noWorkspaceAccess } from "./workspace.ts";

export interface StreamOptions {
  /** Cursors older than head - retainEvents get reload_required (ch.11). */
  retainEvents?: number;
  /** Subscribers lagging more than this many events receive one coalesced aggregate instead of the backlog. */
  maxLag?: number;
  /** Max events read (and therefore buffered) per subscriber per step. */
  batch?: number;
  /**
   * Poll sharing (ms, default 0 = off). When on, subscribers of one workspace share the last journal window for this
   * long: a caught-up subscriber gets "nothing new" and one slightly behind gets the cached events, both without a
   * database read, so N streams cost about one read per window instead of N. Events are delayed by at most this long.
   * Authorisation is unchanged: every first read and every read that misses the window goes through the tenant tx.
   */
  headCacheMs?: number;
}

export interface ReadOptions {
  /** Overrides `maxLag` for this read: a slow client is coalesced at a shorter backlog than a healthy one. */
  maxLag?: number;
}

export type ReadResult =
  | { status: "ok"; events: DomainEvent[]; head: number }
  | { status: "reload_required"; head: number; workspaceVersion: number }
  | {
      status: "coalesced";
      head: number;
      aggregate: {
        fromSeq: number;
        toSeq: number;
        count: number;
        byType: Record<string, number>;
        workspaceVersion: number;
      };
    };

/** Cursor-based replay over the committed event journal. Memory per subscriber is bounded by `batch`. */
export class EventStreamService {
  readonly retainEvents: number;
  readonly maxLag: number;
  readonly batch: number;
  private readonly headCacheMs: number;
  /** Last journal window read per workspace: `events` cover seq fromSeq..through (at most one batch). */
  private readonly tail = new Map<
    string,
    { at: number; fromSeq: number; through: number; events: DomainEvent[] }
  >();
  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
    opts: StreamOptions = {},
  ) {
    this.retainEvents = opts.retainEvents ?? 10_000;
    this.maxLag = opts.maxLag ?? 200;
    this.batch = opts.batch ?? 100;
    this.headCacheMs = opts.headCacheMs ?? 0;
  }

  /** ACL check only; throws the standard no-access error for foreign and unknown workspaces. */
  async authorize(session: Session, workspaceId: string): Promise<void> {
    await this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const r = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (!r.rows[0]) throw noWorkspaceAccess();
    });
  }

  async read(
    session: Session,
    workspaceId: string,
    afterSeq: number,
    firstRead: boolean,
    ro: ReadOptions = {},
  ): Promise<ReadResult> {
    if (this.headCacheMs > 0 && !firstRead) {
      const key = `${session.principal.orgId}:${workspaceId}`;
      const c = this.tail.get(key);
      if (c && Date.now() - c.at < this.headCacheMs) {
        // Caught up as of the last read: nothing new. Slightly behind but inside the cached window: serve it from memory.
        if (c.through <= afterSeq) return { status: "ok", events: [], head: afterSeq };
        if (afterSeq >= c.fromSeq - 1 && c.through - afterSeq <= (ro.maxLag ?? this.maxLag))
          return {
            status: "ok",
            events: c.events.filter((e) => e.seq > afterSeq).slice(0, this.batch),
            head: c.through,
          };
      }
    }
    const r = await this.readOnce(session, workspaceId, afterSeq, firstRead, ro);
    if (this.headCacheMs > 0 && r.status === "ok") {
      if (this.tail.size > 5000) this.tail.clear();
      this.tail.set(`${session.principal.orgId}:${workspaceId}`, {
        at: Date.now(),
        fromSeq: afterSeq + 1,
        through: r.events.length ? r.events[r.events.length - 1]!.seq : afterSeq,
        events: r.events,
      });
    }
    return r;
  }

  private async readOnce(
    session: Session,
    workspaceId: string,
    afterSeq: number,
    firstRead: boolean,
    ro: ReadOptions,
  ): Promise<ReadResult> {
    const maxLag = ro.maxLag ?? this.maxLag;
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const ws = (await tx.query("SELECT version FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const head: number = (
        await tx.query(
          "SELECT coalesce(max(seq), 0)::int AS h FROM workspace_events WHERE workspace_id = $1",
          [workspaceId],
        )
      ).rows[0].h;
      if (firstRead && (afterSeq > head || head - afterSeq > this.retainEvents)) {
        return { status: "reload_required", head, workspaceVersion: ws.version };
      }
      if (head - afterSeq > maxLag) {
        const rows = (
          await tx.query(
            "SELECT event_type, count(*)::int n FROM workspace_events WHERE workspace_id = $1 AND seq > $2 AND seq <= $3 GROUP BY 1",
            [workspaceId, afterSeq, head],
          )
        ).rows;
        const byType: Record<string, number> = {};
        for (const r of rows) byType[r.event_type] = r.n;
        return {
          status: "coalesced",
          head,
          aggregate: {
            fromSeq: afterSeq + 1,
            toSeq: head,
            count: head - afterSeq,
            byType,
            workspaceVersion: ws.version,
          },
        };
      }
      return { status: "ok", head, events: await this.journal.read(tx, workspaceId, afterSeq, this.batch) };
    });
  }
}
