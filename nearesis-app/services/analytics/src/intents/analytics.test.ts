import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCh, migrate, queryRows, type ClickHouseClient } from "../ch.ts";
import {
  backfillQuoteIntel,
  base58Encode,
  ensureQuoteIntelTable,
  quoteSigningMessage,
} from "../../../ingestion/src/quotes/index.ts";
import { IntentsAnalytics } from "./analytics.ts";
import { addDays } from "./sql.ts";
import { join } from "node:path";
import { SERVICE_ROOT } from "../ch.ts";

// Disposable database on the dev ClickHouse; the live database is never touched.
const DB = `a20_test_${Date.now().toString(36)}`;
let admin: ClickHouseClient;
let ch: ClickHouseClient;
let a: IntentsAnalytics;

const OFFSET = (ms: number) =>
  new Date(Date.UTC(2026, 10, 1) + ms).toISOString().replace("T", " ").replace("Z", "");
let seq = 0;
const CANON: Record<string, string> = {};
function swap(
  day: string,
  status: string,
  o: string,
  d: string,
  usd: string | null,
  era = "public",
): Record<string, unknown> {
  seq++;
  return {
    canonical_origin_asset: CANON[o] ?? null,
    canonical_destination_asset: CANON[d] ?? null,
    swap_key: `k${seq}|`,
    deposit_address: `k${seq}`,
    status,
    created_at: `${day} 12:00:00.000`,
    created_day: day,
    origin_asset: o,
    destination_asset: d,
    amount_in_raw: "1000",
    amount_out_raw: "900",
    amount_in: "1000",
    amount_out: "900",
    amount_final: status === "PROCESSING" ? 0 : 1,
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
    version: 1,
  };
}
const ETH = "nep141:eth.omft.near";
const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL = "nep141:sol.omft.near"; // not in the registry: chain comes from the documented id grammar
const NEAR = "nep141:wrap.near";
const WEIRD = "mystery:asset";
const HOT56 = "nep245:v2_1.omni.hot.tg:56_unregisteredAAAA"; // chain id 56 learned from registered hot assets
CANON[ETH] = "ETH";
CANON[BASE] = "USDC";
const HOT56_REG = "nep245:v2_1.omni.hot.tg:56_registeredBBBB";

beforeAll(async () => {
  admin = createCh();
  await admin.command({ query: `CREATE DATABASE ${DB}` });
  ch = createCh({ database: DB });
  await migrate(ch, join(SERVICE_ROOT, "..", "ingestion", "migrations-live"));
  await ensureQuoteIntelTable(ch);
  const reg = (id: string, canon: string | null, chain: string) => ({
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
    version: 1,
  });
  await ch.insert({
    table: "asset_registry",
    format: "JSONEachRow",
    values: [reg(ETH, "ETH", "eth"), reg(BASE, "USDC", "base"), reg(HOT56_REG, "BNB", "bsc")],
  });
  const rows = [
    swap("2026-11-01", "SUCCESS", ETH, BASE, "100.5"),
    swap("2026-11-01", "SUCCESS", ETH, BASE, "9.99"),
    swap("2026-11-01", "SUCCESS", ETH, BASE, null),
    swap("2026-11-02", "REFUNDED", ETH, BASE, "50"),
    swap("2026-11-02", "FAILED", ETH, BASE, null),
    swap("2026-11-01", "SUCCESS", BASE, ETH, "2000"),
    swap("2026-11-01", "SUCCESS", SOL, ETH, "15000.123456789012345678"),
    swap("2026-11-01", "SUCCESS", NEAR, WEIRD, "1", "private_settlement"),
    swap("2026-11-02", "PROCESSING", HOT56, ETH, "5"),
    swap("2026-11-01", "SUCCESS", HOT56, ETH, "100000"),
  ];
  await ch.insert({ table: "intents_swaps", format: "JSONEachRow", values: rows });
  const cov = (day: string, state: string, reason: string | null) => ({
    provider_id: "near-explorer",
    dataset: "intents_swaps",
    day,
    state,
    reason,
    version: 1,
  });
  await ch.insert({
    table: "source_coverage",
    format: "JSONEachRow",
    values: [cov("2026-11-01", "complete", null), cov("2026-11-02", "partial", "STILL_FILLING")],
  });
  // unusual-flow series: 35 days ending 2026-10-10, pair eth->sol steady then a spike on the last day, sol->eth steady. One baseline day is partial.
  const series: Array<Record<string, unknown>> = [];
  const covRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 35; i++) {
    const day = addDays("2026-09-06", i);
    covRows.push(cov(day, i === 5 ? "partial" : "complete", i === 5 ? "GAP" : null));
    const spike = i === 34 ? 80 : 20 + (i % 3);
    for (let k = 0; k < spike; k++) series.push(swap(day, "SUCCESS", ETH, SOL, "10"));
    for (let k = 0; k < 20 + ((i + 1) % 3); k++) series.push(swap(day, "SUCCESS", SOL, ETH, "10"));
  }
  await ch.insert({ table: "intents_swaps", format: "JSONEachRow", values: series });
  await ch.insert({ table: "source_coverage", format: "JSONEachRow", values: covRows });
  a = new IntentsAnalytics(ch, { database: DB, now: () => new Date("2026-11-13T00:00:00Z") });
  void OFFSET;
});

