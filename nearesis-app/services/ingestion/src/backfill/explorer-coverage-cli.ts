import { createLiveCh, ensureDatabase } from "./ch.ts";
import { refreshExplorerCoverage } from "./explorer-coverage.ts";

/** One-off, idempotent: derives near-explorer/intents_swaps source_coverage from the loaded data. Insert-only; safe beside the running backfill and scheduler. */
await ensureDatabase();
const ch = createLiveCh();
try {
  const n = await refreshExplorerCoverage(ch);
  console.log(JSON.stringify({ coverageRowsWritten: n }));
} finally {
  await ch.close();
}
