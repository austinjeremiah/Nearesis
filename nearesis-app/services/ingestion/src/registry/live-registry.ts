import type { ClickHouseClient } from "@clickhouse/client";
import { AssetRegistry } from "./assets.ts";
import {
  ONECLICK_PROVIDER,
  ONECLICK_TOKENS_URL,
  entriesToAliases,
  type RegistryEntry,
} from "./oneclick-tokens.ts";

const ts = (iso: string): string => new Date(iso).toISOString().replace("T", " ").replace("Z", "");

/** Insert registry rows for one token-list fetch. Re-running with the same fetch is idempotent (same version). */
export async function saveLiveAssetRegistry(
  ch: ClickHouseClient,
  entries: RegistryEntry[],
  src: { rawObjectHash: string; fetchedAtUTC: string },
): Promise<number> {
  const version = Date.parse(src.fetchedAtUTC);
  const rows = entries.map((e) => ({
    provider_id: ONECLICK_PROVIDER,
    provider_asset_id: e.providerAssetId,
    canonical_asset_id: e.canonicalAssetId,
    verification: e.verification,
    unknown_reason: e.unknownReason,
    symbol_observed: e.symbolObserved,
    blockchain: e.blockchain,
    coingecko_id: e.coingeckoId,
    valid_from: ts(e.validFrom),
    valid_to: e.validTo === null ? null : ts(e.validTo),
    evidence_url: ONECLICK_TOKENS_URL,
    source_raw_object_hash: src.rawObjectHash,
    source_label: "LIVE",
    fetched_at: ts(src.fetchedAtUTC),
    version,
  }));
  if (rows.length) await ch.insert({ table: "asset_registry", values: rows, format: "JSONEachRow" });
  return rows.length;
}

/** Latest registry as an AssetRegistry (null when nothing is stored yet; callers then leave canonical NULL). */
export async function loadLiveAssetRegistry(ch: ClickHouseClient): Promise<AssetRegistry | null> {
  const rs = await ch.query({
    query: `SELECT provider_asset_id AS pid, canonical_asset_id AS canon, verification AS ver,
                   toString(valid_from) AS vf, toString(valid_to) AS vt
              FROM asset_registry FINAL
             WHERE provider_id = '${ONECLICK_PROVIDER}' AND canonical_asset_id IS NOT NULL`,
    format: "JSONEachRow",
    clickhouse_settings: { date_time_output_format: "iso" },
  });
  const rows = (await rs.json()) as Array<{
    pid: string;
    canon: string;
    ver: "verified" | "unverified" | "ambiguous";
    vf: string;
    vt: string | null;
  }>;
  if (rows.length === 0) return null;
  const aliases = entriesToAliases(
    rows.map((r) => ({
      providerAssetId: r.pid,
      canonicalAssetId: r.canon,
      verification: r.ver,
      unknownReason: null,
      symbolObserved: "",
      blockchain: "",
      coingeckoId: null,
      deprecated: false,
      validFrom: r.vf,
      validTo: r.vt,
    })),
  );
  return new AssetRegistry(aliases);
}

/** Rows per re-derivation statement (counted with duplicates), sized for the 2 GiB ClickHouse container. */
const CHUNK_ROWS = 60_000;

const COLS = [
  "swap_key",
  "deposit_address",
  "deposit_memo",
  "status",
  "created_at",
  "created_day",
  "origin_asset",
  "destination_asset",
  "canonical_origin_asset",
  "canonical_destination_asset",
  "amount_in_raw",
  "amount_out_raw",
  "amount_in",
  "amount_out",
  "amount_final",
  "amount_in_usd_raw",
  "amount_out_usd_raw",
  "amount_in_usd",
  "amount_out_usd",
  "deposit_type",
  "recipient_type",
  "referral",
  "privacy_era",
  "public_swap_tx_hashes",
  "boundary_tx_hashes",
  "reconciliation_level",
  "source_label",
  "raw_object_hash",
  "fetched_at",
  "version",
] as const;

const NEW_CANON = (alias: string): string =>
  `if(${alias}.canon IS NOT NULL AND s.created_at >= ${alias}.vf AND (${alias}.vt IS NULL OR s.created_at < ${alias}.vt), ${alias}.canon, NULL)`;

const ALIAS_SUBQUERY = `(SELECT provider_asset_id AS pid, canonical_asset_id AS canon, valid_from AS vf, valid_to AS vt
                          FROM asset_registry FINAL
                         WHERE provider_id = '${ONECLICK_PROVIDER}' AND verification = 'verified')`;