afterAll(async () => {
  await admin.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
  await ch.close();
  await admin.close();
});

const W = { from: "2026-11-01", to: "2026-11-03" };
const ok = <T>(r: { status: string; data?: unknown }): T => {
  expect(r.status).toBe("OK");
  return (r as { data: T }).data;
};

describe("intents analytics on a fixture database (exact numbers, hand-computed)", () => {
  it("summary: counts, rates, exact settled volume, unknown USD kept out of volume", async () => {
    const r = await a.summary(W);
    const d = ok<Record<string, unknown>>(r);
    expect(d).toMatchObject({
      swaps: 10,
      success: 7,
      refunded: 1,
      failed: 1,
      inFlight: 1,
      successRate: "0.777778",
      refundRate: "0.111111",
      settledVolumeUsdKnown: "117111.613456789012345678",
      settledSwapsWithUnknownUsd: 1,
      swapsWithUnresolvedChain: 1,
    });
    expect(r.provenance.metricVersion).toBe("intents-1.0.0");
  });

  it("coverage: partial day listed, day without a record is missing (never zero), era split and USD-known share", async () => {
    const c = await a.coverage(W);
    expect(c.daysInWindow).toBe(3);
    expect(c.completeDays).toBe(1);
    expect(c.incompleteDays).toEqual([{ day: "2026-11-02", state: "partial", reason: "STILL_FILLING" }]);
    expect(c.missingDays).toEqual(["2026-11-03"]);
    expect(c.swapRows).toBe(10);
    expect(c.usdUnknownRows).toBe(2);
    expect(c.usdKnownShare).toBe("0.800000");
    expect(c.eraSplit).toEqual({ public: 9, private_settlement: 1 });
    expect(c.scopeNote).toMatch(/not every NEAR Intents interaction/);
  });

  it("era filter narrows the population and the coverage", async () => {
    const d = ok<Record<string, unknown>>(await a.summary(W, "private_settlement"));
    expect(d.swaps).toBe(1);
  });

  it("status distribution by day", async () => {
    const d = ok<Array<{ day: string; status: string; swaps: number }>>(await a.statusDistribution(W, "day"));
    expect(d.find((r) => r.day === "2026-11-01" && r.status === "SUCCESS")?.swaps).toBe(7);
    expect(d.find((r) => r.day === "2026-11-02" && r.status === "REFUNDED")?.swaps).toBe(1);
  });

  it("chain resolution: registry, id grammar, learned hot.tg chain id, near contracts, unknown stays unknown", async () => {
    const f = ok<{ matrix: Array<Record<string, unknown>> }>(await a.chainFlows(W));
    const cell = (o: string, d: string) =>
      f.matrix.find((r) => r.originChain === o && r.destinationChain === d);
    expect(cell("eth", "base")).toMatchObject({
      swaps: 3,
      volumeUsdKnown: "110.49",
      swapsWithUnknownUsd: 1,
      refundRate: "0.200000",
    });
    expect(cell("base", "eth")).toMatchObject({ swaps: 1, volumeUsdKnown: "2000" });
    expect(cell("sol", "eth")).toMatchObject({ volumeUsdKnown: "15000.123456789012345678" });
    expect(cell("bsc", "eth")).toMatchObject({ swaps: 1, volumeUsdKnown: "100000" });
    expect(cell("near", "unknown")).toMatchObject({ swaps: 1, volumeUsdKnown: "1" });
  });

  it("net directional flow is exact", async () => {
    const f = ok<{ netFlow: Array<Record<string, string>> }>(await a.chainFlows(W));
    const eth = f.netFlow.find((r) => r.chain === "eth");
    expect(eth).toMatchObject({
      outflowUsdKnown: "110.49",
      inflowUsdKnown: "117000.123456789012345678",
      netInflowUsdKnown: "116889.633456789012345678",
    });
    expect(f.netFlow[0]?.chain).toBe("eth");
  });

  it("size buckets, with unknown USD in its own bucket", async () => {
    const d = ok<Array<{ bucket: string; swaps: number }>>(await a.sizeBuckets(W));
    expect(Object.fromEntries(d.map((r) => [r.bucket, r.swaps]))).toEqual({
      "<10": 2,
      "100-1k": 1,
      "1k-10k": 1,
      "10k-100k": 1,
      ">=100k": 1,
      unknown_usd: 1,
    });
    expect(d.find((r) => r.bucket === "unknown_usd")).toMatchObject({ volumeUsdKnown: null });
  });

  it("asset volume labels unmapped assets explicitly and keeps chains apart", async () => {
    const d = ok<Array<{ asset: string; chain: string; mapped: boolean; volumeUsdKnown: string }>>(
      await a.assetVolume(W, "origin", 10),
    );
    expect(d.find((r) => r.asset === "ETH")).toMatchObject({
      chain: "eth",
      mapped: true,
      volumeUsdKnown: "110.49",
    });
    expect(d.find((r) => r.asset === "unmapped:nep141:sol.omft.near")).toMatchObject({
      chain: "sol",
      mapped: false,
    });
  });

  it("refund rate by chain pair respects the minimum sample", async () => {
    expect(ok<unknown[]>(await a.refundRates(W, "chain_pair", 100))).toEqual([]);
    const d = ok<Array<Record<string, unknown>>>(await a.refundRates(W, "chain_pair", 5));
    expect(d[0]).toMatchObject({
      originChain: "eth",
      destinationChain: "base",
      terminalSwaps: 5,
      refunded: 1,
      refundRate: "0.200000",
      failedRate: "0.200000",
    });
  });

  it("refund causes: reasons from the side table; NOT_LOADED and NOT_REPORTED are distinct, never guessed", async () => {
    const before = ok<Array<Record<string, unknown>>>(await a.refundCauses(W, "reason"));
    expect(before).toMatchObject([{ reason: "NOT_LOADED", refunded: 1, share: "1.000000" }]);
    const mk = (day: string, reason: string | null, o: string, d: string) => swap(day, "REFUNDED", o, d, "1");
    const rows = [
      mk("2026-12-01", "A", ETH, BASE),
      mk("2026-12-01", "A", ETH, BASE),
      mk("2026-12-02", "B", ETH, BASE),
      mk("2026-12-09", "A", SOL, ETH),
      mk("2026-12-09", null, SOL, ETH),
    ];
    const reasons = ["INTENT_SUBMIT_FAILED", "INTENT_SUBMIT_FAILED", "NO_LIQUIDITY", "NO_LIQUIDITY", null];
    await ch.insert({ table: "intents_swaps", format: "JSONEachRow", values: rows });
    await ch.insert({
      table: "intents_swap_refunds",
      format: "JSONEachRow",
      values: rows.map((r, i) => ({
        swap_key: r.swap_key,
        status: "REFUNDED",
        created_at: r.created_at,
        created_day: r.created_day,
        refund_reason: reasons[i],
        refund_to: null,
        refund_fee_raw: null,
        refund_fee_formatted: null,
        refund_type: "ORIGIN_CHAIN",
        raw_object_hash: "0".repeat(64),
        fetched_at: `${r.created_day} 13:00:00.000`,
        version: 1,
      })),
    });
    const w2 = { from: "2026-12-01", to: "2026-12-15" };
    expect(ok<Array<Record<string, unknown>>>(await a.refundCauses(w2, "reason"))).toMatchObject([
      { reason: "INTENT_SUBMIT_FAILED", refunded: 2, share: "0.400000" },
      { reason: "NO_LIQUIDITY", refunded: 2, share: "0.400000" },
      { reason: "NOT_REPORTED", refunded: 1, share: "0.200000" },
    ]);
    const weekly = ok<Array<Record<string, unknown>>>(await a.refundCauses(w2, "week"));
    expect(weekly.filter((r) => r.period === "2026-11-30")).toMatchObject([
      { reason: "INTENT_SUBMIT_FAILED", refunded: 2, share: "0.666667" },
      { reason: "NO_LIQUIDITY", refunded: 1, share: "0.333333" },
    ]);
    const pair = ok<Array<Record<string, unknown>>>(await a.refundCauses(w2, "chain_pair"));
    expect(pair.find((r) => r.originChain === "sol")).toMatchObject({ destinationChain: "eth", refunded: 1 });
  });

  it("concentration: exact top-N share and HHI", async () => {
    const d = ok<{ hhi: string; topNShare: string; top: Array<{ key: string }> }>(
      await a.concentrationOf(W, "destination_chain", "count", 1),
    );
    expect(d.hhi).toBe("3877.5510");
    expect(d.topNShare).toBe("0.428571");
    expect(d.top[0]?.key).toBe("base");
    const v = ok<{ excludedSwapsWithUnknownUsd: number }>(
      await a.concentrationOf(W, "origin_chain", "volume", 3),
    );
    expect(v.excludedSwapsWithUnknownUsd).toBe(1);
  });

  it("chain-pair growth uses the preceding window of equal length and null growth when previous is 0", async () => {
    const d = ok<Array<{ originChain: string; newPair: boolean; swapGrowthPct: string | null }>>(
      await a.chainPairGrowth({ from: "2026-11-01", to: "2026-11-02" }, 0),
    );
    expect(d.every((r) => r.newPair && r.swapGrowthPct === null)).toBe(true);
  });

  it("unusual flows: only the spiking pair is flagged, partial days are excluded not zero-filled", async () => {
    const r = await a.unusualFlows("2026-10-10");
    const d = ok<{
      baselineDaysUsed: number;
      recentDaysUsed: number;
      excludedIncompleteDays: string[];
      flagged: Array<{ pair: string; anomalies: Array<{ day: string; direction: string }> }>;
    }>(r);
    expect(d.excludedIncompleteDays).toEqual(["2026-09-11"]);
    expect(d.baselineDaysUsed).toBe(27);
    expect(d.recentDaysUsed).toBe(7);
    expect(d.flagged.map((f) => f.pair)).toEqual(["eth->sol"]);
    expect(d.flagged[0]?.anomalies).toMatchObject([{ day: "2026-10-10", direction: "up" }]);
  });

  it("window validation rejects bad input", async () => {
    await expect(a.summary({ from: "2026-11-05", to: "2026-11-01" })).rejects.toThrow();
    await expect(a.summary({ from: "x'; DROP TABLE", to: "2026-11-01" })).rejects.toThrow();
  });
});

