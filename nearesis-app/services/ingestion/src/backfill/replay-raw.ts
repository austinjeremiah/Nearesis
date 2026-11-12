import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  explorerSchemaFingerprint,
  parseExplorerPage,
  type ExplorerCursor,
} from "../adapters/explorer-parse.ts";
import {
  advancePastQuarantined,
  salvagePage,
  SKIPPABLE_REASONS,
  upsertSwapPage,
} from "../adapters/explorer.ts";
import type { Db } from "../db.ts";
import { sha256Hex } from "../hash.ts";
import { loadAccountChunk } from "./account-load.ts";
import type { AccountChunkDone } from "./account-run.ts";
import type { BqRow } from "./bq-runner.ts";
import { makeChSink } from "./orchestrator.ts";
import { dailyFileBytes, loadPriceFetches } from "./price-phase.ts";
import { addDays, type Chunk } from "./plan.ts";
import type { ChunkDone } from "./state.ts";
import { EXPLORER_STREAM, loadSwapsToClickHouse, recordQuarantineGapCh } from "./explorer-session.ts";

export type RawKind = "explorer" | "bq-chunk" | "account" | "price" | "unknown";

export interface KnownHashes {
  chunks: Map<string, ChunkDone>; // rawObjectHash -> chunk record (state.json)
  accounts: Map<string, AccountChunkDone>; // rawObjectHash -> account record (account-state.json)
}

export const knownHashes = (
  chunks: Record<string, ChunkDone>,
  accounts: Record<string, AccountChunkDone>,
): KnownHashes => ({
  chunks: new Map(Object.values(chunks).map((c) => [c.rawObjectHash, c])),
  accounts: new Map(Object.values(accounts).map((c) => [c.rawObjectHash, c])),
});

/** Classifies one archive object. Hashes named by the progress files win; otherwise the content decides. */
export function classifyRawObject(hash: string, bytes: Uint8Array, known: KnownHashes): RawKind {
  if (known.chunks.has(hash)) return "bq-chunk";
  if (known.accounts.has(hash)) return "account";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
  if (head.startsWith("{")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { prices?: unknown };
      return Array.isArray(j.prices) ? "price" : "unknown";
    } catch {
      return "unknown";
    }
  }
  if (head.startsWith("[")) {
    const text = new TextDecoder().decode(bytes);
    if (text.includes('"originAsset"')) return "explorer";
    if (text.includes('"kind"')) return "account";
  }
  return "unknown";
}

const DAY_MS = 86_400_000;
const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whole-UTC-day window [from, to) covered by a price object's samples (a sample exactly on `to` midnight is excluded). */
export function priceWindowOf(body: Uint8Array): { from: string; to: string } | null {
  const j = JSON.parse(new TextDecoder().decode(body)) as { prices?: Array<[number, number]> };
  const ts = (j.prices ?? []).map((p) => p[0]).filter((t) => Number.isFinite(t));
  if (ts.length === 0) return null;
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  return { from: dayOfMs(lo), to: hi % DAY_MS === 0 ? dayOfMs(hi) : addDays(dayOfMs(hi), 1) };
}

export interface RawFile {
  hash: string;
  path: string;
  mtimeMs: number;
  size: number;
  /** name of the archive root it came from (see ReplaySource) */
  source?: string;
}

