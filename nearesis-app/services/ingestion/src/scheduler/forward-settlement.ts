import type { ClickHouseClient } from "@clickhouse/client";
import type { BqRow } from "../backfill/bq-runner.ts";
import { coverageRows, insertLive, type Provenance } from "../backfill/ch.ts";

/**
 * Stores one day of settlement durations (same derivation as intents/settlement-pilot-cli.ts, parameterised by day):
 * tx times keyed by hash, then per swap the durations from the block times of its nearTxHashes. A swap with any hash not found
 * is `complete = 0` and has no settlement_ms (never zero-filled). Public-era swaps only.
 */
export async function loadSettlementDay(
  ch: ClickHouseClient,
  day: string,
  bqRows: BqRow[],
  p: Provenance,
): Promise<number> {
  const windowId = `settlement:${day}`;
  const ver = Date.parse(p.fetchedAtUTC);
  const ts = new Map<string, bigint>();
  for (const row of bqRows) ts.set(String(row.tx_hash), BigInt(String(row.block_ts_ns)));
  await insertLive(
    ch,
    "intents_settlement_tx_times",
    [...ts].map(([h, t]) => ({
      tx_hash: h,
      block_ts_ns: t.toString(),
      window_id: windowId,
      source_label: "LIVE",
      raw_object_hash: p.rawObjectHash,
      fetched_at: p.fetchedAtUTC,
      version: ver,
    })),
  );
  const q = await ch.query({
    query: `SELECT swap_key, status, toUnixTimestamp64Milli(created_at) AS created_ms, formatDateTime(created_at,'%Y-%m-%d %H:%i:%S.%f') AS created_at_s, toString(created_day) AS day, public_swap_tx_hashes AS hashes,
      multiIf(o.chain != '', o.chain,
        match(s.origin_asset, '^nep141:[a-z0-9]+(-[^.]+)?\\\\.(omft|omdep)\\\\.near$'), extract(s.origin_asset, '^nep141:([a-z0-9]+)'),
        match(s.origin_asset, '^1cs_v1:[a-z0-9]+:'), extract(s.origin_asset, '^1cs_v1:([a-z0-9]+):'),
        match(s.origin_asset, '^nep141:[^:]+$'), 'near', 'unknown') AS chain
    FROM intents_swaps AS s FINAL
    LEFT JOIN (SELECT provider_asset_id AS a, argMax(blockchain, version) AS chain FROM asset_registry GROUP BY a) AS o ON o.a = s.origin_asset
    WHERE s.created_day = {d:Date} AND s.privacy_era = 'public' AND length(public_swap_tx_hashes) > 0`,
    query_params: { d: day },
    format: "JSONEachRow",
  });
  const swaps = (await q.json()) as Array<{
    swap_key: string;
    status: string;
    created_ms: string;
    created_at_s: string;
    day: string;
    hashes: string[];
    chain: string;
  }>;
  const rows = swaps.map((s) => {
    const found = s.hashes.map((h) => ts.get(h));
    const nFound = found.filter((x) => x !== undefined).length;
    const complete = nFound === s.hashes.length;
    const created = BigInt(s.created_ms);
    const ms = (x: bigint): string => (x / 1_000_000n - created).toString();
    let min: bigint | undefined;
    let max: bigint | undefined;
    let maxIdx: number | null = null;
    found.forEach((t, i) => {
      if (t === undefined) return;
      if (min === undefined || t < min) min = t;
      if (max === undefined || t > max) {
        max = t;
        maxIdx = i;
      }
    });
    const f0 = found[0];
    const fl = found[found.length - 1];
    return {
      swap_key: s.swap_key,
      window_id: windowId,
      status: s.status,
      created_at: s.created_at_s.slice(0, 23),
      created_day: s.day,
      origin_chain: s.chain,
      n_hashes: s.hashes.length,
      n_found: nFound,
      complete: complete ? 1 : 0,
      first_listed_ms: f0 === undefined ? null : ms(f0),
      last_listed_ms: fl === undefined ? null : ms(fl),
      min_ms: min === undefined ? null : ms(min),
      max_ms: max === undefined ? null : ms(max),
      max_hash_index: complete ? maxIdx : null,
      settlement_ms: complete && max !== undefined ? ms(max) : null,
      source_label: "LIVE",
      raw_object_hash: p.rawObjectHash,
      fetched_at: p.fetchedAtUTC,
      version: ver,
    };
  });
  await insertLive(ch, "intents_settlement_durations", rows);
  const part = rows.some((x) => x.complete === 0);
  await insertLive(
    ch,
    "source_coverage",
    coverageRows([
      {
        provider_id: "near-bigquery",
        dataset: "intents_settlement_durations",
        day,
        state:
          rows.length === 0 ? ("unavailable" as const) : part ? ("partial" as const) : ("complete" as const),
        reason: rows.length === 0 ? "PROVIDER_GAP" : part ? "SOME_HASHES_NOT_FOUND" : null,
        version: ver,
      },
    ]),
  );
  return rows.length + ts.size;
}
