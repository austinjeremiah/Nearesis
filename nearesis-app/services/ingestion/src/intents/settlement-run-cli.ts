import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { APP_ROOT, openArchive, openLivePg } from "../backfill/env.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { runSettlementPilot, settlementApprovalDigest, type SettlementDone } from "./settlement-run.ts";
import type { SettlementWindow } from "./settlement-sql.ts";

/**
 * BILLED (7-day settlement pilot). Refuses to run without BOTH `--approval-digest` and `--approved-max-bytes` from the owner.
 *   --print-digest  free: prints the digest of this window + scratch table to be approved, runs nothing
 * Run only after the owner approves the digest in docs/intents/APPROVAL-settlement.md.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    scratch: { type: "string" },
    "approval-digest": { type: "string" },
    "approved-max-bytes": { type: "string" },
    "print-digest": { type: "boolean" },
  },
});
const W: SettlementWindow = { id: "7d", swapFrom: "2026-10-20", swapTo: "2026-10-26" };
if (!values.scratch) {
  console.error(
    "usage: --scratch <project>.nearesis_scratch.settlement_hashes [--print-digest | --approval-digest D --approved-max-bytes N]",
  );
  process.exit(2);
}
if (values["print-digest"]) {
  console.log(settlementApprovalDigest(W, values.scratch));
  process.exit(0);
}
const DONE = join(APP_ROOT, ".data", "intents", "settlement-done.json");
const doneMap: Record<string, SettlementDone> = existsSync(DONE)
  ? (JSON.parse(readFileSync(DONE, "utf8")) as Record<string, SettlementDone>)
  : {};
const { db } = await openLivePg();
const hs = await db.query<{ h: string }>(
  `SELECT DISTINCT jsonb_array_elements_text(record->'nearTxHashes') AS h FROM ingestion.explorer_swaps
    WHERE created_at >= $1::date AND created_at < ($2::date + 1)`,
  [W.swapFrom, W.swapTo],
);
const hashes = hs.rows.map((r) => r.h);
await db.pool.end();
const bq = createBigQueryClient();
const runner = new BudgetedBigQuery(bq, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const since = quotaDayStart(Date.now());
const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
const r = await runSettlementPilot({
  bq,
  archive: openArchive(null),
  ledger: new BudgetLedger(reading.bytes),
  location: discovery.datasetLocation,
  window: W,
  scratchTable: values.scratch,
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
console.log(JSON.stringify(r.status === "done" ? { ...r, rows: r.rows.length } : r));
process.exit(r.status === "skipped" ? 3 : 0);
