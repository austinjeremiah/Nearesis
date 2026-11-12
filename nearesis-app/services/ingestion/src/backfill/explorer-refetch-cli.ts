/**
 * `tsx src/backfill/explorer-refetch-cli.ts --from YYYY-MM-DD --to YYYY-MM-DD [--max-pages N]`
 *
 * Refetches EXACTLY the whole UTC days [from, to] from the Explorer with the provider's own time filter, on its own cursor
 * stream (`transactions:refetch:<from>:<to>`), through the same collector, rate limiter (shared Redis bucket), raw archive and
 * Postgres import as the backfill. It must NOT run beside the backfill session: stop the backfill's explorer session first
 * (one Explorer stream at a time, ADR rate policy), run this, then start the backfill again.
 *
 * Loading into ClickHouse is left to the backfill's own loader (the refetched swaps carry a newer version_ms, so its keyset
 * picks them up on the next batch). When the refetch finishes with status `complete`, every day in the range that still holds
 * zero swaps is recorded as PROVIDER_EMPTY_CONFIRMED (complete, zero swaps): the provider answered the exact window and had nothing.
 */
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { ExplorerCollector } from "../adapters/explorer.ts";
import { systemClock } from "../clock.ts";
import { ALLOW_EXPLORER, HttpClient } from "../http/client.ts";
import { coverageRows, createLiveCh, insertLive } from "./ch.ts";
import { loadCredentials, openArchive, openLivePg, REDIS_URL } from "./env.ts";
import { EXPLORER_DATASET, EXPLORER_PROVIDER, PROVIDER_EMPTY_CONFIRMED } from "./explorer-coverage.ts";
import { refetchWindow } from "./explorer-gaps.ts";
import { addDays } from "./plan.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { from: { type: "string" }, to: { type: "string" }, "max-pages": { type: "string" } },
});
const re = /^\d{4}-\d{2}-\d{2}$/;
if (!values.from || !values.to || !re.test(values.from) || !re.test(values.to) || values.from > values.to)
  throw new Error("--from and --to (YYYY-MM-DD, from <= to) are required");
const w = refetchWindow({ refetchFromDay: values.from, refetchToDay: values.to });
const creds = loadCredentials();
if (!creds.has("INTENTS_EXPLORER_JWT")) throw new Error("INTENTS_EXPLORER_JWT not set");
const ch = createLiveCh();
const { db } = await openLivePg();
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
try {
  const collector = new ExplorerCollector({
    http: new HttpClient({ allow: [ALLOW_EXPLORER], credentials: creds, clock: systemClock }),
    archive: openArchive(db),
    db,
    redis,
    clock: systemClock,
    credentials: creds,
    pageSize: 1000,
    sourceEnvironment: "live",
    streamKey: w.streamKey,
  });
  const r = await collector.run({
    startUnix: w.startUnix,
    endUnix: w.endUnix,
    ...(values["max-pages"] ? { maxPages: Number(values["max-pages"]) } : {}),
  });
  console.log(JSON.stringify({ stream: w.streamKey, ...r }));
  if (r.status === "complete") {
    const have = await db.query<{ d: string }>(
      "SELECT DISTINCT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM ingestion.explorer_swaps WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz",
      [`${values.from}T00:00:00Z`, `${addDays(values.to, 1)}T00:00:00Z`],
    );
    const withSwaps = new Set(have.rows.map((x) => x.d));
    const empty: string[] = [];
    for (let d = values.from; d <= values.to; d = addDays(d, 1)) if (!withSwaps.has(d)) empty.push(d);
    if (empty.length)
      await insertLive(
        ch,
        "source_coverage",
        coverageRows(
          empty.map((day) => ({
            provider_id: EXPLORER_PROVIDER,
            dataset: EXPLORER_DATASET,
            day,
            state: "complete" as const,
            reason: PROVIDER_EMPTY_CONFIRMED,
            version: Date.now(),
          })),
        ),
      );
    console.log(JSON.stringify({ providerEmptyConfirmedDays: empty }));
  } else console.log(`refetch not complete (${r.status}); rerun the same command to resume its own cursor`);
} finally {
  redis.disconnect();
  await ch.close();
  await db.pool.end();
}
