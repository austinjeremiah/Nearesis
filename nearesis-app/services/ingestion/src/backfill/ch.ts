import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IngestionError } from "../errors.ts";
import type { IntentsSwapRow, PriceCandleRow } from "../normalized/types.ts";
import type { BqRow } from "./bq-runner.ts";
import { RECEIVER_THRESHOLD } from "./plan.ts";

export const LIVE_DATABASE = "nearesis_live";
export const LIVE_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations-live",
);
export type Row = Record<string, unknown>;

export function createLiveCh(database: string = LIVE_DATABASE): ClickHouseClient {
  // The fixture database `nearesis` is never a valid target of this module.
  if (database === "nearesis")
    throw new IngestionError("INVALID_INPUT", false, {
      reason: "backfill must never write to the fixture database",
    });
  return createClient({
    url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
    username: process.env.NEARESIS_CH_USER ?? "nearesis",
    password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
    database,
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
}

export async function ensureDatabase(name: string = LIVE_DATABASE): Promise<void> {
  if (!/^nearesis_(live|t_a13_[a-z0-9]+)$/.test(name))
    throw new IngestionError("INVALID_INPUT", false, { reason: "unexpected database name" });
  const admin = createClient({
    url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
    username: process.env.NEARESIS_CH_USER ?? "nearesis",
    password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
    database: "default",
  });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${name}` });
  } finally {
    await admin.close();
  }
}

const statementsOf = (sql: string): string[] =>
  sql
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);

/** Applies migrations-live/NNN_*.sql in order; tracked in `<database>.schema_migrations`. Idempotent. */
export async function migrateLive(
  ch: ClickHouseClient,
  dir: string = LIVE_MIGRATIONS_DIR,
): Promise<string[]> {
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations (version String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = MergeTree ORDER BY version`,
  });
  const rs = await ch.query({ query: "SELECT version FROM schema_migrations", format: "JSONEachRow" });
  const done = new Set(((await rs.json()) as Array<{ version: string }>).map((r) => r.version));
  const applied: string[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => /^\d+_.*\.sql$/.test(x))
    .sort()) {
    if (done.has(f)) continue;
    for (const stmt of statementsOf(readFileSync(join(dir, f), "utf8"))) await ch.command({ query: stmt });
    await ch.insert({ table: "schema_migrations", values: [{ version: f }], format: "JSONEachRow" });
    applied.push(f);
  }
  return applied;
}

/** Label enforcement: refuses any row not labelled LIVE. Every insert in this module goes through it. */
export function assertLive<T extends { source_label?: unknown }>(table: string, rows: T[]): T[] {
  for (const r of rows)
    if (r.source_label !== "LIVE")
      throw new IngestionError("INVALID_INPUT", false, { reason: "row is not labelled LIVE", table });
  return rows;
}

export async function insertLive(ch: ClickHouseClient, table: string, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  assertLive(table, rows);
  const BATCH = 20_000;
  for (let i = 0; i < rows.length; i += BATCH)
    await ch.insert({ table, values: rows.slice(i, i + BATCH), format: "JSONEachRow" });
  return rows.length;
}

/** BigQuery DATE / INT64 values arrive as {value} wrappers, numbers or strings. Returns an exact string, never a float round trip. */
export function bqScalar(v: unknown, field: string): string {
  const raw =
    typeof v === "object" && v !== null && "value" in v ? (v as { value: unknown }).value : (v as unknown);
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw))
      throw new IngestionError("INVALID_INPUT", false, { reason: "unsafe integer", field });
    return String(raw);
  }
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new IngestionError("INVALID_INPUT", false, { reason: "missing value", field });
}
const uint = (v: unknown, field: string): string => {
  const s = bqScalar(v, field);
  if (!/^\d+$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "not an unsigned integer", field });
  return s;
};
const dayOf = (v: unknown, field: string): string => {
  const s = bqScalar(v, field).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "not a date", field });
  return s;
};

export interface Provenance {
  rawObjectHash: string;
  fetchedAtUTC: string;
}
const prov = (p: Provenance) => ({
  source_label: "LIVE",
  raw_object_hash: p.rawObjectHash,
  fetched_at: p.fetchedAtUTC,
  version: Date.parse(p.fetchedAtUTC),
});

