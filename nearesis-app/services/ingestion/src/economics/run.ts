import type { ClickHouseClient } from "@clickhouse/client";
import { IngestionError } from "../errors.ts";
import { BQ_ADAPTER_VERSION, type BigQueryLike } from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import { sha256Hex } from "../hash.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import { MIB } from "../backfill/budget.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { loadEconomicsChunk } from "./load.ts";
import { economicsSql, splitChunk, type EconomicsChunk } from "./sql.ts";

export interface EconomicsDryRun {
  id: string;
  family: string;
  from: string;
  to: string;
  estimateBytes: number;
  sqlSha256: string;
}

/** Digest of the exact SQL text of every planned chunk. The owner approves this digest; a billed run must present it. */
export function planDigest(chunks: EconomicsChunk[]): string {
  return sha256Hex(chunks.map((c) => `${c.id}\n${economicsSql(c)}`).join("\n----\n"));
}

const bytesOf = (m: {
  statistics?: { totalBytesProcessed?: unknown; query?: { totalBytesProcessed?: unknown } };
}): number =>
  Number(m.statistics?.totalBytesProcessed ?? m.statistics?.query?.totalBytesProcessed ?? Number.NaN);

/** FREE: one dry run per chunk (dryRun: true bills nothing). */
export async function dryRunEconomics(d: {
  bq: BigQueryLike;
  location: string;
  chunks: EconomicsChunk[];
}): Promise<EconomicsDryRun[]> {
  const out: EconomicsDryRun[] = [];
  for (const c of d.chunks) {
    const sql = economicsSql(c);
    assertGuardedSql(sql);
    const [job] = await d.bq.createQueryJob({
      query: sql,
      dryRun: true,
      location: d.location,
      useQueryCache: false,
    });
    const est = bytesOf(job.metadata);
    if (!Number.isFinite(est))
      throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
    out.push({
      id: c.id,
      family: c.family,
      from: c.from,
      to: c.to,
      estimateBytes: est,
      sqlSha256: sha256Hex(sql),
    });
  }
  return out;
}

export interface QuotaPlanDay {
  day: number;
  chunks: string[];
  bytes: number;
}

/**
 * Greedy, order-preserving packing of dry-run estimates into quota days (each day: estimate x 1.02 <= limit, the same rule
 * as BudgetLedger.check). A chunk larger than a whole day never fits and is reported in `oversize`.
 */
export function packIntoQuotaDays(
  dry: Array<Pick<EconomicsDryRun, "id" | "estimateBytes">>,
  limitBytes: number,
  alreadyBilledFirstDay = 0,
): { days: QuotaPlanDay[]; oversize: string[] } {
  const days: QuotaPlanDay[] = [];
  const oversize: string[] = [];
  let cur: QuotaPlanDay = { day: 1, chunks: [], bytes: alreadyBilledFirstDay };
  for (const c of dry) {
    if ((c.estimateBytes * 102) / 100 > limitBytes) {
      oversize.push(c.id);
      continue;
    }
    if (((cur.bytes + c.estimateBytes) * 102) / 100 > limitBytes && cur.chunks.length > 0) {
      days.push(cur);
      cur = { day: cur.day + 1, chunks: [], bytes: 0 };
    }
    cur.chunks.push(c.id);
    cur.bytes += c.estimateBytes;
  }
  if (cur.chunks.length > 0) days.push(cur);
  return { days, oversize };
}

export const toGiB = (b: number): string => (b / (1024 * MIB)).toFixed(2);

export interface EconomicsDone {
  id: string;
  rows: number;
  estimateBytes: number;
  billedBytes: number;
  jobId: string | null;
  rawObjectHash: string;
  completedAtUTC: string;
  quotaDay: string;
}

export interface EconomicsPhaseResult {
  completed: string[];
  skippedForBudget: Array<{ id: string; estimateBytes: number }>;
}

/**
 * BILLED runner (same pattern as runAccountPhase). Refuses to run unless `approvalDigest` equals planDigest(chunks), i.e. the
 * owner approved exactly this SQL. NOT executed in A18: no billed query without owner approval.
 */
export async function runEconomicsPhase(d: {
  bq: BigQueryLike;
  archive: RawArchive;
  ch: ClickHouseClient;
  ledger: BudgetLedger;
  location: string;
  chunks: EconomicsChunk[];
  approvalDigest: string | undefined;
  isDone: (id: string) => boolean;
  markDone: (r: EconomicsDone) => void;
  nowMs?: () => number;
  log?: (m: string) => void;
}): Promise<EconomicsPhaseResult> {
  if (!d.approvalDigest || d.approvalDigest !== planDigest(d.chunks))
    throw new IngestionError("BQ_REJECTED", false, {
      reason: "owner approval digest missing or does not match the planned SQL",
    });
  const log = d.log ?? (() => undefined);
  const now = d.nowMs ?? (() => Date.now());
  const res: EconomicsPhaseResult = { completed: [], skippedForBudget: [] };
  for (const chunk of d.chunks) {
    if (d.isDone(chunk.id)) continue;
    const sql = economicsSql(chunk);
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
    const fit = d.ledger.check(est);
    if (!fit.ok) {
      res.skippedForBudget.push({ id: chunk.id, estimateBytes: est });
      log(`skip ${chunk.id}: est ${est} B, remaining ${fit.remaining} B`);
      continue;
    }
    const [job] = await d.bq.createQueryJob({
      query: sql,
      location: d.location,
      maximumBytesBilled: String(fit.maximumBytesBilled),
      useQueryCache: false,
      labels: { source: "nearesis_economics_backfill" },
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
    const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled; // unknown is never free
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
    const loaded = await loadEconomicsChunk(d.ch, chunk, rows, { rawObjectHash: hash, fetchedAtUTC: iso });
    d.markDone({
      id: chunk.id,
      rows: loaded,
      estimateBytes: est,
      billedBytes,
      jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
      rawObjectHash: hash,
      completedAtUTC: iso,
      quotaDay: quotaDayStart(now()).toISOString().slice(0, 10),
    });
    res.completed.push(chunk.id);
    log(`done ${chunk.id}: ${loaded} rows, billed ${billedBytes} B`);
  }
  return res;
}

/**
 * FREE: dry-runs each chunk and recursively halves any chunk whose estimate (x 1.02) exceeds one quota day, so every chunk of
 * the returned plan can be run inside a single day's budget. Single-day chunks that still exceed are returned as-is (the
 * packer reports them as oversize).
 */
export async function planFittingChunks(d: {
  bq: BigQueryLike;
  location: string;
  chunks: EconomicsChunk[];
  limitBytes: number;
}): Promise<{ chunks: EconomicsChunk[]; dry: EconomicsDryRun[] }> {
  const chunks: EconomicsChunk[] = [];
  const dry: EconomicsDryRun[] = [];
  const visit = async (c: EconomicsChunk): Promise<void> => {
    const [r] = await dryRunEconomics({ bq: d.bq, location: d.location, chunks: [c] });
    const halves = (r as EconomicsDryRun).estimateBytes * 1.02 > d.limitBytes ? splitChunk(c) : null;
    if (halves) {
      await visit(halves[0]);
      await visit(halves[1]);
    } else {
      chunks.push(c);
      dry.push(r as EconomicsDryRun);
    }
  };
  for (const c of d.chunks) await visit(c);
  return { chunks, dry };
}
