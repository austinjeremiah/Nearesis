import type { ClickHouseClient } from "@clickhouse/client";

export interface DayRecon {
  day: string;
  field: string;
  existing: string;
  scan: string;
}
export interface Reconciliation {
  daysCompared: number;
  daysMissingInScan: string[];
  daysMissingInExisting: string[];
  differences: DayRecon[];
  headPlusTailEqualsOrganic: { days: number; mismatches: DayRecon[] };
}

type R = Record<string, string>;
const q = async (ch: ClickHouseClient, query: string): Promise<R[]> =>
  (await (
    await ch.query({
      query,
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
    })
  ).json()) as R[];

/**
 * Compares the scan with the already loaded account_daily_activity (an independent query of the same source). Every field is
 * compared exactly (strings of UInt64); any difference is listed with both values. Fields: tx_total, tx_intents, tx_bridge,
 * tx_organic, signers_total, signers_organic, signers_with_intents, top1pct/top5pct signer counts and organic tx.
 * Also: head tx + tail tx = existing tx_organic per day, and head count + tail signers = existing signers_organic.
 */
export async function reconcileScan(
  ch: ClickHouseClient,
  from: string,
  toExclusive: string,
): Promise<Reconciliation> {
  const p = `block_date >= '${from}' AND block_date < '${toExclusive}'`;
  const ex = await q(
    ch,
    `SELECT toString(block_date) AS d, toString(tx_total) AS tx_total, toString(tx_intents) AS tx_intents, toString(tx_bridge) AS tx_bridge, toString(tx_organic) AS tx_organic, toString(signers_total) AS signers_total, toString(signers_organic) AS signers_organic, toString(signers_with_intents) AS signers_with_intents, toString(top1pct_signer_count) AS top1c, toString(top5pct_signer_count) AS top5c, toString(top1pct_organic_tx) AS top1t, toString(top5pct_organic_tx) AS top5t FROM account_daily_activity FINAL WHERE ${p} ORDER BY d`,
  );
  const sc = await q(
    ch,
    `SELECT toString(block_date) AS d, toString(signers_all) AS signers_total, toString(tx_all) AS tx_total, toString(tx_intents) AS tx_intents, toString(tx_bridge) AS tx_bridge, toString(tx_organic) AS tx_organic, toString(signers_organic) AS signers_organic, toString(signers_with_intents) AS signers_with_intents, toString(top1pct_signer_count) AS top1c, toString(top5pct_signer_count) AS top5c, toString(top1pct_tx) AS top1t, toString(top5pct_tx) AS top5t FROM account_daily_new_returning FINAL WHERE ${p} ORDER BY d`,
  );
  const ht = await q(
    ch,
    `SELECT toString(h.block_date) AS d, toString(h.n) AS hn, toString(h.tx) AS htx, toString(t.tail_signers) AS ts, toString(t.tail_tx) AS tt FROM (SELECT block_date, count() AS n, sum(tx_organic) AS tx FROM account_daily_head FINAL WHERE ${p} GROUP BY block_date) h RIGHT JOIN (SELECT block_date, tail_signers, tail_tx FROM account_daily_tail FINAL WHERE ${p}) t ON h.block_date = t.block_date ORDER BY d`,
  );
  const scanBy = new Map(sc.map((r) => [r.d as string, r]));
  const exBy = new Map(ex.map((r) => [r.d as string, r]));
  const fields = [
    "tx_total",
    "tx_intents",
    "tx_bridge",
    "tx_organic",
    "signers_total",
    "signers_organic",
    "signers_with_intents",
    "top1c",
    "top5c",
    "top1t",
    "top5t",
  ] as const;
  const differences: DayRecon[] = [];
  let compared = 0;
  for (const [d, e] of exBy) {
    const s = scanBy.get(d);
    if (!s) continue;
    compared++;
    for (const f of fields)
      if (e[f] !== s[f]) differences.push({ day: d, field: f, existing: String(e[f]), scan: String(s[f]) });
  }
  const mismatches: DayRecon[] = [];
  for (const r of ht) {
    const e = exBy.get(r.d as string);
    if (!e) continue;
    const tx = BigInt(r.htx || "0") + BigInt(r.tt as string);
    if (tx.toString() !== e.tx_organic)
      mismatches.push({
        day: r.d as string,
        field: "head_tx+tail_tx",
        existing: String(e.tx_organic),
        scan: tx.toString(),
      });
    const sg = BigInt(r.hn || "0") + BigInt(r.ts as string);
    if (sg.toString() !== e.signers_organic)
      mismatches.push({
        day: r.d as string,
        field: "head_n+tail_signers",
        existing: String(e.signers_organic),
        scan: sg.toString(),
      });
  }
  return {
    daysCompared: compared,
    daysMissingInScan: [...exBy.keys()].filter((d) => !scanBy.has(d)),
    daysMissingInExisting: [...scanBy.keys()].filter((d) => !exBy.has(d)),
    differences,
    headPlusTailEqualsOrganic: { days: ht.length, mismatches },
  };
}