export interface RederiveResult {
  partitions: number; // key ranges processed
  rowsReinserted: number;
}

/**
 * Re-derives canonical_origin/destination_asset for existing swaps with ReplacingMergeTree re-inserts: only rows whose
 * derived value differs from the stored one are re-inserted, with version + 1 (a concurrent loader insert of the same
 * original version, such as one still running pre-registry code, loses to it). Idempotent: a second run finds no
 * differing rows. No ALTER UPDATE, no DROP/TRUNCATE; one swap_key range (1/257 of the table) per statement (the shared ClickHouse has a small memory limit).
 */
export async function rederiveCanonicalAssets(
  ch: ClickHouseClient,
  log: (m: string) => void = () => {},
): Promise<RederiveResult> {
  // swap_key is the sorting key, so key ranges prune parts (days would not). Keys are not uniform (hex hashes, "0x..." and
  // other prefixes), so ranges are cut from the real 4-character prefix histogram to about CHUNK_ROWS rows each.
  const hist = await ch.query({
    query: "SELECT substring(swap_key, 1, 4) AS p, count() AS c FROM intents_swaps GROUP BY p ORDER BY p",
    format: "JSONEachRow",
  });
  const prefixes = (await hist.json()) as Array<{ p: string; c: string }>;
  const cuts: string[] = [];
  let acc = 0;
  for (const x of prefixes) {
    if (acc >= CHUNK_ROWS) {
      cuts.push(x.p);
      acc = 0;
    }
    acc += Number(x.c);
  }
  const lit = (v: string): string => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const parts = [cuts.length > 0 ? `< ${lit(cuts[0]!)}` : ">= ''"];
  if (cuts.length > 0)
    for (let i = 0; i < cuts.length; i++)
      parts.push(`>= ${lit(cuts[i]!)}` + (i + 1 < cuts.length ? ` AND swap_key < ${lit(cuts[i + 1]!)}` : ""));
  let reinserted = 0;
  for (const p of parts) {
    const select = COLS.map((c) =>
      c === "canonical_origin_asset"
        ? "nco AS canonical_origin_asset"
        : c === "canonical_destination_asset"
          ? "ncd AS canonical_destination_asset"
          : c === "version"
            ? "version + 1 AS version"
            : c,
    ).join(", ");
    const inner = `SELECT s.*, ${NEW_CANON("ao")} AS nco, ${NEW_CANON("ad")} AS ncd
        FROM (SELECT * FROM intents_swaps FINAL WHERE swap_key ${p}) AS s
        LEFT JOIN ${ALIAS_SUBQUERY} AS ao ON ao.pid = s.origin_asset
        LEFT JOIN ${ALIAS_SUBQUERY} AS ad ON ad.pid = s.destination_asset`;
    const where = `NOT (canonical_origin_asset <=> nco) OR NOT (canonical_destination_asset <=> ncd)`;
    const cnt = await ch.query({
      query: `SELECT count() AS c FROM (${inner}) WHERE ${where}`,
      format: "JSONEachRow",
      clickhouse_settings: { max_threads: 2, max_block_size: "4096" },
    });
    const n = Number(((await cnt.json()) as Array<{ c: string }>)[0]?.c ?? 0);
    if (n > 0) {
      await ch.command({
        query: `INSERT INTO intents_swaps (${COLS.join(", ")}) SELECT ${select} FROM (SELECT * FROM (${inner}) WHERE ${where})`,
        clickhouse_settings: { max_threads: 2, max_insert_threads: "1", max_block_size: "4096" },
      });
    }
    reinserted += n;
    if (n > 0) log(`swap_key ${p}: ${n} rows re-derived`);
  }
  return { partitions: parts.length, rowsReinserted: reinserted };
}

export async function mappingCounts(
  ch: ClickHouseClient,
): Promise<{ total: number; originMapped: number; destinationMapped: number }> {
  const rs = await ch.query({
    query: `SELECT count() AS total, countIf(canonical_origin_asset IS NOT NULL) AS o,
                   countIf(canonical_destination_asset IS NOT NULL) AS d FROM intents_swaps FINAL`,
    format: "JSONEachRow",
  });
  const r = ((await rs.json()) as Array<{ total: string; o: string; d: string }>)[0]!;
  return { total: Number(r.total), originMapped: Number(r.o), destinationMapped: Number(r.d) };
}
