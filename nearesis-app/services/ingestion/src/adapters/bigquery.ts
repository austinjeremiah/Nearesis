import { IngestionError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import { MAX_BYTES_BILLED_CAP, assertGuardedSql, NEAR_DATASET } from "./bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";

export const BQ_ADAPTER_VERSION = "near-bigquery-1.0.0";

/** Minimal surface of @google-cloud/bigquery used here, so the guard can be tested with a counting double. */
export interface BigQueryLike {
  getProjectId(): Promise<string>;
  createQueryJob(opts: {
    query: string;
    dryRun?: boolean;
    location?: string;
    maximumBytesBilled?: string;
    useQueryCache?: boolean;
    labels?: Record<string, string>;
  }): Promise<[BigQueryJobLike]>;
  getDatasetMetadata(projectId: string, datasetId: string): Promise<{ location?: string }>;
}
export interface BigQueryJobLike {
  id?: string;
  metadata: {
    statistics?: {
      totalBytesProcessed?: string;
      query?: { totalBytesBilled?: string; totalBytesProcessed?: string };
    };
    user_email?: string;
    jobReference?: { jobId?: string; location?: string };
    configuration?: { query?: { maximumBytesBilled?: string } };
  };
  getQueryResults(): Promise<[Array<Record<string, unknown>>]>;
}

export interface Discovery {
  billingProject: string;
  datasetLocation: string;
  credentialPrincipal: string | null;
}

export interface GuardedRun {
  rows: Array<Record<string, unknown>>;
  jobId: string | null;
  estimateBytes: number;
  billedBytes: number;
  userEmail: string | null;
  location: string;
  payload: Uint8Array;
}

export class BigQueryGuard {
  /** Counters prove "0 jobs executed" on rejection. */
  dryRunsExecuted = 0;
  jobsExecuted = 0;
  billedBytesTotal = 0;
  constructor(
    private readonly bq: BigQueryLike,
    readonly limits: { perQueryBytes: number; totalBytes: number; maxBilledJobs: number } = {
      perQueryBytes: MAX_BYTES_BILLED_CAP,
      totalBytes: 2 * MAX_BYTES_BILLED_CAP,
      maxBilledJobs: 3,
    },
  ) {
    if (limits.perQueryBytes > MAX_BYTES_BILLED_CAP)
      throw new IngestionError("BQ_REJECTED", false, { reason: "per-query cap above 1 GiB" });
  }

  /** Identity, project and location come from the runtime, never from constants. */
  async discover(credentialPrincipal: string | null = null): Promise<Discovery> {
    const billingProject = await this.bq.getProjectId();
    const meta = await this.bq.getDatasetMetadata("bigquery-public-data", NEAR_DATASET);
    if (!meta.location)
      throw new IngestionError("BQ_REJECTED", false, { reason: "dataset location not discoverable" });
    return { billingProject, datasetLocation: meta.location, credentialPrincipal };
  }

  async run(sql: string, location: string, opts: { executeCapBytes?: number } = {}): Promise<GuardedRun> {
    assertGuardedSql(sql); // throws BQ_REJECTED before any job exists
    const cap = Math.min(opts.executeCapBytes ?? this.limits.perQueryBytes, this.limits.perQueryBytes);
    this.dryRunsExecuted++;
    const [dry] = await this.bq.createQueryJob({ query: sql, dryRun: true, location, useQueryCache: false });
    const estimate = Number(
      dry.metadata.statistics?.totalBytesProcessed ??
        dry.metadata.statistics?.query?.totalBytesProcessed ??
        Number.NaN,
    );
    if (!Number.isFinite(estimate))
      throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
    if (estimate > cap)
      throw new IngestionError("BQ_REJECTED", false, { reason: "estimated bytes exceed cap", estimate, cap });
    if (this.billedBytesTotal + estimate > this.limits.totalBytes)
      throw new IngestionError("BQ_REJECTED", false, {
        reason: "run total budget would be exceeded",
        estimate,
      });
    if (this.jobsExecuted >= this.limits.maxBilledJobs)
      throw new IngestionError("BQ_REJECTED", false, { reason: "billed job budget exhausted" });
    this.jobsExecuted++;
    const [job] = await this.bq.createQueryJob({
      query: sql,
      location,
      maximumBytesBilled: String(cap),
      useQueryCache: false,
      labels: { source: "nearesis_ingestion" },
    });
    const [rows] = await job.getQueryResults();
    const billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? 0);
    this.billedBytesTotal += billed;
    const payload = new TextEncoder().encode(JSON.stringify(rows));
    return {
      rows,
      jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
      estimateBytes: estimate,
      billedBytes: billed,
      userEmail: job.metadata.user_email ?? null,
      location,
      payload,
    };
  }
}

/** Adapter facade: checkAuth / fetchBatch / getSchemaFingerprint / checkpoint / health / replay (ch.07). */
export class BigQueryAdapter {
  readonly providerId = "near-bigquery" as const;
  readonly adapterVersion = BQ_ADAPTER_VERSION;
  readonly mode = "live" as const;
  lastDiscovery: Discovery | null = null;
  constructor(
    readonly guard: BigQueryGuard,
    private readonly archive: RawArchive,
    private readonly principal: () => Promise<string | null> = async () => null,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async checkAuth(): Promise<{ ok: boolean; discovery: Discovery | null }> {
    try {
      this.lastDiscovery = await this.guard.discover(await this.principal());
      return { ok: true, discovery: this.lastDiscovery };
    } catch {
      return { ok: false, discovery: null };
    }
  }

  getSchemaFingerprint(columns: Array<{ column_name: string; data_type: string }>): string {
    return sha256Hex(
      columns
        .map((c) => `${c.column_name}:${c.data_type}`)
        .sort()
        .join("|"),
    );
  }

  /** One day of data. The SQL is generated here with finite block_date bounds; callers cannot pass raw SQL. */
  dailyUsageSql(day: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
      throw new IngestionError("INVALID_INPUT", false, { reason: "day must be YYYY-MM-DD" });
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return [
      "SELECT t.block_date AS block_date,",
      "  COUNT(*) AS tx_count,",
      "  COUNT(DISTINCT t.signer_account_id) AS distinct_signers",
      `FROM \`bigquery-public-data.${NEAR_DATASET}.transactions\` t`,
      `WHERE t.block_date >= DATE '${day}' AND t.block_date < DATE '${next}'`,
      "GROUP BY block_date ORDER BY block_date",
    ].join("\n");
  }

  async fetchBatch(sql: string): Promise<GuardedRun & { objectHash: string }> {
    if (!this.lastDiscovery) await this.checkAuth();
    if (!this.lastDiscovery)
      throw new IngestionError("AUTH_REJECTED", false, { reason: "BigQuery auth/discovery failed" });
    const run = await this.guard.run(sql, this.lastDiscovery.datasetLocation);
    const now = new Date(this.clock()).toISOString();
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
      payload: run.payload,
      recordsClaimed: run.rows.length,
      recordsParsed: run.rows.length,
      privacyVisibility: "public",
      completeness: "complete",
    });
    return { ...run, objectHash: a.observation.payloadObjectHash };
  }
}
