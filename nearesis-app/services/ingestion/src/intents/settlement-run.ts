import { createHash } from "node:crypto";
import { isSpendBlocked } from "@nearesis/contracts";
import { BQ_ADAPTER_VERSION, type BigQueryJobLike, type BigQueryLike } from "../adapters/bigquery.ts";
import type { ScratchRef } from "../adapters/bigquery-client.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import { IngestionError } from "../errors.ts";
import { settlementSql, type SettlementWindow } from "./settlement-sql.ts";

/**
 * BILLED runner for the NEAR Intents settlement-duration pilot (docs/intents/APPROVAL-settlement.md). Same guards as the
 * economics runner: the owner's digest binds the exact 7-day window and SQL, an approved byte ceiling, a per-job
 * `maximumBytesBilled`, the quota ledger, the cost gate when enabled, and the scratch table is always deleted.
 * NOT executed by the worker that wrote it: no billed query without owner approval.
 */
export const PILOT_DAYS = 7;
/** The only dataset the runner will create or delete tables in. */
export const SCRATCH_DATASET = "nearesis_scratch";
export const SCRATCH_TABLE_PREFIX = "settlement_hashes";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export interface SettlementBq extends BigQueryLike {
  loadScratchTable(ref: ScratchRef, hashes: string[], location: string): Promise<void>;
  deleteScratchTable(ref: ScratchRef, location: string): Promise<void>;
}

export const windowDays = (w: SettlementWindow): number =>
  (Date.parse(`${w.swapTo}T00:00:00Z`) - Date.parse(`${w.swapFrom}T00:00:00Z`)) / 86_400_000 + 1;

/**
 * The digest the owner approves: the exact swap-day window and the exact SQL (which names the scratch table). A digest for
 * one window never equals the digest of another, whatever the scratch table.
 */
export function settlementApprovalDigest(w: SettlementWindow, scratchTable: string): string {
  return createHash("sha256")
    .update(`settlement-pilot-v1\n${w.swapFrom}..${w.swapTo}\n${settlementSql(w, scratchTable)}`)
    .digest("hex");
}

export function parseScratch(scratchTable: string): ScratchRef {
  const [projectId, datasetId, tableId] = scratchTable.split(".");
  if (!projectId || datasetId !== SCRATCH_DATASET || !tableId?.startsWith(SCRATCH_TABLE_PREFIX))
    throw new IngestionError("BQ_REJECTED", false, {
      reason: `scratch table must be <project>.${SCRATCH_DATASET}.${SCRATCH_TABLE_PREFIX}*`,
    });
  return { projectId, datasetId, tableId };
}

export interface SettlementDone {
  id: string;
  rows: number;
  estimateBytes: number;
  billedBytes: number;
  jobId: string | null;
  rawObjectHash: string;
  completedAtUTC: string;
}
export type SettlementRunResult =
  | {
      status: "done";
      rows: Array<Record<string, unknown>>;
      done: SettlementDone;
      scratchCleanup: "deleted" | "failed";
    }
  | {
      status: "skipped";
      reason: string;
      estimateBytes: number | null;
      scratchCleanup: "deleted" | "failed" | "none";
    }
  | { status: "already_done" };