describe("capabilities the source cannot support return typed CANNOT_COMPUTE", () => {
  it("solver metrics name the missing identity and linkage and never compute", async () => {
    const r = await a.solverMetrics(W);
    expect(r.status).toBe("CANNOT_COMPUTE");
    expect(r.missing.join(" ")).toMatch(/solver_id/);
    expect(r.missing.join(" ")).toMatch(/quote_id or correlationId/);
    expect(r.explanation).toMatch(/time or pair similarity/);
  });
  it("settlement duration names the missing timestamp", async () => {
    const r = await a.settlementDuration(W);
    expect(r.status).toBe("CANNOT_COMPUTE");
    expect(r.missing[0]).toMatch(/settlement_completed_at/);
  });
  it("measured settlement duration covers only pilot days and falls back to CANNOT_COMPUTE elsewhere", async () => {
    const none = await a.settlementDurationMeasured(W);
    expect(none.status).toBe("CANNOT_COMPUTE");
    const row = (k: string, ms: number | null, complete: number) => ({
      swap_key: k,
      window_id: "t",
      status: "SUCCESS",
      created_at: "2026-11-01 00:00:00.000",
      created_day: "2026-11-01",
      origin_chain: "eth",
      n_hashes: 2,
      n_found: complete ? 2 : 1,
      complete,
      settlement_ms: ms,
      source_label: "LIVE",
      raw_object_hash: "h",
      fetched_at: "2026-11-01 00:00:00.000",
      version: 1,
    });
    await ch.insert({
      table: "intents_settlement_durations",
      format: "JSONEachRow",
      values: [row("a", 1000, 1), row("b", 3000, 1), row("c", null, 0)],
    });
    const r = await a.settlementDurationMeasured(W);
    expect(r.status).toBe("OK");
    if (r.status === "OK") {
      expect(r.data[0]).toMatchObject({ originChain: "eth", swaps: 3, measured: 2, hashesMissing: 1 });
      expect(r.caveats.join(" ")).toMatch(/2026-11-01\.\.2026-11-01/);
    }
    expect((await a.settlementDurationMeasured({ from: "2026-12-01", to: "2026-12-02" })).status).toBe(
      "CANNOT_COMPUTE",
    );
  });
  it("field inventory states what is and is not provided", () => {
    const d = a.fieldInventory().data;
    expect(d.find((f) => f.concept.startsWith("solver"))?.status).toBe("not_provided");
    expect(d.find((f) => f.concept === "refund state")?.status).toBe("identified");
    expect(d.find((f) => f.concept === "origin chain")?.status).toBe("derived");
  });
});