export function listArchive(root: string): RawFile[] {
  const out: RawFile[] = [];
  for (const d of readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(join(root, d))) {
      if (!/^[0-9a-f]{64}$/.test(f)) continue;
      const path = join(root, d, f);
      const st = statSync(path);
      out.push({ hash: f, path, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.hash.localeCompare(b.hash));
}

export interface ReplaySummary {
  files: number;
  byKind: Record<RawKind, number>;
  corrupt: string[];
  bqChunks: { loaded: number; rows: number };
  accounts: { loaded: number; rows: number };
  price: { windows: number; days: number; gaps: number };
  explorer: {
    pages: number;
    skippedAlreadyReplayed: number;
    quarantined: Array<{ hash: string; reasonCode: string; detail: string; sizeBytes: number }>;
    inserted: number;
    updated: number;
    noop: number;
    loadedToClickHouse: number;
  };
}

/** One archive root with the progress files that describe its objects. */
export interface ReplaySource {
  /** "backfill" is the main run (default price window, owner of the Explorer resume cursor); any other name is an extra root. */
  name: string;
  rawRoot: string;
  chunks: Record<string, ChunkDone>;
  accounts: Record<string, AccountChunkDone>;
}

export interface ReplayDeps {
  ch: ClickHouseClient;
  db: Db;
  sources: ReplaySource[];
  /** hashes of quarantined Explorer pages the run chose to skip (state.json explorer.skippedPageHashes) */
  skippedHashes?: string[];
  log: (m: string) => void;
}

const readBytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

export async function replayRaw(d: ReplayDeps): Promise<ReplaySummary> {
  const known = knownHashes(
    Object.assign({}, ...d.sources.map((x) => x.chunks)) as Record<string, ChunkDone>,
    Object.assign({}, ...d.sources.map((x) => x.accounts)) as Record<string, AccountChunkDone>,
  );
  const seen = new Set<string>();
  const files = d.sources
    .flatMap((src) => listArchive(src.rawRoot).map((f) => ({ ...f, source: src.name })))
    .filter((f) => !seen.has(f.hash) && !!seen.add(f.hash))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.hash.localeCompare(b.hash));
  const s: ReplaySummary = {
    files: files.length,
    byKind: { explorer: 0, "bq-chunk": 0, account: 0, price: 0, unknown: 0 },
    corrupt: [],
    bqChunks: { loaded: 0, rows: 0 },
    accounts: { loaded: 0, rows: 0 },
    price: { windows: 0, days: 0, gaps: 0 },
    explorer: {
      pages: 0,
      skippedAlreadyReplayed: 0,
      quarantined: [],
      inserted: 0,
      updated: 0,
      noop: 0,
      loadedToClickHouse: 0,
    },
  };
  const explorerFiles: RawFile[] = [];
  const priceBySource = new Map<
    string,
    Array<Parameters<typeof loadPriceFetches>[1][number] & { days: string[] }>
  >();
  const sink = makeChSink(d.ch);

  for (const f of files) {
    if (f.size > 64 * 1024 * 1024) {
      s.byKind.unknown++;
      continue;
    }
    const bytes = readBytes(f.path);
    if (sha256Hex(bytes) !== f.hash) {
      s.corrupt.push(f.hash);
      continue;
    }
    const kind = classifyRawObject(f.hash, bytes, known);
    s.byKind[kind]++;
    if (kind === "explorer") explorerFiles.push(f);
    else if (kind === "bq-chunk") {
      const c = known.chunks.get(f.hash) as ChunkDone;
      const chunk: Chunk = { id: c.id, family: c.family, from: c.from, to: c.to };
      const rows = JSON.parse(new TextDecoder().decode(bytes)) as BqRow[];
      const n = await sink(chunk, {
        status: "done",
        rows,
        estimateBytes: c.estimateBytes,
        billedBytes: c.billedBytes,
        jobId: c.jobId,
        objectHash: f.hash,
        fetchedAtUTC: c.completedAtUTC,
      });
      s.bqChunks.loaded++;
      s.bqChunks.rows += n;
      d.log(`bq ${c.id}: ${n} rows`);
    } else if (kind === "account") {
      const c = known.accounts.get(f.hash);
      if (!c) {
        d.log(`account object ${f.hash} is not in an account-state file; skipped (no chunk bounds)`);
        continue;
      }
      const rows = JSON.parse(new TextDecoder().decode(bytes)) as BqRow[];
      const n = await loadAccountChunk(d.ch, { id: c.id, from: c.from, to: c.to }, rows, {
        rawObjectHash: f.hash,
        fetchedAtUTC: c.completedAtUTC,
      });
      s.accounts.loaded++;
      s.accounts.rows += n;
      d.log(`account ${c.id}: ${n} rows`);
    } else if (kind === "price") {
      const w = priceWindowOf(bytes);
      if (!w) {
        d.log(`price object ${f.hash}: no samples; skipped`);
        continue;
      }
      const fetchedAtUTC = new Date(f.mtimeMs).toISOString();
      const { bytes: fileBytes, dailyCount, days } = dailyFileBytes(bytes, w);
      if (dailyCount === 0) {
        d.log(`price object ${f.hash}: no complete UTC day; skipped`);
        continue;
      }
      const list = priceBySource.get(f.source as string) ?? [];
      list.push({ fileBytes, fetchedAtUTC, rawObjectHash: f.hash, sourceLabel: "LIVE", days });
      priceBySource.set(f.source as string, list);
      s.price.windows++;
    }
  }

  // Price rows are keyed by update_vintage (the fetch time), which the replay can only approximate from file mtimes. An
  // object whose rows are already loaded (for example by the running scheduler) is left alone so no second vintage appears.
  const haveHashes = new Set(
    (
      (await (
        await d.ch.query({
          query: "SELECT DISTINCT raw_object_hash AS h FROM price_candles",
          format: "JSONEachRow",
        })
      ).json()) as Array<{ h: string }>
    ).map((r) => r.h),
  );
  for (const [source, all0] of priceBySource) {
    const list = all0.filter((x) => !haveHashes.has(x.rawObjectHash));
    if (list.length === 0) continue;
    const all = list.flatMap((x) => x.days).sort();
    const window = source === "backfill" ? undefined : { from: all[0] as string, to: all.at(-1) as string };
    const r = await loadPriceFetches(
      d.ch,
      list.map(({ days: _days, ...f }) => f),
      Date.now(),
      window,
    );
    s.price.days += r.days;
    s.price.gaps += r.gaps;
    d.log(`price (${source}): ${r.days} days, ${r.gaps} gap days`);
  }

  await replayExplorer(d, explorerFiles, s);
  return s;
}

async function replayExplorer(d: ReplayDeps, files: RawFile[], s: ReplaySummary): Promise<void> {
  const done = new Set(
    (
      await d.db.query<{ h: string }>(
        "SELECT DISTINCT raw_object_hash h FROM ingestion.explorer_swap_versions",
      )
    ).rows.map((r) => r.h),
  );
  const quarantined = new Set(
    (
      await d.db.query<{ h: string }>(
        "SELECT raw_object_hash h FROM ingestion.quarantine WHERE kind='explorer_page'",
      )
    ).rows.map((r) => r.h),
  );
  const skipped = new Set(d.skippedHashes ?? []);
  // Position of the backfill stream: the newest backfill page that was committed or deliberately skipped.
  let last: { hash: string; mtimeMs: number; cursor: ExplorerCursor | null; schema: string } | null = null;
  let good = 0;
  let latestEvent: string | null = null;
  for (const f of files) {
    const bytes = readBytes(f.path);
    const parsed = parseExplorerPage(bytes);
    if (!parsed.ok) {
      s.explorer.quarantined.push({
        hash: f.hash,
        reasonCode: parsed.reasonCode,
        detail: parsed.detail,
        sizeBytes: f.size,
      });
      if (!quarantined.has(f.hash))
        await d.db.query(
          "INSERT INTO ingestion.quarantine(provider_id, kind, reason_code, raw_object_hash, detail) VALUES ('near-explorer','explorer_page',$1,$2,$3)",
          [parsed.reasonCode, f.hash, JSON.stringify({ detail: parsed.detail, replayed: true })],
        );
      if (skipped.has(f.hash) && SKIPPABLE_REASONS.has(parsed.reasonCode)) {
        // Re-applies the recorded skip: gap rows only. The page itself stays quarantined and promotes no facts.
        const sv = salvagePage(bytes);
        if (sv) {
          const page = { rawObjectHash: f.hash, ...sv };
          await recordQuarantineGapCh(d.ch, page, Math.round(f.mtimeMs));
          await advancePastQuarantined(d.db, EXPLORER_STREAM, page, false);
          if (f.source === "backfill")
            last = { hash: f.hash, mtimeMs: f.mtimeMs, cursor: sv.cursor, schema: "" };
        }
      }
      continue; // never partially promoted
    }
    good++;
    s.explorer.pages++;
    const newest = parsed.items.reduce<string | null>(
      (m, t) => (m === null || t.createdAt > m ? t.createdAt : m),
      null,
    );
    if (f.source === "backfill") {
      if (newest && (latestEvent === null || newest > latestEvent)) latestEvent = newest;
      const li = parsed.items[parsed.items.length - 1];
      last = {
        hash: f.hash,
        mtimeMs: f.mtimeMs,
        cursor: li ? { lastDepositAddress: li.depositAddress, lastDepositMemo: li.depositMemo ?? "" } : null,
        schema: explorerSchemaFingerprint(parsed.items).slice(0, 16),
      };
    }
    if (done.has(f.hash)) {
      s.explorer.skippedAlreadyReplayed++;
      continue;
    }
    const tally = { inserted: 0, updated: 0, skipped: 0 };
    const at = new Date(f.mtimeMs).toISOString();
    await d.db.tx((c) => upsertSwapPage(c, parsed.items, f.hash, at, Math.round(f.mtimeMs), tally));
    s.explorer.inserted += tally.inserted;
    s.explorer.updated += tally.updated;
    s.explorer.noop += tally.skipped;
    if (good % 100 === 0) d.log(`explorer pages replayed: ${good}/${files.length}`);
  }
  if (last) {
    // Lets a later Explorer resume continue after the newest archived page instead of from page 1. Never overwrites a
    // cursor that already exists, so a running or already resumed backfill keeps its own position.
    await d.db.query(
      `INSERT INTO ingestion.cursor_state(provider_id, stream_key, cursor, page_hash, retrieved_at, schema_version, latest_event_time, pages_committed, updated_at)
       VALUES ('near-explorer',$1,$2,$3,$4,$5,$6,$7,$4)
       ON CONFLICT (provider_id, stream_key) DO NOTHING`,
      [
        EXPLORER_STREAM,
        last.cursor ? JSON.stringify(last.cursor) : null,
        last.hash,
        new Date(last.mtimeMs).toISOString(),
        last.schema || null,
        latestEvent,
        good,
      ],
    );
  }
  // The keyset loader orders by (version_ms, swap_key); without this index every batch sorts the whole table.
  await d.db.query(
    "CREATE INDEX IF NOT EXISTS explorer_swaps_version_idx ON ingestion.explorer_swaps (version_ms, swap_key)",
  );
  // Local cursor: never touches state.json, so the full table is re-read and re-inserted (ReplacingMergeTree dedups).
  const local = {
    state: { explorerLoad: undefined as { afterVersionMs: number; afterKey: string } | undefined },
    save: () => undefined,
  };
  s.explorer.loadedToClickHouse = await loadSwapsToClickHouse(d.db, d.ch, local, Date.now());
}
