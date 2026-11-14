/**
 * Deterministic fixture generator. `pnpm --filter @nearesis/test-fixtures generate`.
 * All data is SYNTHETIC (values invented) in the providers' documented response formats; labels say so.
 * Snapshot manifests carry expectedNormalizedDigest, produced by running the ingestion replay on the written files.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as prettier from "prettier";
import { addDays, chunk, minutesBefore, mkTx } from "./builders.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

type FileSpec = string | object;
const staged = new Map<string, Map<string, string>>();
const meta = new Map<
  string,
  { label: "SYNTHETIC" | "RECORDED"; description: string; extra?: Record<string, unknown> }
>();

function fx(
  id: string,
  label: "SYNTHETIC" | "RECORDED",
  description: string,
  files: Record<string, FileSpec>,
  extra?: Record<string, unknown>,
): void {
  const m = new Map<string, string>();
  for (const [p, c] of Object.entries(files))
    m.set(p, typeof c === "string" ? c : JSON.stringify(c, null, 2));
  staged.set(id, m);
  meta.set(id, { label, description, ...(extra ? { extra } : {}) });
}

const T0 = "2026-10-20T12:00:00.000Z";

// ---------------------------------------------------------------- explorer
const statusCycle = ["SUCCESS", "SUCCESS", "REFUNDED", "SUCCESS", "FAILED", "SUCCESS", "PROCESSING"];
const txs = (from: number, to: number, base = T0, step = 17): Record<string, unknown>[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) =>
    mkTx({
      n,
      createdAt: minutesBefore(base, (n - from) * step),
      status: statusCycle[n % statusCycle.length],
    }),
  );

const pages3 = chunk(txs(1, 13), 5);
fx(
  "fx.explorer.pages-3",
  "SYNTHETIC",
  "Three Explorer /transactions pages (5,5,3 items; 13 unique stable IDs). Fields per the OpenAPI spec of 2026-11-10.",
  {
    "page-1.json": pages3[0]!,
    "page-2.json": pages3[1]!,
    "page-3.json": pages3[2]!,
    "pages.json": { pageSize: 5, pages: ["page-1.json", "page-2.json", "page-3.json"], uniqueIds: 13 },
  },
);

const pages5 = chunk(txs(101, 125, "2026-10-21T12:00:00.000Z"), 5);
fx(
  "fx.explorer.auth-expiry",
  "SYNTHETIC",
  "Five full Explorer pages (25 unique IDs). Script: pages 1-2 return 200; from page 3 the server answers 401 (variant: 403) until restored.",
  {
    ...Object.fromEntries(pages5.map((p, i) => [`page-${i + 1}.json`, p])),
    "pages.json": { pageSize: 5, pages: pages5.map((_, i) => `page-${i + 1}.json`), uniqueIds: 25 },
    "script.json": {
      failFromPage: 3,
      statuses: [401, 403],
      errorBody: { status: 401, error: { code: "UNAUTHORIZED", message: "invalid or expired token" } },
    },
  },
);

const goodPage = txs(201, 203);
const goodBytes = JSON.stringify(goodPage, null, 2);
fx(
  "fx.explorer.bad-body",
  "SYNTHETIC",
  "Malformed Explorer bodies: invalid JSON, schema-invalid item, and a body whose supplied sha256 does not match.",
  {
    "good-page.json": goodBytes,
    "bad-json.txt": '[{"originAsset": "nep141:eth.omft.near", "depositAddress": ',
    "bad-schema.json": [{ ...(goodPage[0] as object), amountIn: "not-a-number" }],
    "checksum-mismatch.json": goodBytes,
    "checksum-mismatch.sha256": sha("different bytes than the body"),
    "checksum-ok.sha256": sha(goodBytes),
  },
);

const priv = [
  ...Array.from({ length: 3 }, (_, i) =>
    mkTx({ n: 301 + i, createdAt: minutesBefore("2026-10-26T20:00:00.000Z", i * 30) }),
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    mkTx({
      n: 304 + i,
      createdAt: minutesBefore("2026-10-28T10:00:00.000Z", i * 30),
      depositType: "CONFIDENTIAL_INTENTS",
      recipientType: "CONFIDENTIAL_INTENTS",
      nearTxHashes: [`shieldboundary${304 + i}synthetic`],
    }),
  ),
].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
fx(
  "fx.explorer.private-era",
  "SYNTHETIC",
  "Three public-era swaps (2026-10-26) and three private-settlement-era swaps (2026-10-27+, nearTxHashes are boundary hashes).",
  {
    "page-1.json": priv,
    "pages.json": { pageSize: 10, pages: ["page-1.json"] },
  },
);

// ---------------------------------------------------------------- 1click
const tokens = [
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.21,
    priceUpdatedAt: "2026-11-10T11:00:00.000Z",
    contractAddress: "wrap.near",
    coingeckoId: "near",
  },
  {
    assetId: "nep141:eth.omft.near",
    decimals: 18,
    blockchain: "eth",
    symbol: "ETH",
    price: 3100.5,
    priceUpdatedAt: "2026-11-10T11:00:00.000Z",
    contractAddress: null,
    coingeckoId: "ethereum",
  },
  {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    decimals: 6,
    blockchain: "eth",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-11-10T11:00:00.000Z",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    coingeckoId: "usd-coin",
  },
  {
    assetId: "nep141:btc.omft.near",
    decimals: 8,
    blockchain: "btc",
    symbol: "BTC",
    price: 98000,
    priceUpdatedAt: "2026-11-10T11:00:00.000Z",
    contractAddress: null,
    coingeckoId: "bitcoin",
  },
  {
    assetId: "nep141:bsc.omft.near",
    decimals: 18,
    blockchain: "bsc",
    symbol: "BNB",
    price: 640,
    priceUpdatedAt: "2026-11-10T11:00:00.000Z",
    contractAddress: null,
    coingeckoId: "binancecoin",
  },
  {
    assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    decimals: 18,
    blockchain: "bsc",
    symbol: "BNB",
    price: 640,
    priceUpdatedAt: "2026-11-08T11:00:00.000Z",
    contractAddress: null,
    coingeckoId: "binancecoin",
  },
];
fx(
  "fx.oneclick.tokens",
  "SYNTHETIC",
  "1Click GET /v0/tokens response (TokenResponse[]) incl. 24/18/8/6-decimal tokens and a legacy HOT BNB id.",
  { "tokens.json": tokens },
);

const quote = (amountIn: string, amountInFmt: string, amountOut: string, amountOutFmt: string): object => ({
  correlationId: "corr-synthetic-0001",
  timestamp: "2026-11-10T11:30:00.000Z",
  signature: "synthetic-signature",
  quoteRequest: { dry: true, swapType: "EXACT_INPUT" },
  quote: {
    amountIn,
    amountInFormatted: amountInFmt,
    amountInUsd: "3100.50",
    minAmountIn: amountIn,
    amountOut,
    amountOutFormatted: amountOutFmt,
    amountOutUsd: "3098.00",
    minAmountOut: amountOut,
    timeEstimate: 35,
  },
});
const B = (scheduled: string, no = 1) => ({ scheduledBucketUTC: scheduled, attemptNo: no });
const ETH = "nep141:eth.omft.near";
const USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const mkAttempt = (
  routeId: string,
  amt: string,
  mode: "public" | "basic" | "advanced",
  bucket: string,
  no: number,
  fetched: string,
  outcome: string,
  extra: Record<string, unknown> = {},
) => ({
  routeId,
  originAsset: ETH,
  destinationAsset: USDC,
  amountBaseUnits: amt,
  privacyMode: mode,
  ...B(bucket, no),
  fetchedAtUTC: fetched,
  outcome,
  ...extra,
});
const attemptsPlan: Array<Record<string, unknown> & { file?: string }> = [
  mkAttempt(
    "eth-usdc",
    "1000000000000000000",
    "public",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:01.000Z",
    "response",
    { status: 200, file: "quote-ok.json", benchmarkOutFormatted: "3101.00" },
  ),
  mkAttempt(
    "eth-usdc",
    "1000000000000000000",
    "basic",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:03.000Z",
    "response",
    { status: 400, file: "quote-no-liquidity.json" },
  ),
  mkAttempt(
    "eth-usdc",
    "1000000000000000000",
    "advanced",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:05.000Z",
    "network_error",
  ),
  mkAttempt(
    "eth-usdc",
    "10000000000000000000",
    "public",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:07.000Z",
    "timeout",
  ),
  mkAttempt(
    "eth-usdc",
    "10000000000000000000",
    "basic",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:09.000Z",
    "response",
    { status: 200, file: "quote-invalid-schema.json" },
  ),
  mkAttempt(
    "eth-usdc",
    "10000000000000000000",
    "advanced",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:11.000Z",
    "response",
    { status: 200, file: "quote-zero-out.json" },
  ),
  mkAttempt(
    "eth-usdc",
    "100000000000000000000",
    "public",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:13.000Z",
    "response",
    { status: 200, file: "quote-bad-scale.json" },
  ),
  mkAttempt(
    "eth-usdc",
    "100000000000000000000",
    "basic",
    "2026-11-10T11:00:00.000Z",
    1,
    "2026-11-10T11:00:15.000Z",
    "not_attempted",
  ),
];
fx(
  "fx.oneclick.quote-dry",
  "SYNTHETIC",
  "1Click dry POST /v0/quote cases: one of each class (OK, NO_QUOTE, NETWORK_ERROR, TIMEOUT, INVALID_OUTPUT x3 reasons) plus a never-attempted grid slot.",
  {
    "quote-ok.json": quote("1000000000000000000", "1", "3098000000", "3098"),
    "quote-no-liquidity.json": { message: "No route found: insufficient liquidity for this pair" },
    "quote-invalid-schema.json": {
      correlationId: "corr-synthetic-0002",
      quote: { amountIn: "10000000000000000000" },
    },
    "quote-zero-out.json": quote("10000000000000000000", "10", "0", "0"),
    "quote-bad-scale.json": quote(
      "100000000000000000000",
      "100",
      "309800000000",
      "3098.123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890",
    ),
    "plan.json": {
      attempts: attemptsPlan,
      expectedClasses: [
        "OK",
        "NO_QUOTE",
        "NETWORK_ERROR",
        "TIMEOUT",
        "INVALID_OUTPUT",
        "INVALID_OUTPUT",
        "INVALID_OUTPUT",
        "unavailable",
      ],
    },
  },
);

// ---------------------------------------------------------------- price
const wStart = "2026-10-10";
const wEnd = "2026-11-08";
const dayList = Array.from({ length: 30 }, (_, i) => addDays(wStart, i));
const closeOf = (i: number): string =>
  i === 3 ? "4.123456789012345678" : `${(3 + (i % 7) * 0.1).toFixed(2)}`;
const candle = (day: string, i: number, bump = ""): string => {
  const ts = Date.parse(`${day}T00:00:00Z`);
  const c = bump || closeOf(i);
  return `[${ts}, ${(3 + (i % 5) * 0.1).toFixed(2)}, ${(4.5 + (i % 3) * 0.1).toFixed(2)}, ${(2.9 + (i % 4) * 0.1).toFixed(2)}, ${c}]`;
};
const v1 = [
  ...dayList.filter((d) => d !== "2026-10-15").map((d) => candle(d, dayList.indexOf(d))),
  candle("2026-11-09", 31),
];
const revisedIdx = dayList.indexOf("2026-10-20");
const v2 = ["2026-10-19", "2026-10-20", "2026-10-21"].map((d) =>
  d === "2026-10-20" ? candle(d, revisedIdx, "3.77") : candle(d, dayList.indexOf(d)),
);
const vols = dayList
  .filter((d) => d !== "2026-10-15")
  .map((d, i) => `[${Date.parse(`${d}T00:00:00Z`)}, ${1000000 + i * 12345}.5]`);
fx(
  "fx.price.coingecko.near-usd-30d",
  "SYNTHETIC",
  "CoinGecko-format daily OHLC for NEAR/USD, window 2026-10-10..2026-11-08: 2026-10-15 missing, 2026-11-09 outside the window, a later vintage revising 2026-10-20. Candle values include an 18-fractional-digit price.",
  {
    "ohlc-v1.json": `[\n${v1.join(",\n")}\n]\n`,
    "ohlc-v2.json": `[\n${v2.join(",\n")}\n]\n`,
    "volumes-v1.json": `{"total_volumes": [\n${vols.join(",\n")}\n]}\n`,
    "fetches.json": {
      coinId: "near",
      symbol: "NEAR",
      quoteCurrency: "usd",
      window: { from: wStart, to: wEnd },
      fetches: [
        { file: "ohlc-v1.json", volumeFile: "volumes-v1.json", fetchedAtUTC: "2026-11-09T06:00:00.000Z" },
        { file: "ohlc-v2.json", fetchedAtUTC: "2026-11-10T06:00:00.000Z" },
      ],
      expect: {
        distinctDays: 29,
        rowsWithVintages: 32,
        missingDay: "2026-10-15",
        revisedDay: "2026-10-20",
        preciseDay: "2026-10-13",
        preciseClose: "4.123456789012345678",
      },
    },
  },
);

// ---------------------------------------------------------------- registry
const EV = "https://docs.near.org/";
const contracts = [
  {
    chain: "near",
    accountId: "meme-cooking.near",
    project: "meme.cooking",
    taxonomy: "launchpad",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0,
  },
  {
    chain: "near",
    accountId: "v2.ref-finance.near",
    project: "Rhea",
    taxonomy: "dex",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-11-09T00:00:00.000Z",
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0,
  },
  {
    chain: "near",
    accountId: "v2.ref-finance.near",
    project: "Rhea",
    taxonomy: "dex_aggregator",
    validFrom: "2026-11-09T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0,
  },
  {
    chain: "near",
    accountId: "hot.tg",
    project: "HOT/Omni",
    taxonomy: "bridge",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0,
  },
  {
    chain: "near",
    accountId: "outlayer.unresolved.near",
    project: "OutLayer",
    taxonomy: "compute",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "unverified",
    evidenceUrl: null,
    ambiguityScore: 0.6,
  },
  {
    chain: "near",
    accountId: "shared-dao.near",
    project: "Sputnik/Trezu",
    taxonomy: "dao",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0.2,
  },
  {
    chain: "near",
    accountId: "shared-dao.near",
    project: "Agent Market",
    taxonomy: "marketplace",
    validFrom: "2026-06-01T00:00:00.000Z",
    validTo: null,
    ownershipVerification: "verified",
    evidenceUrl: `${EV}`,
    ambiguityScore: 0.2,
  },
];
fx(
  "fx.registry.contracts-v1",
  "SYNTHETIC",
  "Contract registry: verified, taxonomy change on 2026-11-09, unverified OutLayer contract, and two conflicting rows for shared-dao.near.",
  { "contracts.json": contracts },
);
const aliases = [
  {
    canonicalAssetId: "BNB",
    providerAssetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    providerId: "intents-1click",
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: "2026-11-09T00:00:00.000Z",
    evidenceUrl: `${EV}`,
    verification: "verified",
  },
  {
    canonicalAssetId: "BNB",
    providerAssetId: "nep141:bsc.omft.near",
    providerId: "intents-1click",
    validFrom: "2026-11-09T00:00:00.000Z",
    validTo: null,
    evidenceUrl: `${EV}`,
    verification: "verified",
  },
  {
    canonicalAssetId: "ETH",
    providerAssetId: "nep141:eth.omft.near",
    providerId: "intents-1click",
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: null,
    evidenceUrl: `${EV}`,
    verification: "verified",
  },
  {
    canonicalAssetId: "NEAR",
    providerAssetId: "nep141:wrap.near",
    providerId: "intents-1click",
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: null,
    evidenceUrl: `${EV}`,
    verification: "verified",
  },
  {
    canonicalAssetId: "USDC",
    providerAssetId: USDC,
    providerId: "intents-1click",
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: null,
    evidenceUrl: null,
    verification: "unverified",
  },
];
fx(
  "fx.registry.asset-aliases",
  "SYNTHETIC",
  "Effective-dated asset aliases incl. the 2026-11-09 BNB legacy HOT id -> nep141:bsc.omft.near migration.",
  { "aliases.json": aliases },
);

// ---------------------------------------------------------------- bigquery
const bqDays = ["2026-10-01", "2026-10-02", "2026-10-03"];
const signers = (d: string) =>
  Array.from({ length: bqDays.indexOf(d) + 3 }, (_, i) => ({
    block_date: d,
    signer_account_id: `user${(i + bqDays.indexOf(d)) % 4}.near`,
  }));
const bqDaily = {
  job: {
    kind: "daily_usage",
    estimateBytes: 31457280,
    billedBytes: 31457280,
    location: "recorded-location",
    jobId: "synthetic-job-1",
  },
  rows: bqDays.map((d, i) => ({
    block_date: d,
    tx_count: String(1000 + i * 111),
    function_call_actions: String(900 + i * 100),
    distinct_signers: String(i + 3),
    active_contracts: String(40 + i),
  })),
};
const bqSigners = {
  job: {
    kind: "signer_days",
    estimateBytes: 20971520,
    billedBytes: 20971520,
    location: "recorded-location",
    jobId: "synthetic-job-2",
  },
  rows: bqDays.flatMap(signers),
};
const bqInter = {
  job: {
    kind: "contract_interactions",
    estimateBytes: 41943040,
    billedBytes: 41943040,
    location: "recorded-location",
    jobId: "synthetic-job-3",
  },
  rows: [
    ...["2026-10-01", "2026-11-10"].flatMap((d, k) => [
      { block_date: d, receiver_account_id: "meme-cooking.near", interactions: String(120 + k) },
      { block_date: d, receiver_account_id: "hot.tg", interactions: String(80 + k) },
      { block_date: d, receiver_account_id: "outlayer.unresolved.near", interactions: String(33 + k) },
      { block_date: d, receiver_account_id: "shared-dao.near", interactions: String(20 + k) },
      { block_date: d, receiver_account_id: "unknown.near", interactions: String(7 + k) },
    ]),
  ],
};

// ---------------------------------------------------------------- semantic fixtures (S11)
const gapDays = Array.from({ length: 10 }, (_, i) => addDays("2026-10-01", i));
const dayItems = (d: string, count: number, n0: number) =>
  Array.from({ length: count }, (_, k) =>
    mkTx({
      n: n0 + k,
      createdAt: `${d}T${String(20 - k * 3).padStart(2, "0")}:00:00.000Z`,
      status: "SUCCESS",
    }),
  );
const zvgFiles: Record<string, FileSpec> = {};
const zvgDays: Array<{
  day: string;
  pages: Array<{ file: string | null; fetchedAtUTC: string; status: number }>;
}> = [];
gapDays.forEach((d, i) => {
  const fetched = `2026-10-${String(12 + i).padStart(2, "0")}T06:00:00.000Z`;
  const n0 = 400 + i * 10;
  if (i === 2) {
    zvgFiles[`explorer/day-${d}-p1.json`] = []; // confirmed zero: 200 with an empty array
    zvgDays.push({
      day: d,
      pages: [{ file: `explorer/day-${d}-p1.json`, fetchedAtUTC: fetched, status: 200 }],
    });
  } else if (i === 5) {
    zvgDays.push({ day: d, pages: [{ file: null, fetchedAtUTC: fetched, status: 503 }] }); // gap: the day was never answered
  } else if (i === 8) {
    zvgFiles[`explorer/day-${d}-p1.json`] = dayItems(d, 5, n0); // full page then the next page fails: partial
    zvgDays.push({
      day: d,
      pages: [
        { file: `explorer/day-${d}-p1.json`, fetchedAtUTC: fetched, status: 200 },
        { file: null, fetchedAtUTC: fetched, status: 503 },
      ],
    });
  } else {
    zvgFiles[`explorer/day-${d}-p1.json`] = dayItems(d, 1 + (i % 3), n0);
    zvgDays.push({
      day: d,
      pages: [{ file: `explorer/day-${d}-p1.json`, fetchedAtUTC: fetched, status: 200 }],
    });
  }
});
fx(
  "fx.semantic.zero-vs-gap",
  "SYNTHETIC",
  "10 UTC days of Explorer day-queries: day 3 is a confirmed zero (200 []), day 6 is a gap (never answered), day 9 is partial (page 2 failed). Replay as a snapshot.",
  {
    ...zvgFiles,
    "snapshot.json": {
      snapshotId: "fx.semantic.zero-vs-gap",
      replayNowUTC: "2026-10-22T00:00:00.000Z",
      explorer: {
        environment: "fixture_synthetic",
        pageSize: 5,
        streams: [{ kind: "days", name: "daily", days: zvgDays }],
      },
    },
    "expected.json": {
      coverage: {
        "2026-10-01": "complete",
        "2026-10-02": "complete",
        "2026-10-03": "complete (confirmed zero, 0 swaps)",
        "2026-10-04": "complete",
        "2026-10-05": "complete",
        "2026-10-06": "unavailable",
        "2026-10-07": "complete",
        "2026-10-08": "complete",
        "2026-10-09": "partial",
        "2026-10-10": "complete",
      },
      rule: "unavailable and partial days must never be rendered or aggregated as zero; only 2026-10-03 is a real zero",
    },
  },
);

// decimal-edge: inputs written here; expected.json produced by python (decimal prec 80) below
const P2_128 = (2n ** 128n - 1n).toString();
const deTx = [
  {
    n: 501,
    amountIn: P2_128,
    amountOut: "1",
    origin: "nep141:wrap.near",
    dest: "nep141:eth.omft.near",
    fmtIn: "340282366920938.463463374607431768211455",
    fmtOut: "0.000000000000000001",
  },
  {
    n: 502,
    amountIn: "1",
    amountOut: "999999999999999999999999",
    origin: "nep141:wrap.near",
    dest: "nep141:wrap.near",
    fmtIn: "0.000000000000000000000001",
    fmtOut: "0.999999999999999999999999",
  },
  {
    n: 503,
    amountIn: "100000000000000000",
    amountOut: "9007199254740993",
    origin: "nep141:eth.omft.near",
    dest: "nep141:eth.omft.near",
    fmtIn: "0.1",
    fmtOut: "0.009007199254740993",
  },
  {
    n: 504,
    amountIn: "200000000000000000",
    amountOut: "2",
    origin: "nep141:eth.omft.near",
    dest: "nep141:eth.omft.near",
    fmtIn: "0.2",
    fmtOut: "0.000000000000000002",
  },
  {
    n: 505,
    amountIn: "300000000000000000",
    amountOut: "9007199254740993",
    origin: "nep141:eth.omft.near",
    dest: "nep141:eth.omft.near",
    fmtIn: "0.3",
    fmtOut: "0.009007199254740993",
  },
];
const dePage = deTx.map((t) =>
  mkTx({
    n: t.n,
    createdAt: minutesBefore("2026-10-15T12:00:00.000Z", (t.n - 501) * 10),
    status: "SUCCESS",
    amountIn: t.amountIn,
    amountOut: t.amountOut,
    amountInFormatted: t.fmtIn,
    amountOutFormatted: t.fmtOut,
    originAsset: t.origin,
    destinationAsset: t.dest,
    usdIn: "0.000000000000000000000001",
    usdOut: "123456789012345678901234567890.123456789012345678",
  }),
);
const decimalPy = `import json, sys
from decimal import Decimal, getcontext
getcontext().prec = 80
data = json.load(open(sys.argv[1]))
dec = {t["assetId"]: t["decimals"] for t in json.load(open(sys.argv[2]))}
out = {"precision": 80, "swaps": [], "sums": {}}
sum_in_units = {}
sum_in_formatted = {}
for tx in data:
    d_in, d_out = dec[tx["originAsset"]], dec[tx["destinationAsset"]]
    fin = Decimal(int(tx["amountIn"])).scaleb(-d_in)
    fout = Decimal(int(tx["amountOut"])).scaleb(-d_out)
    out["swaps"].append({"swapKey": tx["depositAddress"] + "|" + (tx["depositMemo"] or ""), "amountIn": tx["amountIn"], "amountInDecimal": format(fin, "f"), "amountOut": tx["amountOut"], "amountOutDecimal": format(fout, "f")})
    sum_in_units[tx["originAsset"]] = sum_in_units.get(tx["originAsset"], 0) + int(tx["amountIn"])
    sum_in_formatted[tx["originAsset"]] = sum_in_formatted.get(tx["originAsset"], Decimal(0)) + fin
out["sums"]["amountInUnitsByOriginAsset"] = {k: str(v) for k, v in sorted(sum_in_units.items())}
out["sums"]["amountInDecimalByOriginAsset"] = {k: format(v, "f") for k, v in sorted(sum_in_formatted.items())}
f = 0.0
for t in data:
    if t["originAsset"] == "nep141:eth.omft.near":
        f += float(Decimal(int(t["amountIn"])).scaleb(-dec[t["originAsset"]]))
out["sums"]["float64SumEthIn"] = repr(f)
out["sums"]["exactSumEthIn"] = format(sum_in_formatted["nep141:eth.omft.near"], "f")
out["sums"]["float64DiffersFromExact"] = Decimal(repr(f)) != sum_in_formatted["nep141:eth.omft.near"]
fo = 0.0
exact_out = 0
for t in data:
    if t["destinationAsset"] == "nep141:eth.omft.near" and t["originAsset"] == "nep141:eth.omft.near":
        fo += float(int(t["amountOut"]))
        exact_out += int(t["amountOut"])
out["sums"]["ethToEthAmountOutUnitsExact"] = str(exact_out)
out["sums"]["ethToEthAmountOutUnitsFloat64"] = str(int(fo))
out["sums"]["float64LosesUnits"] = int(fo) != exact_out
out["maxUint128"] = str(2**128 - 1)
json.dump(out, sys.stdout, indent=2, sort_keys=True)
print()
`;
const deTokens = tokens.filter((t) => ["nep141:wrap.near", "nep141:eth.omft.near"].includes(t.assetId));
fx(
  "fx.semantic.decimal-edge",
  "SYNTHETIC",
  "Decimal edge cases: 2^128-1, 1 yocto, 18/24-decimal tokens, sums whose float64 result differs from exact. expected.json is computed by decimal_edge.py (prec 80) run via uv.",
  {
    "explorer/page-1.json": dePage,
    "oneclick/tokens.json": deTokens,
    "snapshot.json": {
      snapshotId: "fx.semantic.decimal-edge",
      replayNowUTC: "2026-10-16T00:00:00.000Z",
      explorer: {
        environment: "fixture_synthetic",
        pageSize: 10,
        streams: [
          {
            kind: "pages",
            name: "main",
            pages: [{ file: "explorer/page-1.json", fetchedAtUTC: "2026-10-15T13:00:00.000Z", status: 200 }],
          },
        ],
      },
      oneclick: {
        environment: "fixture_synthetic",
        tokens: { file: "oneclick/tokens.json", fetchedAtUTC: "2026-10-15T13:00:00.000Z" },
        attempts: [],
      },
    },
    "decimal_edge.py": decimalPy,
  },
);

// ---------------------------------------------------------------- snapshots
const dupBase = (n: number, status: string, off: number) =>
  mkTx({ n, createdAt: minutesBefore("2026-10-18T12:00:00.000Z", off), status });
const dupA = [1, 2, 3, 4, 5].map((n) => dupBase(n, n === 3 ? "PENDING_DEPOSIT" : "SUCCESS", n * 10));
const dupB = [4, 5, 6, 7, 8].map((n) => dupBase(n, "SUCCESS", n * 10));
const dupC = [dupBase(3, "SUCCESS", 30), dupBase(9, "SUCCESS", 90)];
fx(
  "fx.snapshot.p02-duplicates",
  "SYNTHETIC",
  "Re-delivery (page A twice, byte-identical), overlapping pages (A/B share swaps 4,5), and swap 3 moving PENDING_DEPOSIT -> SUCCESS in a later page. 9 unique swaps expected, swap 3 SUCCESS.",
  {
    "explorer/page-a.json": dupA,
    "explorer/page-b.json": dupB,
    "explorer/page-c.json": dupC,
    "snapshot.json": {
      snapshotId: "fx.snapshot.p02-duplicates",
      replayNowUTC: "2026-10-19T00:00:00.000Z",
      explorer: {
        environment: "fixture_synthetic",
        pageSize: 5,
        streams: [
          {
            kind: "pages",
            name: "main",
            pages: [
              { file: "explorer/page-a.json", fetchedAtUTC: "2026-10-18T13:00:00.000Z", status: 200 },
              { file: "explorer/page-b.json", fetchedAtUTC: "2026-10-18T13:00:10.000Z", status: 200 },
              { file: "explorer/page-a.json", fetchedAtUTC: "2026-10-18T13:00:20.000Z", status: 200 },
              { file: "explorer/page-c.json", fetchedAtUTC: "2026-10-18T14:00:00.000Z", status: 200 },
            ],
          },
        ],
      },
    },
    "expected.json": {
      uniqueSwaps: 9,
      swap3FinalStatus: "SUCCESS",
      rule: "ReplacingMergeTree key swapKey, later version wins; terminal statuses are never regressed",
    },
  },
);

fx(
  "fx.snapshot.p02-baseline",
  "SYNTHETIC",
  "Complete credential-free P02 snapshot: Explorer public+private era pages, 1Click tokens and dry-quote attempts of every class, CoinGecko daily candles with a gap and a revised vintage, BigQuery daily usage, signer days and contract interactions, asset aliases and contract registry.",
  {
    ...Object.fromEntries(
      priv.length
        ? [
            ["explorer/page-1.json", pages3[0]!],
            ["explorer/page-2.json", pages3[1]!],
            ["explorer/page-3.json", pages3[2]!],
            ["explorer/page-4-private.json", priv],
          ]
        : [],
    ),
    "oneclick/tokens.json": tokens,
    "oneclick/quote-ok.json": quote("1000000000000000000", "1", "3098000000", "3098"),
    "oneclick/quote-no-liquidity.json": { message: "No route found: insufficient liquidity for this pair" },
    "oneclick/quote-invalid-schema.json": {
      correlationId: "corr-synthetic-0002",
      quote: { amountIn: "10000000000000000000" },
    },
    "oneclick/quote-zero-out.json": quote("10000000000000000000", "10", "0", "0"),
    "oneclick/quote-bad-scale.json": quote(
      "100000000000000000000",
      "100",
      "309800000000",
      "3098.123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890",
    ),
    "price/ohlc-v1.json": `[\n${v1.join(",\n")}\n]\n`,
    "price/ohlc-v2.json": `[\n${v2.join(",\n")}\n]\n`,
    "price/volumes-v1.json": `{"total_volumes": [\n${vols.join(",\n")}\n]}\n`,
    "bigquery/daily-usage.json": bqDaily,
    "bigquery/signer-days.json": bqSigners,
    "bigquery/contract-interactions.json": bqInter,
    "registry/contracts.json": contracts,
    "registry/aliases.json": aliases,
    "snapshot.json": {
      snapshotId: "fx.snapshot.p02-baseline",
      replayNowUTC: "2026-11-10T12:00:00.000Z",
      explorer: {
        environment: "fixture_synthetic",
        pageSize: 5,
        streams: [
          {
            kind: "pages",
            name: "main",
            pages: [
              { file: "explorer/page-1.json", fetchedAtUTC: "2026-10-20T13:00:00.000Z", status: 200 },
              { file: "explorer/page-2.json", fetchedAtUTC: "2026-10-20T13:00:05.000Z", status: 200 },
              { file: "explorer/page-3.json", fetchedAtUTC: "2026-10-20T13:00:10.000Z", status: 200 },
            ],
          },
          {
            kind: "pages",
            name: "private-era",
            pages: [
              { file: "explorer/page-4-private.json", fetchedAtUTC: "2026-10-28T13:00:00.000Z", status: 200 },
            ],
          },
        ],
      },
      oneclick: {
        environment: "fixture_synthetic",
        tokens: { file: "oneclick/tokens.json", fetchedAtUTC: "2026-11-10T11:00:00.000Z" },
        attempts: attemptsPlan.map((a) => ({ ...a, ...(a.file ? { file: `oneclick/${a.file}` } : {}) })),
      },
      price: {
        environment: "fixture_synthetic",
        coinId: "near",
        symbol: "NEAR",
        quoteCurrency: "usd",
        window: { from: wStart, to: wEnd },
        fetches: [
          {
            file: "price/ohlc-v1.json",
            volumeFile: "price/volumes-v1.json",
            fetchedAtUTC: "2026-11-09T06:00:00.000Z",
          },
          { file: "price/ohlc-v2.json", fetchedAtUTC: "2026-11-10T06:00:00.000Z" },
        ],
      },
      bigquery: {
        environment: "fixture_synthetic",
        jobs: [
          {
            kind: "daily_usage",
            file: "bigquery/daily-usage.json",
            fetchedAtUTC: "2026-11-10T09:00:00.000Z",
          },
          {
            kind: "signer_days",
            file: "bigquery/signer-days.json",
            fetchedAtUTC: "2026-11-10T09:00:05.000Z",
          },
          {
            kind: "contract_interactions",
            file: "bigquery/contract-interactions.json",
            fetchedAtUTC: "2026-11-10T09:00:10.000Z",
          },
        ],
      },
      registry: {
        environment: "fixture_synthetic",
        contracts: "registry/contracts.json",
        aliases: "registry/aliases.json",
      },
    },
  },
);

fx("fx.probe.p02-live", "SYNTHETIC", "D16 live probe plan (no recorded data).", {
  "plan.json": {
    bigquery: [
      "discover identity, billing project and dataset location",
      "dry run",
      "one 1-day block_date-bounded query, maximumBytesBilled <= 1 GiB",
    ],
    explorer: ["1 page, numberOfTransactions small"],
    oneclick: ["GET /v0/tokens", "1 dry POST /v0/quote"],
    coingecko: ["1 daily-candle request"],
  },
});

// ---------------------------------------------------------------- write + seal
async function fmt(path: string, content: string): Promise<string> {
  if (!path.endsWith(".json")) return content;
  const cfg = (await prettier.resolveConfig(join(ROOT, "x.json"))) ?? {};
  return prettier.format(content, { ...cfg, filepath: path });
}

async function writeFixture(id: string, extraManifest: Record<string, unknown> = {}): Promise<void> {
  const dir = join(ROOT, id);
  rmSync(dir, { recursive: true, force: true });
  const files: Array<{ path: string; sha256: string }> = [];
  for (const [p, c] of [...(staged.get(id) ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
    const out = await fmt(p, c);
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), out);
    files.push({ path: p, sha256: sha(out) });
  }
  const m = meta.get(id)!;
  const manifest = {
    id,
    label: m.label,
    description: m.description,
    files,
    ...(m.extra ?? {}),
    ...extraManifest,
  };
  writeFileSync(join(dir, "manifest.json"), await fmt("manifest.json", JSON.stringify(manifest)));
}

const SNAPSHOTS = [
  "fx.snapshot.p02-baseline",
  "fx.snapshot.p02-duplicates",
  "fx.semantic.zero-vs-gap",
  "fx.semantic.decimal-edge",
];
mkdirSync(ROOT, { recursive: true });

// decimal-edge expected via python (uv), before writing so it is part of the manifest
{
  const tmp = join(ROOT, "..", ".gen-tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "page.json"), JSON.stringify(dePage));
  writeFileSync(join(tmp, "tokens.json"), JSON.stringify(deTokens));
  writeFileSync(join(tmp, "decimal_edge.py"), decimalPy);
  const r = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "python",
      "-I",
      join(tmp, "decimal_edge.py"),
      join(tmp, "page.json"),
      join(tmp, "tokens.json"),
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  rmSync(tmp, { recursive: true, force: true });
  staged.get("fx.semantic.decimal-edge")!.set("expected.json", r.stdout);
  meta.get("fx.semantic.decimal-edge")!.extra = {
    expectedOutputSha256: sha(await fmt("expected.json", r.stdout)),
    computedBy: "uv run python decimal_edge.py (decimal prec 80)",
  };
}

for (const id of staged.keys()) if (!SNAPSHOTS.includes(id)) await writeFixture(id);
for (const id of SNAPSHOTS) await writeFixture(id);

// seal snapshot digests by replaying the written files
const { computeSnapshotDigest } = await import("../../../services/ingestion/src/replay-digest.ts");
for (const id of SNAPSHOTS) {
  const digest = await computeSnapshotDigest(id);
  await writeFixture(id, { expectedNormalizedDigest: digest });
  console.log(id, digest);
}
void cpSync;
void readdirSync;
void statSync;
void readFileSync;
void relative;