export async function runSettlementPilot(d: {
  bq: SettlementBq;
  archive: RawArchive;
  ledger: BudgetLedger;
  location: string;
  window: SettlementWindow;
  /** `<project>.nearesis_scratch.settlement_hashes*`. */
  scratchTable: string;
  /** The swaps' NEAR transaction hashes for exactly this window (public era). */
  hashes: string[];
  approvalDigest: string | undefined;
  /** Dry-run bytes ceiling the owner authorised for this window (includes the scratch table). */
  approvedMaxBytes: number | undefined;
  isDone: (id: string) => boolean;
  markDone: (r: SettlementDone) => void;
  nowMs?: () => number;
  log?: (m: string) => void;
}): Promise<SettlementRunResult> {
  const w = d.window;
  const log = d.log ?? (() => undefined);
  // 1. every refusal that needs no BigQuery call happens first
  if (windowDays(w) !== PILOT_DAYS)
    throw new IngestionError("BQ_REJECTED", false, {
      reason: `the settlement pilot runs exactly ${PILOT_DAYS} swap days (got ${windowDays(w)})`,
    });
  const scratch = parseScratch(d.scratchTable);
  const sql = settlementSql(w, d.scratchTable);
  assertGuardedSql(sql);
  if (!d.approvalDigest || d.approvalDigest !== settlementApprovalDigest(w, d.scratchTable))
    throw new IngestionError("BQ_REJECTED", false, {
      reason: "owner approval digest missing or does not match this window and SQL",
    });
  if (d.approvedMaxBytes === undefined || !Number.isFinite(d.approvedMaxBytes) || d.approvedMaxBytes <= 0)
    throw new IngestionError("BQ_REJECTED", false, {
      reason: "owner budget authorisation (approvedMaxBytes) missing",
    });
  if (d.hashes.length === 0 || d.hashes.some((h) => !BASE58.test(h)))
    throw new IngestionError("BQ_REJECTED", false, {
      reason: "hashes must be a non-empty list of base58 tx hashes",
    });
  const id = `settlement:${w.swapFrom}..${w.swapTo}`;
  if (d.isDone(id)) return { status: "already_done" };

  let cleaned: "deleted" | "failed" | "none" = "none";
  const cleanup = async (): Promise<void> => {
    try {
      await d.bq.deleteScratchTable(scratch, d.location);
      cleaned = "deleted";
    } catch (e) {
      cleaned = "failed";
      log(`scratch cleanup failed for ${d.scratchTable}: ${(e as Error).message}`);
    }
  };
  try {
    // 2. free load job, then a free dry run of the exact SQL (the scratch table must exist for it)
    await d.bq.loadScratchTable(scratch, [...new Set(d.hashes)], d.location);
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
    if (!fit.ok) return await skip(`quota guard: ${fit.reason}`, est);
    if (est > d.approvedMaxBytes) return await skip("dry-run bytes exceed the owner's approvedMaxBytes", est);
    // 3. the billed job: capped at the lower of the owner's ceiling and the ledger's cap
    const maximumBytesBilled = Math.min(fit.maximumBytesBilled, d.approvedMaxBytes);
    let job: BigQueryJobLike;
    let rows: Array<Record<string, unknown>>;
    try {
      [job] = await d.bq.createQueryJob({
        query: sql,
        location: d.location,
        maximumBytesBilled: String(maximumBytesBilled),
        useQueryCache: false,
        labels: { source: "nearesis_settlement_pilot" },
      });
      [rows] = await job.getQueryResults();
    } catch (e) {
      if (isSpendBlocked(e))
        return await skip(
          `cost governor: ${(e as { detail?: { costReason?: string } }).detail?.costReason ?? "blocked"}`,
          est,
        );
      throw e;
    }
    let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
    if (!Number.isFinite(billed)) {
      const refresh = (job as { getMetadata?: () => Promise<[typeof job.metadata]> }).getMetadata;
      if (refresh)
        billed = Number((await refresh.call(job))[0].statistics?.query?.totalBytesBilled ?? Number.NaN);
    }
    const billedBytes = Number.isFinite(billed) ? billed : maximumBytesBilled; // unknown is never free
    d.ledger.record(id, est, billedBytes);
    const iso = new Date((d.nowMs ?? Date.now)()).toISOString();
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
    const done: SettlementDone = {
      id,
      rows: rows.length,
      estimateBytes: est,
      billedBytes,
      jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
      rawObjectHash: a.observation.payloadObjectHash,
      completedAtUTC: iso,
    };
    d.markDone(done);
    log(`done ${id}: ${rows.length} rows, billed ${billedBytes} B`);
    await cleanup();
    return { status: "done", rows, done, scratchCleanup: cleaned === "none" ? "failed" : cleaned };
  } catch (e) {
    await cleanup();
    throw e;
  }

  async function skip(reason: string, estimateBytes: number): Promise<SettlementRunResult> {
    log(`skip ${id}: ${reason}`);
    await cleanup();
    return { status: "skipped", reason, estimateBytes, scratchCleanup: cleaned };
  }
}
