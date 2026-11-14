import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { IngestionError } from "../errors.ts";
import { BQ_ADAPTER_VERSION, type BigQueryLike } from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { loadAccountScan } from "./load.ts";
import { accountScanSql, sqlDigest, type AccountScanChunk, type MappingInput } from "./sql.ts";

/** Owner approval 2026-11-13: one per-signer family is approved only if its free dry-run total is at most 40 GiB. */
export const OWNER_APPROVED_MAX_BYTES = 40 * 1024 ** 3;

export interface AccountScanDone {
  id: string;
  from: string;
  to: string;
  rows: number;
  estimateBytes: number;
  billedBytes: number;
  jobId: string | null;
  rawObjectHash: string;
  sqlSha256: string;
  completedAtUTC: string;
  quotaDay: string;
}

/** Own checkpoint file (atomic write); a completed scan is never re-run (a re-run would bill again). */
export class AccountScanState {
  chunks: Record<string, AccountScanDone> = {};
  constructor(readonly path: string) {
    try {
      this.chunks =
        (JSON.parse(readFileSync(path, "utf8")) as { chunks?: Record<string, AccountScanDone> }).chunks ?? {};
    } catch {
      this.chunks = {};
    }
  }
  isDone = (id: string): boolean => this.chunks[id] !== undefined;
  markDone(c: AccountScanDone): void {
    this.chunks[c.id] = c;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, chunks: this.chunks }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

export type AccountScanOutcome =
  | { status: "done"; done: AccountScanDone }
  | { status: "over_approval"; estimateBytes: number; approvedMaxBytes: number }
  | { status: "budget"; estimateBytes: number; remaining: number; reason: string }
  | { status: "already_done"; done: AccountScanDone };

const bytesOf = (m: {
  statistics?: { totalBytesProcessed?: unknown; query?: { totalBytesProcessed?: unknown } };
}): number =>
  Number(m.statistics?.totalBytesProcessed ?? m.statistics?.query?.totalBytesProcessed ?? Number.NaN);

/**
 * BILLED runner for one scan. Order: free dry run -> refuse above the owner-approved ceiling -> shared quota ledger fit
 * (estimate x 1.02 <= remaining of the 95% daily guard) -> job with maximumBytesBilled = ceil(estimate x 1.1) -> archive raw
 * rows -> validate identities and load -> checkpoint. Unknown billed bytes are never treated as free.
 */
export async function runAccountScan(d: {
  bq: BigQueryLike;
  archive: RawArchive;
  ch: ClickHouseClient;
  ledger: BudgetLedger;
  state: AccountScanState;
  location: string;
  chunk: AccountScanChunk;
  mappings: MappingInput[];
  registryVersion: string;
  head: number;
  maxApprovedBytes?: number;
  nowMs?: () => number;
  log?: (m: string) => void;
}): Promise<AccountScanOutcome> {
  const log = d.log ?? (() => undefined);
  const now = d.nowMs ?? (() => Date.now());
  const prior = d.state.chunks[d.chunk.id];
  if (prior) return { status: "already_done", done: prior };
  const sql = accountScanSql(d.chunk, d.mappings, d.head);
  assertGuardedSql(sql);
  const [dry] = await d.bq.createQueryJob({
    query: sql,
    dryRun: true,
    location: d.location,
    useQueryCache: false,
  });
  const est = bytesOf(dry.metadata);
  if (!Number.isFinite(est))
    throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
  const ceiling = d.maxApprovedBytes ?? OWNER_APPROVED_MAX_BYTES;
  if (est > ceiling) return { status: "over_approval", estimateBytes: est, approvedMaxBytes: ceiling };
  const fit = d.ledger.check(est);
  if (!fit.ok) return { status: "budget", estimateBytes: est, remaining: fit.remaining, reason: fit.reason };
  log(
    `running ${d.chunk.id}: est ${est} B, max billed ${fit.maximumBytesBilled} B, sql ${sqlDigest(sql).slice(0, 12)}`,
  );
  const [job] = await d.bq.createQueryJob({
    query: sql,
    location: d.location,
    maximumBytesBilled: String(fit.maximumBytesBilled),
    useQueryCache: false,
    labels: { source: "nearesis_account_scan" },
  });
  const [rows] = await job.getQueryResults();
  let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
  if (!Number.isFinite(billed)) {
    const refresh = (
      job as { getMetadata?: () => Promise<[{ statistics?: { query?: { totalBytesBilled?: unknown } } }]> }
    ).getMetadata;
    if (refresh) {
      const [m] = await refresh.call(job);
      billed = Number(m.statistics?.query?.totalBytesBilled ?? Number.NaN);
    }
  }
  const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled;
  d.ledger.record(d.chunk.id, est, billedBytes);
  const iso = new Date(now()).toISOString();
  const a = await d.archive.archive({
    providerId: "near-bigquery",
    adapterVersion: BQ_ADAPTER_VERSION,
    method: "POST",
    url: "https://bigquery.googleapis.com/bigquery/v2/jobs",
    requestBody: { sql },
    sourceEnvironment: "live",
    fetchedAtUTC: iso,
    receivedAtUTC: iso,
    providerEventAtUTC: null,
    providerEventAtNullReason: "query result set has no single provider event time",
    responseStatus: 200,
    contentType: "application/json",
    payload: new TextEncoder().encode(JSON.stringify(rows)),
    recordsClaimed: rows.length,
    recordsParsed: rows.length,
    privacyVisibility: "public",
    completeness: "complete",
  });
  const hash = a.observation.payloadObjectHash;
  const loaded = await loadAccountScan(
    d.ch,
    d.chunk,
    rows,
    { rawObjectHash: hash, fetchedAtUTC: iso },
    { head: d.head, registryVersion: d.registryVersion },
  );
  const done: AccountScanDone = {
    id: d.chunk.id,
    from: d.chunk.from,
    to: d.chunk.to,
    rows: loaded.rows,
    estimateBytes: est,
    billedBytes,
    jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
    rawObjectHash: hash,
    sqlSha256: sqlDigest(sql),
    completedAtUTC: iso,
    quotaDay: quotaDayStart(now()).toISOString().slice(0, 10),
  };
  d.state.markDone(done);
  return { status: "done", done };
}

/**
 * One-day validation run of the same SQL (billed: about 0.1 GiB or less). Nothing is archived or loaded; the rows are parsed with the
 * same identity checks and returned so the caller can compare them with account_daily_activity before the full scan.
 */
export async function smokeAccountScan(d: {
  bq: BigQueryLike;
  ledger: BudgetLedger;
  location: string;
  day: string;
  nextDay: string;
  mappings: MappingInput[];
  head: number;
}): Promise<{ rows: Array<Record<string, unknown>>; estimateBytes: number; billedBytes: number }> {
  const sql = accountScanSql({ from: d.day, to: d.nextDay }, d.mappings, d.head);
  assertGuardedSql(sql);
  const [dry] = await d.bq.createQueryJob({
    query: sql,
    dryRun: true,
    location: d.location,
    useQueryCache: false,
  });
  const est = bytesOf(dry.metadata);
  if (!Number.isFinite(est) || est > 2 * 1024 ** 3)
    throw new IngestionError("BQ_REJECTED", false, { reason: "smoke estimate missing or above 2 GiB", est });
  const fit = d.ledger.check(est);
  if (!fit.ok) throw new IngestionError("BQ_REJECTED", false, { reason: fit.reason });
  const [job] = await d.bq.createQueryJob({
    query: sql,
    location: d.location,
    maximumBytesBilled: String(fit.maximumBytesBilled),
    useQueryCache: false,
    labels: { source: "nearesis_account_scan_smoke" },
  });
  const [rows] = await job.getQueryResults();
  let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
  if (!Number.isFinite(billed)) {
    const refresh = (
      job as { getMetadata?: () => Promise<[{ statistics?: { query?: { totalBytesBilled?: unknown } } }]> }
    ).getMetadata;
    if (refresh)
      billed = Number((await refresh.call(job))[0].statistics?.query?.totalBytesBilled ?? Number.NaN);
  }
  return { rows, estimateBytes: est, billedBytes: Number.isFinite(billed) ? billed : fit.maximumBytesBilled };
}
