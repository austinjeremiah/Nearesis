import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, RAW_DIR, STATE_PATH, openLivePg } from "../backfill/env.ts";
import {
  SCHEDULER_ACCOUNT_STATE_PATH,
  SCHEDULER_BQ_STATE_PATH,
  SCHEDULER_RAW_DIR,
} from "../scheduler/config.ts";
import { reconstructRawObservations, type ReconSource } from "./reconstruct.ts";

/**
 * Rebuild ingestion.raw_observations metadata from surviving payload files and progress files. No network.
 * Default is a dry run; pass --apply to insert. Idempotent. Read-only on every state file.
 *   tsx src/archive/reconstruct-cli.ts [--apply]
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { apply: { type: "boolean" } },
});
const optional = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const state = optional<{ chunks: never; explorer?: { skippedPageHashes?: string[] } }>(STATE_PATH, {
  chunks: {} as never,
});
const sources: ReconSource[] = [
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
const live = await openLivePg();
try {
  const summary = await reconstructRawObservations({
    db: live.db,
    sources,
    skippedPageHashes: state.explorer?.skippedPageHashes ?? [],
    dryRun: !values.apply,
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await live.db.close();
}
