import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLiveCh, ensureDatabase, migrateLive } from "./ch.ts";
import { DATA_DIR, RAW_DIR, STATE_PATH, openLivePg } from "./env.ts";
import { replayRaw } from "./replay-raw.ts";

/**
 * Rebuilds nearesis_live (ClickHouse) and the Explorer import state (Postgres) from the local raw archive. No network.
 * Read-only on state.json and account-state.json. Idempotent.
 */
const log = (m: string): void => console.log(`[replay-raw ${new Date().toISOString()}] ${m}`);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
try {
  const state = readJson<{ chunks: never }>(STATE_PATH);
  let accounts = {};
  try {
    accounts = readJson<{ chunks: never }>(join(DATA_DIR, "account-state.json")).chunks;
  } catch {
    log("no account-state.json; account results are skipped");
  }
  const summary = await replayRaw({ ch, db: live.db, rawRoot: RAW_DIR, chunks: state.chunks, accounts, log });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await ch.close();
  await live.db.close();
}
