import type { ClickHouseClient } from "@clickhouse/client";
import type { BqRow } from "../backfill/bq-runner.ts";
import { coverageRows, insertLive, type Provenance } from "../backfill/ch.ts";
import { addDays } from "../backfill/plan.ts";
import { scanRows, type ScanRows } from "./rows.ts";

export const ACCOUNT_COHORT_DATASETS = [
  "account_daily_head",
  "account_daily_tail",
  "entity_daily_signers",
  "account_daily_new_returning",
] as const;

const daysOf = (from: string, toExclusive: string): string[] => {
  const out: string[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Idempotent (ReplacingMergeTree) load of the scan result plus one source_coverage row per day per dataset. */
export async function loadAccountScan(
  ch: ClickHouseClient,
  chunk: { from: string; to: string },
  rows: BqRow[],
  p: Provenance,
  opts: { head: number; registryVersion: string },
): Promise<{ rows: number; parsed: ScanRows }> {
  const parsed = scanRows(rows, p, { ...opts, windowStart: chunk.from });
  let n = 0;
  n += await insertLive(ch, "account_daily_head", parsed.head);
  n += await insertLive(ch, "account_daily_tail", parsed.tail);
  n += await insertLive(ch, "entity_daily_signers", parsed.entity);
  n += await insertLive(ch, "account_daily_new_returning", parsed.newReturning);
  n += await insertLive(ch, "account_cohort_week_retention", parsed.retention);
  n += await insertLive(ch, "account_head_profile", parsed.profile);
  const present = new Set(parsed.days);
  const v = Date.parse(p.fetchedAtUTC);
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      [...ACCOUNT_COHORT_DATASETS].flatMap((dataset) =>
        daysOf(chunk.from, chunk.to).map((day) => ({
          provider_id: "near-bigquery",
          dataset,
          day,
          state: present.has(day) ? ("complete" as const) : ("unavailable" as const),
          reason: present.has(day) ? null : "PROVIDER_GAP",
          version: v,
        })),
      ),
    ),
  );
  return { rows: n, parsed };
}
