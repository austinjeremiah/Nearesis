import type { ClickHouseClient } from "@clickhouse/client";
import type { Db } from "../db.ts";
import { insertLive } from "./ch.ts";
import { EXPLORER_DATASET, EXPLORER_PROVIDER } from "./explorer-coverage.ts";
import { addDays } from "./plan.ts";

export const CURSOR_JUMP = "EXPLORER_CURSOR_JUMP";
/** A normal 1000-swap page spans hours; a newest-to-oldest step over more than this is a hole, not a quiet day. */
export const DEFAULT_JUMP_THRESHOLD_HOURS = 24;

/** Two consecutive pages of ONE cursor chain (page A's cursorAfter is page B's cursorBefore) whose swap times do not meet. */
export interface CursorJump {
  /** Newer page (fetched first, going backwards in time) and the older time it reached. */
  prevPageHash: string;
  prevOldestCreatedAt: string;
  /** The page the provider returned next and the newest time on it. */
  nextPageHash: string;
  nextNewestCreatedAt: string;
  /** Hole to refetch: (nextNewest, prevOldest) as UTC instants. */
  fromUTC: string;
  toUTC: string;
  /** Whole UTC days that touch the hole, inclusive: the exact range a refetch must cover. */
  refetchFromDay: string;
  refetchToDay: string;
}

/**
 * Finds holes in the loaded Explorer data from the raw-archive cursor chain: pages whose cursor links them (cursorAfter of one
 * is cursorBefore of the next) but whose swap times jump backwards by more than `thresholdHours`. Read-only.
 */
export async function findExplorerCursorJumps(
  db: Pick<Db, "query">,
  thresholdHours: number = DEFAULT_JUMP_THRESHOLD_HOURS,
): Promise<CursorJump[]> {
  const r = await db.query<{ prev: string; next: string; prev_lo: Date; next_hi: Date }>(
    `WITH pg AS (SELECT raw_object_hash h, min(created_at) lo, max(created_at) hi FROM ingestion.explorer_swaps GROUP BY 1),
          obs AS (SELECT DISTINCT ON (payload_object_hash) payload_object_hash h, envelope->>'cursorBefore' cb, envelope->>'cursorAfter' ca
                    FROM ingestion.raw_observations WHERE provider_id = $1 ORDER BY payload_object_hash, id)
     SELECT a.h AS prev, b.h AS next, pa.lo AS prev_lo, pb.hi AS next_hi
       FROM obs a JOIN obs b ON b.cb = a.ca AND b.h <> a.h
       JOIN pg pa ON pa.h = a.h JOIN pg pb ON pb.h = b.h
      WHERE pa.lo - pb.hi > make_interval(hours => $2::int)
      ORDER BY pa.lo DESC`,
    [EXPLORER_PROVIDER, thresholdHours],
  );
  return r.rows.map((x) => {
    const lo = x.prev_lo.toISOString();
    const hi = x.next_hi.toISOString();
    return {
      prevPageHash: x.prev,
      prevOldestCreatedAt: lo,
      nextPageHash: x.next,
      nextNewestCreatedAt: hi,
      fromUTC: hi,
      toUTC: lo,
      refetchFromDay: hi.slice(0, 10),
      refetchToDay: lo.slice(0, 10),
    };
  });
}

export const cursorJumpCode = (j: Pick<CursorJump, "prevPageHash" | "nextPageHash">): string =>
  `${CURSOR_JUMP}:${j.prevPageHash.slice(0, 12)}:${j.nextPageHash.slice(0, 12)}`;

/**
 * Records each hole as a `partial` quality gap (never unavailable: the days may hold data the provider simply did not return on
 * this cursor) in ClickHouse and Postgres. Idempotent (ReplacingMergeTree key; Postgres insert only when absent).
 */
export async function recordCursorJumps(
  db: Pick<Db, "query">,
  ch: ClickHouseClient,
  jumps: CursorJump[],
  version: number = Date.now(),
): Promise<number> {
  for (const j of jumps) {
    await insertLive(ch, "quality_gaps", [
      {
        provider_id: EXPLORER_PROVIDER,
        dataset: EXPLORER_DATASET,
        from_utc: j.fromUTC,
        to_utc: j.toUTC,
        state: "partial",
        reason_code: cursorJumpCode(j),
        source_label: "LIVE",
        version,
      },
    ]);
    await db.query(
      `INSERT INTO ingestion.quality_gaps(provider_id, dataset, from_utc, to_utc, state, reason_code)
       SELECT $1, $2, $3, $4, 'partial', $5
        WHERE NOT EXISTS (SELECT 1 FROM ingestion.quality_gaps WHERE provider_id = $1 AND dataset = $2 AND reason_code = $5)`,
      [EXPLORER_PROVIDER, EXPLORER_DATASET, j.fromUTC, j.toUTC, cursorJumpCode(j)],
    );
  }
  return jumps.length;
}

/** The provider request window (Unix seconds, start non-inclusive) that refetches exactly the whole days of a jump. */
export function refetchWindow(j: Pick<CursorJump, "refetchFromDay" | "refetchToDay">): {
  startUnix: number;
  endUnix: number;
  streamKey: string;
} {
  return {
    startUnix: Date.parse(`${j.refetchFromDay}T00:00:00Z`) / 1000 - 1,
    endUnix: Date.parse(`${addDays(j.refetchToDay, 1)}T00:00:00Z`) / 1000,
    streamKey: `transactions:refetch:${j.refetchFromDay}:${j.refetchToDay}`,
  };
}
