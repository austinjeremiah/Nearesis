import type { ClickHouseClient } from "@clickhouse/client";
import { Redis } from "ioredis";
import type { RawArchive } from "../archive/archive.ts";
import type { Db } from "../db.ts";
import { ExplorerCollector, EXPLORER_ADAPTER_VERSION } from "../adapters/explorer.ts";
import type { ExplorerTx } from "../adapters/explorer-parse.ts";
import { systemClock } from "../clock.ts";
import { ALLOW_EXPLORER, HttpClient } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import { normalize } from "../normalize.ts";
import { coverageRows, insertLive, swapRows } from "./ch.ts";
import { REDIS_URL } from "./env.ts";
import { addDays, WINDOW_FROM, WINDOW_TO } from "./plan.ts";
import type { StateStore } from "./state.ts";

export const EXPLORER_STREAM = "transactions:live-backfill";
const PAGE_SIZE = 1000;
const BATCH_PAGES = 30; // run() is called in batches so wall-clock caps are honoured between them

export interface ExplorerResult {
  status: string;
  sessionMinutes: number;
  requests: number;
  pagesCommitted: number;
  swapsInserted: number;
  loadedSwaps: number;
  cursor: unknown;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  complete: boolean;
}

/** Loads swaps (keyset by version_ms, swap_key) from the Postgres import state into ClickHouse through the normalizer. */
export async function loadSwapsToClickHouse(
  db: Db,
  ch: ClickHouseClient,
  store: StateStore,
  nowMs: number,
): Promise<number> {
  let loaded = 0;
  let afterV = store.state.explorerLoad?.afterVersionMs ?? 0;
  let afterK = store.state.explorerLoad?.afterKey ?? "";
  for (;;) {
    const r = await db.query<{
      swap_key: string;
      status: string;
      created_at: Date;
      amount_in: string;
      amount_out: string;
      raw_object_hash: string;
      version_ms: string;
      record: ExplorerTx;
    }>(
      `SELECT swap_key, status, created_at, amount_in, amount_out, raw_object_hash, version_ms, record
         FROM ingestion.explorer_swaps
        WHERE (version_ms, swap_key) > ($1::bigint, $2::text)
        ORDER BY version_ms, swap_key LIMIT 5000`,
      [afterV, afterK],
    );
    if (r.rows.length === 0) break;
    const out = normalize({
      snapshotId: "live-backfill",
      mode: "live",
      nowMs,
      explorer: {
        label: "LIVE",
        adapterVersion: EXPLORER_ADAPTER_VERSION,
        schemaFingerprint: null,
        swaps: r.rows.map((x) => ({
          version: Number(x.version_ms),
          stored: {
            swapKey: x.swap_key,
            status: x.status,
            createdAt: x.created_at.toISOString(),
            amountIn: x.amount_in,
            amountOut: x.amount_out,
            rawObjectHash: x.raw_object_hash,
            record: x.record,
          },
        })),
        days: [],
        gaps: [],
      },
    });
    await insertLive(ch, "intents_swaps", swapRows(out.tables.intents_swaps, new Date(nowMs).toISOString()));
    loaded += r.rows.length;
    const last = r.rows[r.rows.length - 1]!;
    afterV = Number(last.version_ms);
    afterK = last.swap_key;
    store.state.explorerLoad = { afterVersionMs: afterV, afterKey: afterK };
    store.save();
  }
  return loaded;
}

export async function runExplorerSession(d: {
  ch: ClickHouseClient;
  db: Db;
  archive: RawArchive;
  creds: CredentialSource;
  store: StateStore;
  minutes: number;
  log: (m: string) => void;
}): Promise<ExplorerResult | null> {
  if (!d.creds.has("INTENTS_EXPLORER_JWT")) {
    d.log("explorer: INTENTS_EXPLORER_JWT not set, skipping");
    return null;
  }
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const http = new HttpClient({ allow: [ALLOW_EXPLORER], credentials: d.creds, clock: systemClock });
  const collector = new ExplorerCollector({
    http,
    archive: d.archive,
    db: d.db,
    redis,
    clock: systemClock,
    credentials: d.creds,
    pageSize: PAGE_SIZE,
    sourceEnvironment: "live",
    streamKey: EXPLORER_STREAM,
  });
  const startedAt = Date.now();
  const deadline = startedAt + d.minutes * 60_000;
  const window = {
    startUnix: Date.parse(`${WINDOW_FROM}T00:00:00Z`) / 1000 - 1, // non-inclusive in provider semantics
    endUnix: Date.parse(`${addDays(WINDOW_TO, 1)}T00:00:00Z`) / 1000,
    windowStartUTC: `${WINDOW_FROM}T00:00:00.000Z`,
    windowEndUTC: `${WINDOW_TO}T23:59:59.999Z`,
  };
  let status = "max_pages";
  let pages = 0;
  let inserted = 0;
  let lastCursor: unknown = null;
  try {
    while (Date.now() < deadline) {
      const r = await collector.run({ ...window, maxPages: BATCH_PAGES });
      pages += r.pagesCommitted;
      inserted += r.swapsInserted;
      lastCursor = r.cursor;
      status = r.status;
      d.log(`explorer batch: ${r.status}, +${r.pagesCommitted} pages, +${r.swapsInserted} swaps`);
      if (r.status !== "max_pages") break;
      // load incrementally so ClickHouse tracks the Postgres import state as it grows
      await loadSwapsToClickHouse(d.db, d.ch, d.store, Date.now());
    }
  } finally {
    redis.disconnect();
  }
  const loadedSwaps = await loadSwapsToClickHouse(d.db, d.ch, d.store, Date.now());
  const range = await d.db.query<{ lo: Date | null; hi: Date | null }>(
    "SELECT min(created_at) lo, max(created_at) hi FROM ingestion.explorer_swaps",
  );
  const complete = status === "complete";
  if (complete) {
    const v = Date.now();
    const days: string[] = [];
    for (let day = WINDOW_FROM; day <= WINDOW_TO; day = addDays(day, 1)) days.push(day);
    await insertLive(
      d.ch,
      "source_coverage",
      coverageRows(
        days.map((day) => ({
          provider_id: "near-explorer",
          dataset: "intents_swaps",
          day,
          state: "complete" as const,
          reason: null,
          version: v,
        })),
      ),
    );
  }
  const ex = d.store.state.explorer;
  ex.requests += http.requestLog.filter((x) => x.outcome !== "denied").length;
  ex.pagesCommitted += pages;
  ex.swapsInserted += inserted;
  ex.sessions += 1;
  ex.lastStatus = status;
  ex.complete = complete;
  d.store.save();
  return {
    status,
    sessionMinutes: Math.round(((Date.now() - startedAt) / 60_000) * 10) / 10,
    requests: http.requestLog.filter((x) => x.outcome !== "denied").length,
    pagesCommitted: pages,
    swapsInserted: inserted,
    loadedSwaps,
    cursor: lastCursor,
    oldestCreatedAt: range.rows[0]?.lo?.toISOString() ?? null,
    newestCreatedAt: range.rows[0]?.hi?.toISOString() ?? null,
    complete,
  };
}
