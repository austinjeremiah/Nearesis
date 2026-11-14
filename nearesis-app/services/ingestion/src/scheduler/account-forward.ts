import type { ClickHouseClient } from "@clickhouse/client";
import type { BigQueryLike } from "../adapters/bigquery.ts";
import type { RawArchive } from "../archive/archive.ts";
import { AccountStateStore, runAccountPhase, type AccountPhaseResult } from "../backfill/account-run.ts";
import type { AccountChunk } from "../backfill/account-sql.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import { addDays } from "../backfill/plan.ts";
import { FORWARD_FROM_DAY } from "./config.ts";
import { daysBetween, lastCompletedDay } from "./plan.ts";

export const accountChunkOf = (day: string): AccountChunk => ({
  id: `account:${day}`,
  from: day,
  to: addDays(day, 1),
});

/**
 * Forward days still missing account-level data. A day is only eligible once its `transactions:<day>` chunk is done in the
 * scheduler's BigQuery state (the provider has the day), so a provider lag is never recorded as an account gap.
 */
export function pendingAccountDays(
  nowMs: number,
  store: Pick<AccountStateStore, "isDone">,
  txDone: (day: string) => boolean,
): string[] {
  const last = lastCompletedDay(nowMs);
  if (last < FORWARD_FROM_DAY) return [];
  return daysBetween(FORWARD_FROM_DAY, last).filter((d) => txDone(d) && !store.isDone(`account:${d}`));
}

/** Same dry run, 2% fit check, maximumBytesBilled and archive path as the backfill (one job per day, oldest first). */
export async function runAccountDaily(d: {
  bq: BigQueryLike;
  archive: RawArchive;
  ch: ClickHouseClient;
  store: AccountStateStore;
  ledger: BudgetLedger;
  location: string;
  days: string[];
  maxDays: number;
  nowMs: () => number;
  log?: (m: string) => void;
}): Promise<AccountPhaseResult> {
  return runAccountPhase({
    bq: d.bq,
    archive: d.archive,
    ch: d.ch,
    store: d.store,
    ledger: d.ledger,
    location: d.location,
    chunks: d.days.slice(0, d.maxDays).map(accountChunkOf),
    nowMs: d.nowMs,
    ...(d.log ? { log: d.log } : {}),
  });
}
