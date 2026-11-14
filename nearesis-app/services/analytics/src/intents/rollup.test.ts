import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCh, migrate, queryRows, SERVICE_ROOT, type ClickHouseClient } from "../ch.ts";
import { IntentsAnalytics } from "./analytics.ts";
import { addDays } from "./sql.ts";

// Disposable database on the dev ClickHouse; the live database is never touched.
const DB = `a37_rollup_${Date.now().toString(36)}`;
let admin: ClickHouseClient;
let ch: ClickHouseClient;
let raw: IntentsAnalytics;
let fast: IntentsAnalytics;

let seq = 0;
const ASSETS: Array<[string, string | null, string]> = [
  ["nep141:eth.omft.near", "ETH", "eth"],
  ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "USDC", "base"],
  ["nep141:sol.omft.near", null, ""],
  ["nep141:wrap.near", null, ""],
  ["mystery:asset", null, ""],
];
const CANON = new Map(ASSETS.map(([id, c]) => [id, c]));
const STATUSES = ["SUCCESS", "SUCCESS", "SUCCESS", "REFUNDED", "FAILED", "PROCESSING"];
function swap(
  day: string,
  status: string,
  o: string,
  d: string,
  usd: string | null,
  era: string,
  version = 1,
) {
  seq++;
  return {
    canonical_origin_asset: CANON.get(o) ?? null,
    canonical_destination_asset: CANON.get(d) ?? null,
    swap_key: `r${seq}|`,
    deposit_address: `r${seq}`,
    status,
    created_at: `${day} 12:00:00.000`,
    created_day: day,
    origin_asset: o,
    destination_asset: d,
    amount_in_raw: "1000",
    amount_out_raw: "900",
    amount_in: "1000",
    amount_out: "900",
    amount_final: 1,
    amount_in_usd: usd,
    amount_out_usd: usd,
    deposit_type: "ORIGIN_CHAIN",
    recipient_type: "DESTINATION_CHAIN",
    privacy_era: era,
    public_swap_tx_hashes: [],
    boundary_tx_hashes: [],
    reconciliation_level: "exact_public",
    raw_object_hash: "0".repeat(64),
    fetched_at: `${day} 13:00:00.000`,
    version,
  };
}
const reg = (id: string, canon: string | null, chain: string, version = 1) => ({
  provider_id: "intents-1click",
  provider_asset_id: id,
  canonical_asset_id: canon,
  verification: canon ? "verified" : "unverified",
  symbol_observed: canon ?? "?",
  blockchain: chain,
  valid_from: "2026-01-01 00:00:00.000",
  evidence_url: "x",
  source_raw_object_hash: "0".repeat(64),
  fetched_at: "2026-01-01 00:00:00.000",
  version,
});
const refund = (s: Record<string, unknown>, reason: string | null) => ({
  swap_key: s.swap_key,
  status: "REFUNDED",
  created_at: s.created_at,
  created_day: s.created_day,
  refund_reason: reason,
  refund_type: "ORIGIN_CHAIN",
  raw_object_hash: "0".repeat(64),
  fetched_at: `${s.created_day} 14:00:00.000`,
  version: 1,
});

const W = { from: "2026-10-01", to: "2026-10-28" };

beforeAll(async () => {
  admin = createCh();
  await admin.command({ query: `CREATE DATABASE ${DB}` });
  ch = createCh({ database: DB });
  await migrate(ch, join(SERVICE_ROOT, "..", "ingestion", "migrations-live"));
  await ch.insert({
    table: "asset_registry",
    format: "JSONEachRow",
    values: ASSETS.filter(([, c]) => c).map(([id, c, chain]) => reg(id, c, chain)),
  });
  const rows: Array<Record<string, unknown>> = [];
  const refunds: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 28; i++) {
    const day = addDays("2026-10-01", i);
    for (let k = 0; k < 24; k++) {
      const o = ASSETS[(i + k) % ASSETS.length]![0];
      const d = ASSETS[(i * 3 + k * 2 + 1) % ASSETS.length]![0];
      const status = STATUSES[(i + k * 5) % STATUSES.length]!;
      const usd = k % 7 === 3 ? null : `${(k + 1) * 13}.${(i * 37 + k) % 1000}`;
      const era = (i + k) % 11 === 0 ? "private_settlement" : "public";
      const s = swap(day, status, o, d, usd, era);
      rows.push(s);
      if (status === "REFUNDED" && k % 2 === 0)
        refunds.push(refund(s, k % 4 === 0 ? "INTENT_EXPIRED" : null));
    }
  }
  await ch.insert({ table: "intents_swaps", format: "JSONEachRow", values: rows });
  await ch.insert({ table: "intents_swap_refunds", format: "JSONEachRow", values: refunds });
  // an advancing clock: the coverage cache (30 s) must not hide the warehouse changes the tests make
  let t = Date.parse("2026-11-13T00:00:00Z");
  const now = () => new Date((t += 60_000));
  raw = new IntentsAnalytics(ch, { database: DB, now, rollup: false });
  // ttl 0: every call re-verifies, so the tests can change the warehouse between calls
  fast = new IntentsAnalytics(ch, { database: DB, now, rollup: { verifyTtlMs: 0, maxInlineDays: 100 } });
}, 60_000);

afterAll(async () => {
  await admin.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
  await ch.close();
  await admin.close();
});

/** Everything a consumer reads except the timestamp and the method note that names the serving path. */
const body = (r: unknown) => {
  const x = JSON.parse(JSON.stringify(r)) as { provenance?: Record<string, unknown> };
  if (x.provenance) delete x.provenance.computedAt;
  return sortTies(x);
};
/**
 * The raw queries order groups only by the sort key (ties come back in whatever order the scan produced them), so arrays of rows
 * are compared as sets: every value, count and group must be equal; only the order inside a tie may differ.
 */
