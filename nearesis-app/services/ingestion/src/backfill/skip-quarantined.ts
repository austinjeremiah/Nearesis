import { readFileSync } from "node:fs";
import { join } from "node:path";
import { advancePastQuarantined, salvagePage, SKIPPABLE_REASONS } from "../adapters/explorer.ts";
import { createLiveCh } from "./ch.ts";
import { RAW_DIR, STATE_PATH, openLivePg } from "./env.ts";
import { EXPLORER_STREAM, makeSkipPolicy } from "./explorer-session.ts";
import { WINDOW_FROM, WINDOW_TO } from "./plan.ts";
import { StateStore } from "./state.ts";

/**
 * One-off, no network: applies the bounded skip to an already quarantined Explorer page found in the raw archive.
 * Records the gap (ClickHouse and Postgres), moves the stored cursor past the page and counts it in state.json.
 * Usage: backfill:skip-quarantined <rawObjectHash>
 */
const hash = process.argv.slice(2).find((a) => /^[0-9a-f]{64}$/.test(a));
if (!hash) throw new Error("usage: skip-quarantined <64-hex raw object hash>");
const log = (m: string): void => console.log(`[skip-quarantined ${new Date().toISOString()}] ${m}`);
const live = await openLivePg();
const ch = createLiveCh();
try {
  const q = await live.db.query<{ reason_code: string }>(
    "SELECT reason_code FROM ingestion.quarantine WHERE kind='explorer_page' AND raw_object_hash=$1 LIMIT 1",
    [hash],
  );
  const reason = q.rows[0]?.reason_code;
  if (!reason) throw new Error("hash is not a quarantined explorer page");
  if (!SKIPPABLE_REASONS.has(reason)) throw new Error(`reason ${reason} is not skippable`);
  const salvaged = salvagePage(new Uint8Array(readFileSync(join(RAW_DIR, hash.slice(0, 2), hash))));
  if (!salvaged) throw new Error("page position cannot be derived from the raw bytes");
  const store = new StateStore(STATE_PATH, WINDOW_FROM, WINDOW_TO);
  const policy = makeSkipPolicy(ch, store, log);
  if (!policy.allow(hash)) throw new Error("skip cap reached");
  const page = { rawObjectHash: hash, reasonCode: reason, detail: "applied from raw archive", ...salvaged };
  await policy.record(page);
  await advancePastQuarantined(live.db, EXPLORER_STREAM, page);
  log(`cursor now ${JSON.stringify(salvaged.cursor)}`);
} finally {
  await ch.close();
  await live.db.close();
}