export function transactionRows(rows: BqRow[], p: Provenance): Row[] {
  return rows.map((r) => ({
    block_date: dayOf(r.block_date, "block_date"),
    tx_count: uint(r.tx_count, "tx_count"),
    distinct_signer_proxy: uint(r.distinct_signers, "distinct_signers"),
    ...prov(p),
  }));
}

/** Splits receiver rows into named receivers and the per-day below-threshold remainder (NULL receiver). */
export function receiverRows(
  rows: BqRow[],
  p: Provenance,
  threshold: number = RECEIVER_THRESHOLD,
): { named: Row[]; below: Row[] } {
  const named: Row[] = [];
  const below: Row[] = [];
  for (const r of rows) {
    const block_date = dayOf(r.block_date, "block_date");
    if (r.receiver_out === null || r.receiver_out === undefined) {
      below.push({
        block_date,
        receiver_count: uint(r.receiver_count, "receiver_count"),
        interactions: uint(r.interactions, "interactions"),
        threshold,
        ...prov(p),
      });
    } else {
      named.push({
        block_date,
        receiver_account_id: String(r.receiver_out),
        project: null, // registry join happens in ClickHouse; null unless a mapping is verified
        taxonomy: "uncategorized",
        segment_state: "uncategorized",
        interactions: uint(r.interactions, "interactions"),
        ...prov(p),
      });
    }
  }
  return { named, below };
}

export function swapRows(rows: IntentsSwapRow[], fetchedAtUTC: string): Row[] {
  return rows.map((s) => ({
    swap_key: s.swapKey,
    deposit_address: s.depositAddress,
    deposit_memo: s.depositMemo,
    status: s.status,
    created_at: s.createdAtUTC,
    created_day: s.createdDay,
    origin_asset: s.originAsset,
    destination_asset: s.destinationAsset,
    canonical_origin_asset: s.canonicalOriginAsset,
    canonical_destination_asset: s.canonicalDestinationAsset,
    amount_in_raw: s.amountIn,
    amount_out_raw: s.amountOut,
    amount_in: s.amountIn,
    amount_out: s.amountOut,
    amount_final: s.amountFinal ? 1 : 0,
    amount_in_usd_raw: s.amountInUsd,
    amount_out_usd_raw: s.amountOutUsd,
    amount_in_usd: s.amountInUsd,
    amount_out_usd: s.amountOutUsd,
    deposit_type: s.depositType,
    recipient_type: s.recipientType,
    referral: s.referral,
    privacy_era: s.privacyEra,
    public_swap_tx_hashes: s.publicSwapTxHashes,
    boundary_tx_hashes: s.boundaryTxHashes,
    reconciliation_level: s.reconciliationLevel,
    source_label: "LIVE",
    raw_object_hash: s.rawObjectHash,
    fetched_at: fetchedAtUTC,
    version: s.version,
  }));
}

export function priceRows(rows: PriceCandleRow[], basis: string): Row[] {
  return rows.map((c) => ({
    provider: c.provider,
    coin_id: c.coinId,
    symbol: c.symbol,
    quote_currency: c.quoteCurrency,
    interval: c.interval,
    bucket_start: c.bucketStartUTC,
    day: c.bucketStartUTC.slice(0, 10),
    open_raw: c.open,
    high_raw: c.high,
    low_raw: c.low,
    close_raw: c.close,
    volume_raw: c.volume,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    provider_timestamp: c.providerTimestampUTC,
    fetched_at: c.fetchedAtUTC,
    update_vintage: c.updateVintage,
    basis,
    source_label: "LIVE",
    raw_object_hash: c.rawObjectHash,
    version: c.version,
  }));
}

export interface CoverageInput {
  provider_id: string;
  dataset: string;
  day: string;
  state: "complete" | "partial" | "unavailable";
  reason: string | null;
  version: number;
}
export const coverageRows = (rows: CoverageInput[]): Row[] =>
  rows.map((r) => ({ ...r, source_label: "LIVE" }));
