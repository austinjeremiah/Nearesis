import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * Live research capsule input (ch.02, ch.08). A pinned live snapshot (services/research `live-freeze`, B3) holds the
 * executed ClickHouse queries and their result files. This turns it into a capsule snapshot directory
 * (`nearesis.snapshot.v1`, label LIVE): the executed result files are carried byte for byte, the pinned snapshot descriptor
 * (queries, window, data hash) travels as `raw/live-snapshot.json`, and the two verifier series are DERIVED from executed
 * results only:
 *   intents_volume_usd_cents = round(swaps.vol * 100)       (query `swaps`, successful swaps with a USD amount)
 *   organic_tx               = account_daily_activity.tx_organic   (query `account_daily_activity`)
 * so every number in the capsule resolves to an executed query, its result file hash and the source snapshot id.
 */
export const LIVE_SNAPSHOT_FILE = "raw/live-snapshot.json";
export const LIVE_SERIES_FILE = "raw/daily_series.csv";

/** Queries whose results feed each result family; the publish manifest's lineage is built from this table. */
export const LIVE_INPUTS = {
  series: ["account_daily_activity", "swaps"],
  research: ["account_daily_activity", "price", "swaps"],
} as const;

export interface LiveSnapshotFile {
  dataHash: string;
  database: string;
  frozenAt: string;
  inputMethod: string;
  snapshotId: string;
  window: { start: string; end: string };
  files: Record<string, { bytes: number; path: string; rows: number; sha256: string }>;
  queries: Record<string, string>;
  swapWindowRule?: unknown;
}

export interface LiveQueryExecution {
  queryId: string;
  sql: string;
  database: string;
  params: { s: string; e: string };
  resultFile: string;
  resultSha256: string;
  rows: number;
}

export const liveQueryId = (name: string): string => `q-${name}`;

export function parseLiveSnapshot(b: Buffer | string): LiveSnapshotFile {
  const j = JSON.parse(b.toString()) as LiveSnapshotFile;
  if (!j.snapshotId || !j.queries || !j.files || !j.window) throw new Error("not a pinned live snapshot");
  return j;
}

/** The executed queries recorded by the pinned snapshot, with their parameters and result file hashes. */
export function liveExecutions(live: LiveSnapshotFile): LiveQueryExecution[] {
  return Object.keys(live.queries)
    .sort()
    .map((name) => {
      const f = live.files[name];
      if (!f) throw new Error(`live snapshot has a query ${name} without a result file`);
      return {
        queryId: liveQueryId(name),
        sql: live.queries[name]!,
        database: live.database,
        params: { s: live.window.start, e: live.window.end },
        resultFile: f.path,
        resultSha256: f.sha256,
        rows: f.rows,
      };
    });
}

const dateOf = (v: unknown): string => String(v);

/** Deterministic CSV of the two verifier series from the executed results (no float noise: integers only). */
export function liveSeriesCsv(swaps: Buffer, activity: Buffer): Buffer {
  const sw = JSON.parse(swaps.toString()) as Array<{ d: string; vol: number }>;
  const ac = JSON.parse(activity.toString()) as Array<{ d: string; tx_organic: number }>;
  const organic = new Map(ac.map((r) => [dateOf(r.d), r.tx_organic]));
  const rows = ["date,intents_volume_usd_cents,organic_tx"];
  for (const r of sw) {
    const y = organic.get(dateOf(r.d));
    if (y === undefined) throw new Error(`no organic transaction count for ${r.d}`);
    if (!Number.isInteger(y)) throw new Error(`organic_tx for ${r.d} is not an integer`);
    rows.push(`${r.d},${Math.round(r.vol * 100)},${y}`);
  }
  return Buffer.from(`${rows.join("\n")}\n`);
}

export interface LiveCapsuleInputOptions {
  /** `docs/research/live-snapshots/<id>` */
  liveSnapshotDir: string;
  /** Empty or new directory that receives the capsule snapshot directory. */
  outDir: string;
  analysisCodeCommit: string;
  claimId?: string;
}

/** Writes the capsule snapshot directory for a pinned live snapshot. Verifies every executed result against its hash. */
export function buildLiveCapsuleInput(o: LiveCapsuleInputOptions): { snapshotId: string; dataHash: string } {
  const descBytes = readFileSync(join(o.liveSnapshotDir, "snapshot.json"));
  const live = parseLiveSnapshot(descBytes);
  const raw = new Map<string, Buffer>();
  for (const [name, f] of Object.entries(live.files)) {
    const b = readFileSync(join(o.liveSnapshotDir, f.path));
    if (sha256Hex(b) !== f.sha256 || b.length !== f.bytes)
      throw new Error(`executed result ${name} differs from the pinned hash`);
    raw.set(f.path, b);
  }
  const csv = liveSeriesCsv(raw.get("raw/swaps.json")!, raw.get("raw/account_daily_activity.json")!);
  const files: Array<{ path: string; bytes: Buffer }> = [
    { path: LIVE_SERIES_FILE, bytes: csv },
    { path: LIVE_SNAPSHOT_FILE, bytes: descBytes },
    ...[...raw.entries()].sort().map(([path, bytes]) => ({ path, bytes })),
  ];
  const descriptor = {
    schema: "nearesis.snapshot.v1",
    snapshotId: live.snapshotId,
    label: "LIVE",
    frozenAt: live.frozenAt,
    dataset: `nearesis_live ClickHouse, pinned snapshot (${live.inputMethod})`,
    claimId: o.claimId ?? "near:intents-organic-forecast",
    analysisCodeCommit: o.analysisCodeCommit,
    series: {
      file: LIVE_SERIES_FILE,
      x: { column: "intents_volume_usd_cents", name: "intents_volume_usd", unit: "usd_cents" },
      y: { column: "organic_tx", name: "organic_transactions", unit: "transactions" },
    },
    metrics: ["lag_pearson:1", "lag_pearson:7", "pearson", "summary"],
    files: files.map((f) => ({ path: f.path, sha256: sha256Hex(f.bytes), bytes: f.bytes.length })),
  };
  for (const f of files) {
    const p = join(o.outDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(o.outDir, "snapshot.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { snapshotId: live.snapshotId, dataHash: live.dataHash };
}

/** `sources/queries.json` of a live bundle: what ran, with which parameters, and which result file hash it produced. */
export function liveQueriesDocument(live: LiveSnapshotFile): string {
  return `${canonicalJson({
    schema: "nearesis.executed-queries.v1",
    snapshotId: live.snapshotId,
    sourceDataHash: live.dataHash,
    database: live.database,
    window: live.window,
    queries: liveExecutions(live).map((q) => ({
      queryId: q.queryId,
      resultFile: q.resultFile,
      resultSha256: q.resultSha256,
      rows: q.rows,
      params: q.params,
      sqlSha256: sha256Hex(q.sql),
    })),
    derived: {
      [LIVE_SERIES_FILE]:
        "intents_volume_usd_cents = round(swaps.vol * 100); organic_tx = account_daily_activity.tx_organic; joined on date",
    },
    inputs: LIVE_INPUTS,
  })}\n`;
}
