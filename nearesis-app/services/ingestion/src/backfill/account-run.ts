import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { IngestionError } from "../errors.ts";
import { BQ_ADAPTER_VERSION, type BigQueryLike } from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import type { BudgetLedger } from "./budget.ts";
import { loadAccountChunk } from "./account-load.ts";
import { accountSql, type AccountChunk } from "./account-sql.ts";
import { quotaDayStart } from "./plan.ts";

export interface AccountChunkDone {
  id: string;
  from: string;
  to: string;
  rows: number;
  dayRows: number;
  estimateBytes: number;
  billedBytes: number;
  jobId: string | null;
  rawObjectHash: string;
  completedAtUTC: string;
  quotaDay: string;
}

/** Own checkpoint file (atomic write), separate from the main backfill state so the two never race. */
export class AccountStateStore {
  chunks: Record<string, AccountChunkDone> = {};
  constructor(readonly path: string) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { chunks?: Record<string, AccountChunkDone> };
      this.chunks = j.chunks ?? {};
    } catch {
      this.chunks = {};
    }
  }
  isDone = (id: string): boolean => this.chunks[id] !== undefined;
  markDone(c: AccountChunkDone): void {
    this.chunks[c.id] = c;
    mkdirSync(dirname(this.path), { recursive: true });
    const byDay: Record<string, number> = {};
    for (const x of Object.values(this.chunks)) byDay[x.quotaDay] = (byDay[x.quotaDay] ?? 0) + x.billedBytes;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, chunks: this.chunks, billedByQuotaDay: byDay }, null, 2)}\n`,
    );
    renameSync(tmp, this.path);
  }
}

export interface AccountPhaseResult {
  completed: string[];
  skippedForBudget: Array<{ id: string; estimateBytes: number }>;
  remaining: string[];
  dryRun: Array<{ id: string; estimateBytes: number; fits: boolean }>;
}

/**
 * Runs pending account chunks: dry run, 2% fit check against the shared ledger (INFORMATION_SCHEMA based, all jobs of the
 * project), maximumBytesBilled = ceil(estimate x 1.1), archive of the raw result, idempotent load, checkpoint.
 * With `dryOnly` nothing billed runs: only free dry runs are made.
 */
export async function runAccountPhase(d: {
  bq: BigQueryLike;
  archive: RawArchive;
  ch: ClickHouseClient | null;
  store: AccountStateStore;
  ledger: BudgetLedger;
  location: string;
  chunks: AccountChunk[];
  dryOnly?: boolean;
  nowMs?: () => number;
  log?: (m: string) => void;
}): Promise<AccountPhaseResult> {
  const log = d.log ?? (() => undefined);
  const now = d.nowMs ?? (() => Date.now());
  const res: AccountPhaseResult = { completed: [], skippedForBudget: [], remaining: [], dryRun: [] };
  for (const chunk of d.chunks) {
    if (d.store.isDone(chunk.id)) continue;
    const sql = accountSql(chunk);
    assertGuardedSql(sql);
    const [dry] = await d.bq.createQueryJob({
      query: sql,
      dryRun: true,
      location: d.location,
      useQueryCache: false,
    });
    const est = Number(
      dry.metadata.statistics?.totalBytesProcessed ??
        dry.metadata.statistics?.query?.totalBytesProcessed ??
        Number.NaN,
    );
    if (!Number.isFinite(est))
      throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
    const fit = d.ledger.check(est);
    res.dryRun.push({ id: chunk.id, estimateBytes: est, fits: fit.ok });
    if (d.dryOnly) continue;
    if (!fit.ok) {
      res.skippedForBudget.push({ id: chunk.id, estimateBytes: est });
      log(`skip ${chunk.id}: est ${est} B, remaining ${fit.remaining} B`);
      continue;
    }
    if (!d.ch)
      throw new IngestionError("INVALID_INPUT", false, {
        reason: "ClickHouse client required for a billed run",
      });
    const [job] = await d.bq.createQueryJob({
      query: sql,
      location: d.location,
      maximumBytesBilled: String(fit.maximumBytesBilled),
      useQueryCache: false,
      labels: { source: "nearesis_account_backfill" },
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
    const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled; // never treat unknown as free
    d.ledger.record(chunk.id, est, billedBytes);
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
    const loaded = await loadAccountChunk(d.ch, chunk, rows, { rawObjectHash: hash, fetchedAtUTC: iso });
    d.store.markDone({
      id: chunk.id,
      from: chunk.from,
      to: chunk.to,
      rows: loaded,
      dayRows: rows.filter((r: { kind?: unknown }) => r.kind === "day").length,
      estimateBytes: est,
      billedBytes,
      jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
      rawObjectHash: hash,
      completedAtUTC: iso,
      quotaDay: quotaDayStart(now()).toISOString().slice(0, 10),
    });
    res.completed.push(chunk.id);
    log(`done ${chunk.id}: ${loaded} rows, billed ${billedBytes} B, today ${d.ledger.billedToday} B`);
  }
  res.remaining = d.chunks.filter((c) => !d.store.isDone(c.id)).map((c) => c.id);
  return res;
}
