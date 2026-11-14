/**
 * `tsx src/backfill/explorer-gaps-cli.ts [--record]` : lists holes in the loaded Explorer swap data (cursor jumps found in the
 * raw-archive cursor chain). With --record, writes each as a `partial` quality gap (ClickHouse + Postgres) and re-derives
 * coverage. No provider request. Insert-only; safe beside the running backfill and scheduler.
 */
import { createLiveCh } from "./ch.ts";
import { openLivePg } from "./env.ts";
import { refreshExplorerCoverage } from "./explorer-coverage.ts";
import { findExplorerCursorJumps, recordCursorJumps, refetchWindow } from "./explorer-gaps.ts";

const record = process.argv.includes("--record");
const ch = createLiveCh();
const { db } = await openLivePg();
try {
  const jumps = await findExplorerCursorJumps(db);
  console.log(JSON.stringify({ jumps: jumps.map((j) => ({ ...j, refetch: refetchWindow(j) })) }, null, 2));
  if (record) {
    await recordCursorJumps(db, ch, jumps);
    console.log(
      JSON.stringify({ recorded: jumps.length, coverageRowsWritten: await refreshExplorerCoverage(ch) }),
    );
  }
} finally {
  await ch.close();
  await db.pool.end();
}
