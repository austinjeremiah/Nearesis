import type { ClickHouseClient } from "@clickhouse/client";
import type { Redis } from "ioredis";
import { ExplorerCollector, type RunResult } from "../adapters/explorer.ts";
import type { RawArchive } from "../archive/archive.ts";
import { insertLive } from "../backfill/ch.ts";
import { loadSwapsToClickHouse } from "../backfill/explorer-session.ts";
import type { StateStore } from "../backfill/state.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { ALLOW_EXPLORER, HttpClient } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import { FORWARD_FROM_DAY, type SchedulerConfig } from "./config.ts";
import type { SchedulerStateStore } from "./state.ts";

/** The forward collection never touches the backfill's streams; each window has its own cursor stream. */
export const forwardStreamKey = (startUnix: number): string => `transactions:live-forward:${startUnix}`;

export interface ForwardWindow {
  startUnix: number; // non-inclusive (provider semantics)
  endUnix: number; // non-inclusive
  streamKey: string;
}

/**
 * Next window: from the forward watermark minus the overlap (late status changes of recent swaps) to now.
 * Before the first window completes, it starts at the day after the backfill window.
 */
export function nextForwardWindow(
  nowMs: number,
  watermarkMs: number | null,
  cfg: Pick<SchedulerConfig, "explorerOverlapMs">,
): ForwardWindow {
  const startMs =
    watermarkMs === null ? Date.parse(`${FORWARD_FROM_DAY}T00:00:00Z`) : watermarkMs - cfg.explorerOverlapMs;
  const startUnix = Math.floor(startMs / 1000) - 1;
  const endUnix = Math.floor(nowMs / 1000);
  return { startUnix, endUnix, streamKey: forwardStreamKey(startUnix) };
}

export interface ExplorerForwardResult {
  status: RunResult["status"] | "no_credential";
  pagesCommitted: number;
  swapsInserted: number;
  loadedSwaps: number;
  complete: boolean;
  windowStartUTC: string | null;
  windowEndUTC: string | null;
  requests: number;
}

const TERMINAL: ReadonlySet<string> = new Set(["auth_blocked", "quarantined"]);

export async function runExplorerForward(d: {
  ch: ClickHouseClient;
  db: Db;
  archive: RawArchive;
  creds: CredentialSource;
  redis: Redis;
  clock: Clock;
  sched: SchedulerStateStore;
  loadStore: StateStore;
  cfg: SchedulerConfig;
  pageSize?: number;
  baseUrl?: string;
  blockerDir?: string;
  fetchImpl?: ConstructorParameters<typeof HttpClient>[0]["fetchImpl"];
  /** Skips the ClickHouse load (unit tests); production always loads. */
  skipLoad?: boolean;
  log?: (m: string) => void;
}): Promise<ExplorerForwardResult> {
  const log = d.log ?? (() => undefined);
  const st = d.sched.state.explorer;
  if (!d.creds.has("INTENTS_EXPLORER_JWT")) {
    log("explorer: INTENTS_EXPLORER_JWT not set, skipping");
    return {
      status: "no_credential",
      pagesCommitted: 0,
      swapsInserted: 0,
      loadedSwaps: 0,
      complete: false,
      windowStartUTC: null,
      windowEndUTC: null,
      requests: 0,
    };
  }
  st.inflight ??= nextForwardWindow(d.clock.now(), st.watermarkMs, d.cfg);
  const w = st.inflight;
  d.sched.save();
  const http = new HttpClient({
    allow: [ALLOW_EXPLORER],
    credentials: d.creds,
    clock: d.clock,
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
  });
  // Same credential => same Redis token bucket as the backfill: the combined rate never exceeds 1 request / 5 s.
  const collector = new ExplorerCollector({
    http,
    archive: d.archive,
    db: d.db,
    redis: d.redis,
    clock: d.clock,
    credentials: d.creds,
    pageSize: d.pageSize ?? 1000,
    sourceEnvironment: "live",
    streamKey: w.streamKey,
    ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
    ...(d.blockerDir ? { blockerDir: d.blockerDir } : {}),
  });
  if (!d.skipLoad && d.loadStore.state.explorerLoad === undefined) {
    // First run: the backfill's loader owns everything already imported; this loader starts at the current end,
    // taken BEFORE this run writes anything so the run's own swaps are loaded.
    const m = await d.db.query<{ v: string | null }>(
      "SELECT max(version_ms)::text AS v FROM ingestion.explorer_swaps",
    );
    d.loadStore.state.explorerLoad = { afterVersionMs: Number(m.rows[0]?.v ?? 0), afterKey: "" };
    d.loadStore.save();
  }
  const windowStartUTC = new Date((w.startUnix + 1) * 1000).toISOString();
  const windowEndUTC = new Date(w.endUnix * 1000).toISOString();
  const r = await collector.run({
    startUnix: w.startUnix,
    endUnix: w.endUnix,
    windowStartUTC,
    windowEndUTC,
    maxPages: d.cfg.explorerMaxPagesPerTick,
  });
  const requests = http.requestLog.filter((x) => x.outcome !== "denied").length;
  st.requests += requests;
  st.swapsInserted += r.swapsInserted;
  let loaded = 0;
  if (!d.skipLoad) {
    loaded = await loadSwapsToClickHouse(d.db, d.ch, d.loadStore, d.clock.now());
  }
  const complete = r.status === "complete";
  if (complete) {
    st.watermarkMs = w.endUnix * 1000;
    st.inflight = null;
    st.lastFullScanAtMs = d.clock.now();
    st.gapRecordedFor = null;
  } else if (TERMINAL.has(r.status) && st.gapRecordedFor !== w.streamKey) {
    // The window cannot be collected until the cause is fixed: say so in quality_gaps (the data is unknown, never zero).
    await insertLive(d.ch, "quality_gaps", [
      {
        provider_id: "near-explorer",
        dataset: "intents_swaps",
        from_utc: windowStartUTC,
        to_utc: windowEndUTC,
        state: "unavailable",
        reason_code: r.status === "auth_blocked" ? "AUTH_REJECTED" : "PAGE_QUARANTINED",
        source_label: "LIVE",
        version: d.clock.now(),
      },
    ]);
    st.gapRecordedFor = w.streamKey;
  }
  d.sched.save();
  log(
    `explorer forward ${windowStartUTC}..${windowEndUTC}: ${r.status}, +${r.pagesCommitted} pages, +${r.swapsInserted} swaps, ${requests} requests`,
  );
  return {
    status: r.status,
    pagesCommitted: r.pagesCommitted,
    swapsInserted: r.swapsInserted,
    loadedSwaps: loaded,
    complete,
    windowStartUTC,
    windowEndUTC,
    requests,
  };
}
