import type { ClickHouseClient } from "@clickhouse/client";
import { IngestionError } from "../errors.ts";
import type { BqRow } from "./bq-runner.ts";
import { bqScalar, coverageRows, insertLive, type Provenance, type Row } from "./ch.ts";
import { ACCOUNT_RULE_VERSION, HEAVY_SIGNER_THRESHOLD, type AccountChunk } from "./account-sql.ts";
import { addDays } from "./plan.ts";

const uint = (v: unknown, field: string): string => {
  const s = bqScalar(v, field);
  if (!/^\d+$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "not an unsigned integer", field });
  return s;
};
const dayOf = (v: unknown): string => {
  const s = bqScalar(v, "block_date").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "not a date" });
  return s;
};
const prov = (p: Provenance) => ({
  source_label: "LIVE",
  raw_object_hash: p.rawObjectHash,
  fetched_at: p.fetchedAtUTC,
  version: Date.parse(p.fetchedAtUTC),
});

/** Splits the query output into per-day aggregate rows and heavy-signer rows; verifies internal consistency. */
export function accountRows(
  rows: BqRow[],
  p: Provenance,
  heavy: number = HEAVY_SIGNER_THRESHOLD,
): { days: Row[]; heavySigners: Row[] } {
  const days: Row[] = [];
  const heavySigners: Row[] = [];
  for (const r of rows) {
    if (r.kind === "day") {
      const total = BigInt(uint(r.tx_total, "tx_total"));
      const intents = BigInt(uint(r.tx_intents, "tx_intents"));
      const bridge = BigInt(uint(r.tx_bridge, "tx_bridge"));
      if (intents + bridge > total)
        throw new IngestionError("INVALID_INPUT", false, { reason: "intents+bridge exceed total" });
      days.push({
        block_date: dayOf(r.block_date),
        tx_total: total.toString(),
        tx_intents: intents.toString(),
        tx_bridge: bridge.toString(),
        tx_organic: (total - intents - bridge).toString(),
        signers_total: uint(r.signers_total, "signers_total"),
        signers_organic: uint(r.signers_organic, "signers_organic"),
        signers_with_intents: uint(r.signers_with_intents, "signers_with_intents"),
        top1pct_signer_count: uint(r.top1_count, "top1_count"),
        top5pct_signer_count: uint(r.top5_count, "top5_count"),
        top1pct_organic_tx: uint(r.top1_tx, "top1_tx"),
        top5pct_organic_tx: uint(r.top5_tx, "top5_tx"),
        account_rule_version: ACCOUNT_RULE_VERSION,
        ...prov(p),
      });
    } else if (r.kind === "signer") {
      const total = BigInt(uint(r.tx_total, "tx_total"));
      const intents = BigInt(uint(r.tx_intents, "tx_intents"));
      const bridge = BigInt(uint(r.tx_bridge, "tx_bridge"));
      if (r.signer === null || r.signer === undefined || String(r.signer) === "")
        throw new IngestionError("INVALID_INPUT", false, { reason: "heavy row without signer" });
      heavySigners.push({
        block_date: dayOf(r.block_date),
        signer_account_id: String(r.signer),
        tx_total: total.toString(),
        tx_intents: intents.toString(),
        tx_bridge: bridge.toString(),
        intents_generated: (intents + bridge) * 2n > total ? 1 : 0,
        heavy_threshold: heavy,
        account_rule_version: ACCOUNT_RULE_VERSION,
        ...prov(p),
      });
    } else throw new IngestionError("INVALID_INPUT", false, { reason: "unknown row kind" });
  }
  return { days, heavySigners };
}

export function accountDays(c: Pick<AccountChunk, "from" | "to">): string[] {
  const out: string[] = [];
  for (let d = c.from; d < c.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Idempotent (ReplacingMergeTree) load of one chunk. Days without a result row become explicit coverage gaps. */
export async function loadAccountChunk(
  ch: ClickHouseClient,
  chunk: AccountChunk,
  rows: BqRow[],
  p: Provenance,
): Promise<number> {
  const { days, heavySigners } = accountRows(rows, p);
  const present = new Set(days.map((d) => d.block_date as string));
  let n = await insertLive(ch, "account_daily_activity", days);
  n += await insertLive(ch, "account_daily_heavy_signers", heavySigners);
  const v = Date.parse(p.fetchedAtUTC);
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      accountDays(chunk).map((day) => ({
        provider_id: "near-bigquery",
        dataset: "account_daily_activity",
        day,
        state: present.has(day) ? ("complete" as const) : ("unavailable" as const),
        reason: present.has(day) ? null : "PROVIDER_GAP",
        version: v,
      })),
    ),
  );
  await insertLive(
    ch,
    "quality_gaps",
    accountDays(chunk)
      .filter((d) => !present.has(d))
      .map((day) => ({
        provider_id: "near-bigquery",
        dataset: "account_daily_activity",
        from_utc: `${day}T00:00:00.000Z`,
        to_utc: `${day}T23:59:59.999Z`,
        state: "unavailable",
        reason_code: "PROVIDER_GAP",
        source_label: "LIVE",
        version: v,
      })),
  );
  return n;
}
