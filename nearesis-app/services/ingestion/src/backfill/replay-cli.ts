import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLiveCh, ensureDatabase, migrateLive } from "./ch.ts";
import { DATA_DIR, RAW_DIR, STATE_PATH, openLivePg } from "./env.ts";
import {
  SCHEDULER_ACCOUNT_STATE_PATH,
  SCHEDULER_BQ_STATE_PATH,
  SCHEDULER_RAW_DIR,
} from "../scheduler/config.ts";
import { replayRaw, type ReplaySource } from "./replay-raw.ts";

/**
 * Rebuilds nearesis_live (ClickHouse) and the Explorer import state (Postgres) from the local raw archives (backfill and scheduler). No network.
 * Read-only on state.json and account-state.json. Idempotent.
 */
const log = (m: string): void => console.log(`[replay-raw ${new Date().toISOString()}] ${m}`);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
try {
  const state = readJson<{ chunks: never; explorer?: { skippedPageHashes?: string[] } }>(STATE_PATH);
  const optional = <T>(p: string, fallback: T): T => {
    try {
      return readJson<T>(p);
    } catch {
      return fallback;
    }
  };
  const sources: ReplaySource[] = [
    {
      name: "backfill",
      rawRoot: RAW_DIR,
      chunks: state.chunks,
      accounts: optional<{ chunks: never }>(join(DATA_DIR, "account-state.json"), { chunks: {} as never })
        .chunks,
    },
  ];
  if (existsSync(SCHEDULER_RAW_DIR))
    sources.push({
      name: "scheduler",
      rawRoot: SCHEDULER_RAW_DIR,
      chunks: optional<{ chunks: never }>(SCHEDULER_BQ_STATE_PATH, { chunks: {} as never }).chunks,
      accounts: optional<{ chunks: never }>(SCHEDULER_ACCOUNT_STATE_PATH, { chunks: {} as never }).chunks,
    });
  const summary = await replayRaw({
    ch,
    db: live.db,
    sources,
    skippedHashes: state.explorer?.skippedPageHashes ?? [],
    log,
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await ch.close();
  await live.db.close();
}