function sortTies(v: unknown): unknown {
  if (Array.isArray(v)) {
    const xs = v.map(sortTies);
    return xs.every((e) => e && typeof e === "object")
      ? xs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : xs;
  }
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, sortTies(e)]));
  return v;
}
const same = async <T>(f: (a: IntentsAnalytics) => Promise<T>) => {
  const a = body(await f(raw));
  const b = body(await f(fast));
  expect(b).toEqual(a);
  return a;
};

describe("rollup == raw (exact equality of every analysis the rollup serves)", () => {
  it("is actually served from the rollup", async () => {
    await fast.summary(W);
    expect(fast.rollup!.stats.served).toBeGreaterThan(0);
    const n = await queryRows<{ c: string }>(ch, `SELECT count() AS c FROM ${DB}.intents_swap_rollup`);
    expect(Number(n[0]!.c)).toBeGreaterThan(0);
  });
  it("summary (all eras and per era) and coverage", async () => {
    await same((a) => a.summary(W));
    await same((a) => a.summary(W, "private_settlement"));
    await same((a) => a.summary({ from: "2026-10-05", to: "2026-10-05" }));
    await same((a) => a.summary({ from: "2026-12-01", to: "2026-12-05" })); // no data at all
    expect(body(await fast.coverage(W))).toEqual(body(await raw.coverage(W)));
  });
  it("status distribution, none and by day", async () => {
    await same((a) => a.statusDistribution(W, "none"));
    await same((a) => a.statusDistribution(W, "day"));
  });
  it("trend at day, week and month grain", async () => {
    for (const g of ["day", "week", "month"] as const) await same((a) => a.trend(W, g));
  });
  it("chain flows, matrix and net", async () => {
    await same((a) => a.chainFlows(W));
  });
  it("refund rates by chain pair and asset pair, refund causes by reason, week, day and chain pair", async () => {
    await same((a) => a.refundRates(W, "chain_pair", 1, 50));
    await same((a) => a.refundRates(W, "asset_pair", 1, 50));
    for (const by of ["reason", "week", "day", "chain_pair"] as const)
      await same((a) => a.refundCauses(W, by));
  });
  it("concentration over every dimension and both measures", async () => {
    for (const dim of [
      "origin_asset",
      "destination_asset",
      "origin_chain",
      "destination_chain",
      "chain_pair",
    ] as const)
      for (const m of ["volume", "count"] as const) await same((a) => a.concentrationOf(W, dim, m, 5));
  });
  it("asset volume (both sides) and asset pairs", async () => {
    await same((a) => a.assetVolume(W, "origin", 10));
    await same((a) => a.assetVolume(W, "destination", 10));
    await same((a) => a.assetPairs(W, 10));
  });
});

describe("the rollup follows the warehouse (never serves a stale day)", () => {
  const D = "2026-10-10";
  const win = { from: "2026-10-08", to: "2026-10-12" };
  it("a new swap, a new version of a swap (status change) and a registry change are all seen", async () => {
    await same((a) => a.statusDistribution(win, "day")); // builds the rollup of the window
    const before = fast.rollup!.stats.rebuiltDays;
    await ch.insert({
      table: "intents_swaps",
      format: "JSONEachRow",
      values: [swap(D, "SUCCESS", "nep141:eth.omft.near", "nep141:sol.omft.near", "123456.5", "public", 5)],
    });
    await same((a) => a.summary(win));
    await same((a) => a.chainFlows(win));
    expect(fast.rollup!.stats.rebuiltDays).toBeGreaterThan(before);

    // a swap changes status: same key, newer version
    const [victim] = await queryRows<Record<string, unknown>>(
      ch,
      `SELECT * FROM ${DB}.intents_swaps FINAL WHERE created_day = '${D}' AND status = 'SUCCESS' LIMIT 1`,
    );
    await ch.insert({
      table: "intents_swaps",
      format: "JSONEachRow",
      values: [{ ...victim, status: "REFUNDED", version: 99, amount_in_usd: victim!.amount_in_usd }],
    });
    await same((a) => a.statusDistribution(win, "day"));
    await same((a) => a.refundCauses(win, "day"));

    // a refund reason loads for an already built day
    await ch.insert({
      table: "intents_swap_refunds",
      format: "JSONEachRow",
      values: [refund(victim as Record<string, unknown>, "LATE_REASON")],
    });
    const causes = await same((a) => a.refundCauses(win, "reason"));
    expect(JSON.stringify(causes)).toContain("LATE_REASON");

    // the registry learns a chain for an asset: every day's chain resolution changes
    await ch.insert({
      table: "asset_registry",
      format: "JSONEachRow",
      values: [reg("nep141:sol.omft.near", null, "solana", 7)],
    });
    const flows = await same((a) => a.chainFlows(win));
    expect(JSON.stringify(flows)).toContain("solana");
  });
  it("falls back to the raw path (same answer) when the rollup is disabled by the environment", async () => {
    const old = process.env.NEARESIS_INTENTS_ROLLUP;
    process.env.NEARESIS_INTENTS_ROLLUP = "0";
    try {
      const off = new IntentsAnalytics(ch, { database: DB, now: () => new Date("2026-11-14T00:00:00Z") });
      expect(off.rollup).toBeNull();
      expect(body(await off.summary(W))).toEqual(body(await raw.summary(W)));
    } finally {
      if (old === undefined) delete process.env.NEARESIS_INTENTS_ROLLUP;
      else process.env.NEARESIS_INTENTS_ROLLUP = old;
    }
  });
});
