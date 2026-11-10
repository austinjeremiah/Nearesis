import { IngestionError } from "../errors.ts";
import {
  BigQueryGuard,
  BQ_ADAPTER_VERSION,
  type BigQueryJobLike,
  type BigQueryLike,
  type Discovery,
} from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import { BudgetLedger, MIB } from "./budget.ts";
import { billedByJobsSql, billedSinceSql, chunkSql } from "./sql.ts";
import type { Chunk } from "./plan.ts";

export const BUDGET_PROBE_CAP_BYTES = 100 * 1_000_000; // INFORMATION_SCHEMA reads must stay under 100 MB

export type BqRow = Record<string, unknown>;

export type ChunkOutcome =
  | {
      status: "done";
      rows: BqRow[];
      estimateBytes: number;
      billedBytes: number;
      jobId: string | null;
      objectHash: string;
      fetchedAtUTC: string;
    }
  | { status: "budget"; estimateBytes: number; remaining: number; reason: string };

/** BigQuery access for the backfill: dry run, 2% fit check, maximumBytesBilled = ceil(estimate x 1.1), per-chunk accounting. */
export class BudgetedBigQuery {
  readonly dryRuns: Array<{ id: string; estimate: number }> = [];
  jobs = 0;
  constructor(
    private readonly bq: BigQueryLike,
    private readonly archive: RawArchive,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  discover(principal: string | null): Promise<Discovery> {
    return new BigQueryGuard(this.bq).discover(principal);
  }

  private async dryRun(sql: string, location: string): Promise<number> {
    const [dry] = await this.bq.createQueryJob({ query: sql, dryRun: true, location, useQueryCache: false });
    const est = Number(
      dry.metadata.statistics?.totalBytesProcessed ??
        dry.metadata.statistics?.query?.totalBytesProcessed ??
        Number.NaN,
    );
    if (!Number.isFinite(est))
      throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
    return est;
  }

  /**
   * Bytes billed to the project since `sinceIso` by all jobs (summed over the dataset region and the `us` multi-region when
   * reachable). Itself a tiny, dry-run, <=100 MB-capped query.
   */
  async billedSince(
    location: string,
    sinceIso: string,
  ): Promise<{ bytes: number; jobs: number; regions: string[] }> {
    let bytes = 0;
    let jobs = 0;
    const regions: string[] = [];
    for (const [i, region] of [location, "us"].entries()) {
      if (i === 1 && region === location) continue;
      const sql = billedSinceSql(region, sinceIso);
      try {
        const est = await this.dryRun(sql, region);
        if (est > BUDGET_PROBE_CAP_BYTES)
          throw new IngestionError("BQ_REJECTED", false, {
            reason: "budget probe estimate above 100 MB",
            est,
          });
        const [job] = await this.bq.createQueryJob({
          query: sql,
          location: region,
          maximumBytesBilled: String(BUDGET_PROBE_CAP_BYTES),
          useQueryCache: false,
          labels: { source: "nearesis_backfill_budget" },
        });
        const [rows] = await job.getQueryResults();
        this.jobs++;
        // plus this probe's own billing (conservative: it may already be inside the reading)
        bytes +=
          Number(rows[0]?.billed_bytes ?? 0) + Number(job.metadata.statistics?.query?.totalBytesBilled ?? 0);
        jobs += Number(rows[0]?.jobs ?? 0);
        regions.push(region);
      } catch (e) {
        // The dataset region reading is mandatory; the extra multi-region reading is best effort.
        if (i === 0) throw e;
      }
    }
    return { bytes, jobs, regions };
  }

  /** Actual total_bytes_billed per job id, straight from INFORMATION_SCHEMA (dry run + 100 MB cap). */
  async billedByJobs(location: string, sinceIso: string, jobIds: string[]): Promise<Map<string, number>> {
    const sql = billedByJobsSql(location, sinceIso, jobIds);
    const est = await this.dryRun(sql, location);
    if (est > BUDGET_PROBE_CAP_BYTES)
      throw new IngestionError("BQ_REJECTED", false, { reason: "reconcile estimate above 100 MB", est });
    const [job] = await this.bq.createQueryJob({
      query: sql,
      location,
      maximumBytesBilled: String(BUDGET_PROBE_CAP_BYTES),
      useQueryCache: false,
      labels: { source: "nearesis_backfill_budget" },
    });
    const [rows] = await job.getQueryResults();
    this.jobs++;
    return new Map(rows.map((r) => [String(r.job_id), Number(r.total_bytes_billed)]));
  }

  async runChunk(chunk: Chunk, ledger: BudgetLedger, location: string): Promise<ChunkOutcome> {
    const sql = chunkSql(chunk);
    assertGuardedSql(sql); // never without a finite block_date partition filter
    const estimate = await this.dryRun(sql, location);
    this.dryRuns.push({ id: chunk.id, estimate });
    const fit = ledger.check(estimate);
    if (!fit.ok)
      return { status: "budget", estimateBytes: estimate, remaining: fit.remaining, reason: fit.reason };
    const [job] = await this.bq.createQueryJob({
      query: sql,
      location,
      maximumBytesBilled: String(fit.maximumBytesBilled),
      useQueryCache: false,
      labels: { source: "nearesis_backfill" },
    });
    const [rows] = await job.getQueryResults();
    this.jobs++;
    let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
    if (!Number.isFinite(billed)) {
      // The result call can return before the job statistics are populated: refresh the job metadata.
      const refresh = (job as { getMetadata?: () => Promise<[BigQueryJobLike["metadata"]]> }).getMetadata;
      if (refresh) {
        const [m] = await refresh.call(job);
        billed = Number(m.statistics?.query?.totalBytesBilled ?? Number.NaN);
      }
    }
    // A missing billed figure must never be treated as free: assume the cap was consumed (conservative).
    const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled;
    ledger.record(chunk.id, estimate, billedBytes);
    const now = new Date(this.clock()).toISOString();
    const payload = new TextEncoder().encode(JSON.stringify(rows));
    const a = await this.archive.archive({
      providerId: "near-bigquery",
      adapterVersion: BQ_ADAPTER_VERSION,
      method: "POST",
      url: "https://bigquery.googleapis.com/bigquery/v2/jobs",
      requestBody: { sql },
      sourceEnvironment: "live",
      fetchedAtUTC: now,
      receivedAtUTC: now,
      providerEventAtUTC: null,
      providerEventAtNullReason: "query result set has no single provider event time",
      responseStatus: 200,
      contentType: "application/json",
      payload,
      recordsClaimed: rows.length,
      recordsParsed: rows.length,
      privacyVisibility: "public",
      completeness: "complete",
    });
    return {
      status: "done",
      rows,
      estimateBytes: estimate,
      billedBytes,
      jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
      objectHash: a.observation.payloadObjectHash,
      fetchedAtUTC: now,
    };
  }
}

export const mib = (bytes: number): number => Math.round((bytes / MIB) * 100) / 100;
