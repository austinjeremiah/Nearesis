import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { coverageRows, createLiveCh, ensureDatabase, insertLive, migrateLive } from "../backfill/ch.ts";
import { APP_ROOT, openArchive, openLivePg } from "../backfill/env.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { installSpendGateFromEnv } from "../cost/ambient.ts";
import { runSettlementPilot, settlementApprovalDigest, type SettlementDone } from "./settlement-run.ts";
import type { SettlementWindow } from "./settlement-sql.ts";

/** BILLED settlement pilot, owner-approved: digest 0647e998..., max 0.4 GiB (429496729), window 2026-10-20..2026-10-26. */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { "approval-digest": { type: "string" }, "approved-max-bytes": { type: "string" } },
});
const gate = await installSpendGateFromEnv();
const W: SettlementWindow = { id: "7d", swapFrom: "2026-10-20", swapTo: "2026-10-26" };
const SCRATCH = "near-514307.nearesis_scratch.settlement_hashes";
console.error(`digest ${settlementApprovalDigest(W, SCRATCH)}`);
const OUT = join(APP_ROOT, ".data", "intents", "settlement-pilot-result.json");
const DONE = join(APP_ROOT, ".data", "intents", "settlement-done.json");
const doneMap: Record<string, SettlementDone> = existsSync(DONE)
  ? JSON.parse(readFileSync(DONE, "utf8"))
  : {};
const { db } = await openLivePg();
const hs = await db.query<{ h: string }>(
  `SELECT DISTINCT jsonb_array_elements_text(record->'nearTxHashes') AS h FROM ingestion.explorer_swaps
    WHERE created_at >= $1::date AND created_at < ($2::date + 1)`,
  [W.swapFrom, W.swapTo],
);
const hashes = hs.rows.map((r) => r.h);
const bq = createBigQueryClient();
const runner = new BudgetedBigQuery(bq, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const reading = await runner.billedSince(discovery.datasetLocation, quotaDayStart(Date.now()).toISOString());
const r = await runSettlementPilot({
  bq,
  archive: openArchive(db),
  ledger: new BudgetLedger(reading.bytes),
  location: discovery.datasetLocation,
  window: W,
  scratchTable: SCRATCH,
  hashes,
  approvalDigest: values["approval-digest"],
  approvedMaxBytes: values["approved-max-bytes"] ? Number(values["approved-max-bytes"]) : undefined,
  isDone: (id) => id in doneMap,
  markDone: (d) => {
    doneMap[d.id] = d;
    mkdirSync(dirname(DONE), { recursive: true });
    writeFileSync(DONE, `${JSON.stringify(doneMap, null, 2)}\n`);
  },
  log: (m) => console.error(m),
});
mkdirSync(dirname(OUT), { recursive: true });
if (r.status !== "done") {
  writeFileSync(
    OUT,
    JSON.stringify({ ...r, hashesLoaded: new Set(hashes).size, billedBeforeRun: reading.bytes }, null, 2),
  );
  console.log(JSON.stringify(r));
  await db.close();
  await gate?.close();
  process.exit(3);
}
// ---- load into ClickHouse ----
const ts = new Map<string, bigint>();
for (const row of r.rows) ts.set(String(row.tx_hash), BigInt(String(row.block_ts_ns)));
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const iso = r.done.completedAtUTC;
const ver = Date.parse(iso);
await insertLive(
  ch,
  "intents_settlement_tx_times",
  [...ts].map(([h, t]) => ({
    tx_hash: h,
    block_ts_ns: t.toString(),
    window_id: r.done.id,
    source_label: "LIVE",
    raw_object_hash: r.done.rawObjectHash,
    fetched_at: iso,
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
    WHERE s.created_day >= {f:Date} AND s.created_day <= {t:Date} AND s.privacy_era = 'public' AND length(public_swap_tx_hashes) > 0`,
  query_params: { f: W.swapFrom, t: W.swapTo },
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
  let min: bigint | undefined,
    max: bigint | undefined,
    maxIdx: number | null = null;
  found.forEach((t, i) => {
    if (t === undefined) return;
    if (min === undefined || t < min) min = t;
    if (max === undefined || t > max) {
      max = t;
      maxIdx = i;
    }
  });
  const f0 = found[0],
    fl = found[found.length - 1];
  return {
    swap_key: s.swap_key,
    window_id: r.done.id,
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
    raw_object_hash: r.done.rawObjectHash,
    fetched_at: iso,
    version: ver,
  };
});
for (let i = 0; i < rows.length; i += 20000)
  await insertLive(ch, "intents_settlement_durations", rows.slice(i, i + 20000));
const days: string[] = [];
for (
  let d = W.swapFrom;
  d <= W.swapTo;
  d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
)
  days.push(d);
const covRows = days.map((day) => {
  const dr = rows.filter((x) => x.created_day === day);
  const part = dr.some((x) => x.complete === 0);
  return {
    provider_id: "near-bigquery",
    dataset: "intents_settlement_durations",
    day,
    state: dr.length === 0 ? ("unavailable" as const) : part ? ("partial" as const) : ("complete" as const),
    reason: dr.length === 0 ? "PROVIDER_GAP" : part ? "SOME_HASHES_NOT_FOUND" : null,
    version: ver,
  };
});
await insertLive(ch, "source_coverage", coverageRows(covRows));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      status: "done",
      done: r.done,
      scratchCleanup: r.scratchCleanup,
      bqRows: r.rows.length,
      swapsWithHashes: swaps.length,
      storedRows: rows.length,
      hashesLoaded: new Set(hashes).size,
      billedBeforeRun: reading.bytes,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    done: r.done,
    scratchCleanup: r.scratchCleanup,
    bqRows: r.rows.length,
    swaps: swaps.length,
  }),
);
await ch.close();
await db.close();
await gate?.close();