describe("quote intelligence from archived payloads", () => {
  it("records availability, categories, rate-limit, signatures; indicative alternative to settlement duration", async () => {
    const kp = generateKeyPairSync("ed25519");
    const body = {
      correlationId: "c",
      timestamp: "2026-11-12T08:00:48.509Z",
      quoteRequest: {
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: ETH,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: BASE,
        amount: "1000",
        refundTo: "r",
        refundType: "ORIGIN_CHAIN",
        recipient: "r",
        recipientType: "DESTINATION_CHAIN",
        deadline: "2026-11-12T08:10:00Z",
      },
      quote: {
        amountIn: "1000",
        amountInFormatted: "0.001",
        amountInUsd: "10",
        minAmountIn: "1000",
        amountOut: "9900000",
        amountOutFormatted: "9.9",
        amountOutUsd: "9.9",
        minAmountOut: "9800000",
        timeEstimate: 40,
      },
    } as Record<string, unknown>;
    const pub = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    body.signature = `ed25519:${base58Encode(sign(null, Buffer.from(quoteSigningMessage(body), "utf8"), kp.privateKey))}`;
    const payload = new TextEncoder().encode(JSON.stringify(body));
    const h = (c: string) => c.repeat(64);
    const attempt = (
      no: number,
      cls: string | null,
      status: number | null,
      hash: string | null,
      extra: Record<string, unknown> = {},
    ) => ({
      route_id: "ETH.eth>USDC.base",
      origin_asset: ETH,
      destination_asset: BASE,
      origin_chain: "eth",
      destination_chain: "base",
      notional_usd: 10,
      amount_base_units: cls === null ? "n/a:10" : "1000",
      privacy_mode: "public",
      scheduled_bucket_utc: "2026-11-12 08:00:00.000",
      attempt_no: no,
      slot: cls === null ? "unavailable" : "observed",
      class: cls,
      reason: cls ?? "NO_REFUND_ADDRESS_CONFIG:near",
      http_status: status,
      latency_ms: 100 * no,
      fetched_at: "2026-11-12 08:00:48.416",
      raw_object_hash: hash,
      dry: 1,
      version: 1,
      ...extra,
    });
    await ch.insert({
      table: "quote_attempts",
      format: "JSONEachRow",
      values: [
        attempt(1, "OK", 201, h("a"), { time_estimate_s: 40 }),
        attempt(2, "NO_QUOTE", 400, null),
        attempt(3, "TIMEOUT", null, null),
        attempt(4, "INVALID_OUTPUT", 429, null),
        attempt(5, null, null, null),
      ],
    });
    // the pinned key does not match this test key, so a payload signed by the test key must NOT verify: signature_unverifiable/invalid is truthful.
    const res = await backfillQuoteIntel(ch, async (hash) => (hash === h("a") ? payload : null));
    expect(res.written).toBe(5);
    expect(res.signature.invalid).toBe(1);
    void pub;
    const q = await a.quoteIntelligence({ from: "2026-11-12", to: "2026-11-12" });
    const d = ok<Array<Record<string, unknown>>>(q);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      routeId: "ETH.eth>USDC.base",
      slots: 5,
      attempts: 4,
      notAttempted: 1,
      available: 1,
      noRoute: 1,
      errors: 2,
      rateLimited: 1,
      availabilityRate: "0.250000",
      latestQuotedEffectiveRate: "9900",
      providerVersion: "1click-openapi-0.1.10",
    });
    expect(d[0]?.errorCategories).toEqual({ no_route: 1, timeout: 1, rate_limited: 1, not_attempted: 1 });
    const rows = await queryRows<{ k: string }>(
      ch,
      `SELECT error_category AS k FROM quote_intel FINAL WHERE attempt_no IN (2,3) ORDER BY attempt_no`,
    );
    expect(rows.map((r) => r.k)).toEqual(["no_route", "timeout"]);
    const s = await a.settlementDuration({ from: "2026-11-12", to: "2026-11-12" });
    expect(s.alternative?.label).toMatch(/INDICATIVE/);
    expect(JSON.stringify(s.alternative?.data)).toContain('"originChain":"eth"');
    // backfill is idempotent
    expect((await backfillQuoteIntel(ch, async () => null)).written).toBe(0);
  });
});
