import { quotaDayStart } from "./plan.ts";
import { openLivePg } from "./env.ts";
import type { StateStore } from "./state.ts";

/** Prints explorer progress (state.json plus the Postgres import state), BigQuery checkpoint counts and the last error. */
export async function printStatus(store: StateStore): Promise<void> {
  const ex = store.state.explorer;
  const live = await openLivePg();
  try {
    const r = await live.db.query<{ n: string; lo: Date | null; hi: Date | null }>(
      "SELECT count(*) n, min(created_at) lo, max(created_at) hi FROM ingestion.explorer_swaps",
    );
    const cur = await live.db.query<{ pages_committed: number; updated_at: Date }>(
      "SELECT pages_committed, updated_at FROM ingestion.cursor_state WHERE provider_id='near-explorer'",
    );
    const row = r.rows[0];
    console.log(
      JSON.stringify(
        {
          explorer: {
            pagesCommitted: cur.rows[0]?.pages_committed ?? 0,
            lastPageAtUTC: cur.rows[0]?.updated_at.toISOString() ?? null,
            swapsInDatabase: Number(row?.n ?? 0),
            earliestSwapUTC: row?.lo?.toISOString() ?? null,
            latestSwapUTC: row?.hi?.toISOString() ?? null,
            complete: ex.complete ?? false,
            lastStatus: ex.lastStatus,
            lastStatusAtUTC: ex.lastStatusAtUTC ?? null,
            lastError: ex.lastError ?? null,
            sessions: ex.sessions,
          },
          bigquery: {
            chunksDone: Object.keys(store.state.chunks).length,
            billedByQuotaDayBytes: store.state.billedByQuotaDay,
            currentQuotaDayStartUTC: quotaDayStart(Date.now()).toISOString(),
          },
          price: store.state.price,
        },
        null,
        2,
      ),
    );
  } finally {
    await live.db.close();
  }
}
