import type { ClickHouseClient } from "@clickhouse/client";
import { isSpendBlocked } from "@nearesis/contracts";
import { BQ_ADAPTER_VERSION, type BigQueryJobLike, type BigQueryLike } from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { RawArchive } from "../archive/archive.ts";
import { IngestionError } from "../errors.ts";
import { accountScanSql, HEAD_THRESHOLD, type MappingInput } from "../accounts/sql.ts";
import { scanRows } from "../accounts/rows.ts";
import { ACCOUNT_COHORT_DATASETS } from "../accounts/load.ts";
import { readRegistryMappings } from "../accounts/registry.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import { MIB } from "../backfill/budget.ts";
import type { BqRow } from "../backfill/bq-runner.ts";
import { coverageRows, insertLive, type Provenance } from "../backfill/ch.ts";
import { addDays, quotaDayStart, WINDOW_FROM } from "../backfill/plan.ts";
import { loadEconomicsChunk } from "../economics/load.ts";
import { MIN_BILLED_BYTES } from "../economics/run.ts";
import { economicsSql, ECONOMICS_FAMILIES, type EconomicsChunk } from "../economics/sql.ts";
import { parseScratch, SCRATCH_DATASET } from "../intents/settlement-run.ts";
import { settlementSql } from "../intents/settlement-sql.ts";
import { FORWARD_FROM_DAY } from "./config.ts";
import type { ForwardEntry, ForwardStateStore } from "./forward-state.ts";
import { daysBetween, lastCompletedDay } from "./plan.ts";

/**
 * Forward-only daily BigQuery jobs (A36). Each is DISABLED by default and needs its own owner approval:
 *   NEARESIS_ECONOMICS_DAILY=1   yesterday's lean outcomes / conversion / gas_price (about 0.24 GiB/day, USD 0.0015/day)
 *   NEARESIS_ACCOUNTS_DAILY=1    A23's per-signer scan for yesterday only (about 0.04 GiB/day)
 *   NEARESIS_SETTLEMENT_DAILY=1  settlement durations of yesterday's swaps (public-era days only; none exist after 2026-10-26)
 * Every job is idempotent (state file; an id with an entry is never billed again), quota guarded (the shared 95 GiB ledger,
 * estimate x 1.02 fit, per-job maximumBytesBilled never below the 10 MiB minimum) and archived (raw rows are written before
 * anything is loaded, so a crash after billing reloads from the archive instead of billing again).
 */
export type ForwardKind = "economics" | "accounts" | "settlement";
export interface ForwardFlags {
  economics: boolean;
  accounts: boolean;
  settlement: boolean;
}
const TRUE = /^(1|true|yes|on)$/i;
export const forwardFlags = (env: NodeJS.ProcessEnv = process.env): ForwardFlags => ({
  economics: TRUE.test(env.NEARESIS_ECONOMICS_DAILY ?? ""),
  accounts: TRUE.test(env.NEARESIS_ACCOUNTS_DAILY ?? ""),
  settlement: TRUE.test(env.NEARESIS_SETTLEMENT_DAILY ?? ""),
});
export const anyForwardEnabled = (f: ForwardFlags): boolean => f.economics || f.accounts || f.settlement;

/** Per-job dry-run ceilings (bytes). A job above its ceiling is refused and recorded; it is not retried with other parameters. */
export const FORWARD_JOB_CEILING: Record<ForwardKind, number> = {
  economics: Math.round(1.5 * 1024 * MIB), // the most expensive lean outcomes day measured is 1.25 GiB
  accounts: Math.round(0.5 * 1024 * MIB),
  settlement: Math.round(0.2 * 1024 * MIB),
};

/** First swap day created in the private era: nearTxHashes then hold shield/unshield boundary hashes (settlement is CANNOT_COMPUTE). */
export const SETTLEMENT_PRIVATE_ERA_FROM = "2026-10-27";

export interface ForwardJobSpec {
  id: string;
  kind: ForwardKind;
  day: string;
  maxBytes: number;
  /** Resolves the SQL to run, or why the job does not apply. Called before the dry run; may create free scratch state. */
  prepare(): Promise<{ sql: string } | { skip: string; persist: boolean }>;
  cleanup?(): Promise<void>;
  /** Loads the archived result rows; idempotent (ReplacingMergeTree). */
  load(rows: BqRow[], p: Provenance): Promise<number>;
}

export const economicsJobId = (family: string, day: string): string => `economics:${family}:${day}`;
export const accountsJobId = (day: string): string => `accounts:${day}`;
export const settlementJobId = (day: string): string => `settlement:${day}`;

/** Days still without a settled forward entry for `kind`, oldest first, only days whose `transactions:<day>` is done (provider has the day). */
export function pendingForwardDays(
  nowMs: number,
  kind: ForwardKind,
  state: Pick<ForwardStateStore, "isSettled">,
  txDone: (day: string) => boolean,
): string[] {
  const last = lastCompletedDay(nowMs);
  if (last < FORWARD_FROM_DAY) return [];
  return daysBetween(FORWARD_FROM_DAY, last).filter((d) => {
    if (!txDone(d)) return false;
    const ids =
      kind === "economics"
        ? ECONOMICS_FAMILIES.map((f) => economicsJobId(f, d))
        : kind === "accounts"
          ? [accountsJobId(d)]
          : [settlementJobId(d)];
    return !ids.every((id) => state.isSettled(id));
  });
}

export function economicsJobs(day: string, ch: ClickHouseClient): ForwardJobSpec[] {
  return ECONOMICS_FAMILIES.map((family) => {
    const chunk: EconomicsChunk = { id: `${family}:${day}`, family, from: day, to: addDays(day, 1) };
    return {
      id: economicsJobId(family, day),
      kind: "economics" as const,
      day,
      maxBytes: FORWARD_JOB_CEILING.economics,
      prepare: async () => ({ sql: economicsSql(chunk) }),
      load: (rows, p) => loadEconomicsChunk(ch, chunk, rows, p),
    };
  });
}

/**
 * "new" semantics: the scan's new-signer column is anchored at the START OF ITS OWN WINDOW. A one-day scan would call every
 * signer new, which is NOT "first seen since the cohort window start (2025-11-10)" that the backfilled history uses. So a
 * forward day loads only the window-independent datasets (head, tail, entity) with window_start = 2025-11-10 and does NOT write
 * account_daily_new_returning, retention or profile rows; coverage of account_daily_new_returning is `partial` with reason
 * NEW_REQUIRES_WINDOW_START_HISTORY (a first-seen set before the day would cost a whole-window scan every day).
 */
export async function loadForwardAccountDay(
  ch: ClickHouseClient,
  day: string,
  rows: BqRow[],
  p: Provenance,
  opts: { head: number; registryVersion: string },
): Promise<number> {
  const parsed = scanRows(rows, p, { ...opts, windowStart: WINDOW_FROM });
  let n = 0;
  n += await insertLive(ch, "account_daily_head", parsed.head);
  n += await insertLive(ch, "account_daily_tail", parsed.tail);
  n += await insertLive(ch, "entity_daily_signers", parsed.entity);
  const present = parsed.days.includes(day);
  const v = Date.parse(p.fetchedAtUTC);
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      ACCOUNT_COHORT_DATASETS.map((dataset) => ({
        provider_id: "near-bigquery",
        dataset,
        day,
        state: !present
          ? ("unavailable" as const)
          : dataset === "account_daily_new_returning"
            ? ("partial" as const)
            : ("complete" as const),
        reason: !present
          ? "PROVIDER_GAP"
          : dataset === "account_daily_new_returning"
            ? "NEW_REQUIRES_WINDOW_START_HISTORY"
            : null,
        version: v,
      })),
    ),
  );
  return n;
}

export function accountsJob(
  day: string,
  ch: ClickHouseClient,
  reg: () => Promise<{ registryVersion: string; mappings: MappingInput[] }> = () => readRegistryMappings(ch),
): ForwardJobSpec {
  let cached: { registryVersion: string; mappings: MappingInput[] } | null = null;
  return {
    id: accountsJobId(day),
    kind: "accounts",
    day,
    maxBytes: FORWARD_JOB_CEILING.accounts,
    prepare: async () => {
      cached = await reg();
      return { sql: accountScanSql({ from: day, to: addDays(day, 1) }, cached.mappings, HEAD_THRESHOLD) };
    },
    load: (rows, p) =>
      loadForwardAccountDay(ch, day, rows, p, {
        head: HEAD_THRESHOLD,
        registryVersion: cached?.registryVersion ?? "none",
      }),
  };
}

export interface SettlementForwardIo {
  scratchProject: string;
  /** Distinct nearTxHashes of the day's swaps (Postgres explorer_swaps). Empty: nothing to look up. */
  hashesForDay(day: string): Promise<string[]>;
  loadScratch(ref: ReturnType<typeof parseScratch>, hashes: string[], location: string): Promise<void>;
  deleteScratch(ref: ReturnType<typeof parseScratch>, location: string): Promise<void>;
  /** Computes and stores tx times, durations and coverage for the day from the BigQuery rows. */
  loadDay(day: string, rows: BqRow[], p: Provenance): Promise<number>;
  location: string;
}

export function settlementJob(day: string, io: SettlementForwardIo): ForwardJobSpec {
  const scratchTable = `${io.scratchProject}.${SCRATCH_DATASET}.settlement_hashes_${day.replace(/-/g, "")}`;
  let scratchCreated = false;
  return {
    id: settlementJobId(day),
    kind: "settlement",
    day,
    maxBytes: FORWARD_JOB_CEILING.settlement,
    prepare: async () => {
      if (day >= SETTLEMENT_PRIVATE_ERA_FROM) return { skip: "PRIVATE_ERA_CANNOT_COMPUTE", persist: true };
      const hashes = await io.hashesForDay(day);
      if (hashes.length === 0) return { skip: "NO_SWAP_HASHES_LOADED_YET", persist: false };
      const ref = parseScratch(scratchTable);
      await io.loadScratch(ref, [...new Set(hashes)], io.location);
      scratchCreated = true;
      return { sql: settlementSql({ id: "1d", swapFrom: day, swapTo: day }, scratchTable) };
    },
    cleanup: async () => {
      if (scratchCreated) await io.deleteScratch(parseScratch(scratchTable), io.location);
      scratchCreated = false;
    },
    load: (rows, p) => io.loadDay(day, rows, p),
  };
}

export interface ForwardRunResult {
  loaded: string[];
  reloaded: string[];
  skipped: Array<{ id: string; reason: string }>;
  deferredForBudget: Array<{ id: string; estimateBytes: number }>;
  refused: Array<{ id: string; estimateBytes: number; maxBytes: number }>;
}

const bytesOf = (m: {
  statistics?: { totalBytesProcessed?: unknown; query?: { totalBytesProcessed?: unknown } };
}): number =>
  Number(m.statistics?.totalBytesProcessed ?? m.statistics?.query?.totalBytesProcessed ?? Number.NaN);

/**
 * Runs the given jobs in order. Per job: settled -> skip; billed-but-unloaded -> reload from the archive (no BigQuery call);
 * otherwise prepare -> dry run -> over the job ceiling is refused and recorded -> shared quota ledger fit, else deferred and the
 * run stops (later jobs stay pending for the next quota day) -> billed job -> archive -> checkpoint `billed` -> load -> `loaded`.
 */
export async function runForwardJobs(d: {
  bq: BigQueryLike;
  archive: RawArchive;
  state: ForwardStateStore;
  ledger: BudgetLedger;
  location: string;
  jobs: ForwardJobSpec[];
  readRaw: (hash: string) => Promise<Uint8Array>;
  nowMs?: () => number;
  log?: (m: string) => void;
}): Promise<ForwardRunResult> {
  const log = d.log ?? (() => undefined);
  const now = d.nowMs ?? (() => Date.now());
  const res: ForwardRunResult = { loaded: [], reloaded: [], skipped: [], deferredForBudget: [], refused: [] };
  for (const job of d.jobs) {
    const prior = d.state.get(job.id);
    if (prior && d.state.isSettled(job.id)) continue;
    if (prior?.status === "billed" && prior.rawObjectHash) {
      const rows = JSON.parse(new TextDecoder().decode(await d.readRaw(prior.rawObjectHash))) as BqRow[];
      const loaded = await job.load(rows, {
        rawObjectHash: prior.rawObjectHash,
        fetchedAtUTC: prior.completedAtUTC,
      });
      d.state.put(job.id, { ...prior, status: "loaded", rows: loaded });
      res.reloaded.push(job.id);
      log(`reloaded ${job.id} from the archive (no BigQuery call): ${loaded} rows`);
      continue;
    }
    try {
      const prep = await job.prepare();
      if ("skip" in prep) {
        res.skipped.push({ id: job.id, reason: prep.skip });
        if (prep.persist) d.state.put(job.id, entry(job, "not_applicable", now(), { reason: prep.skip }));
        log(`skip ${job.id}: ${prep.skip}`);
        continue;
      }
      assertGuardedSql(prep.sql);
      const [dry] = await d.bq.createQueryJob({
        query: prep.sql,
        dryRun: true,
        location: d.location,
        useQueryCache: false,
      });
      const est = bytesOf(dry.metadata);
      if (!Number.isFinite(est))
        throw new IngestionError("BQ_REJECTED", false, { reason: "dry run returned no byte estimate" });
      if (est > job.maxBytes) {
        res.refused.push({ id: job.id, estimateBytes: est, maxBytes: job.maxBytes });
        d.state.put(
          job.id,
          entry(job, "refused", now(), { estimateBytes: est, reason: `OVER_JOB_CEILING:${job.maxBytes}` }),
        );
        log(`REFUSED ${job.id}: est ${est} B > ceiling ${job.maxBytes} B; not retried`);
        continue;
      }
      const fit = d.ledger.check(est);
      if (!fit.ok) {
        res.deferredForBudget.push({ id: job.id, estimateBytes: est });
        log(`defer ${job.id}: ${fit.reason}`);
        break;
      }
      const cap = Math.max(fit.maximumBytesBilled, MIN_BILLED_BYTES);
      let jobObj: BigQueryJobLike;
      let rows: BqRow[];
      try {
        [jobObj] = await d.bq.createQueryJob({
          query: prep.sql,
          location: d.location,
          maximumBytesBilled: String(cap),
          useQueryCache: false,
          labels: { source: `nearesis_forward_${job.kind}` },
        });
        [rows] = await jobObj.getQueryResults();
      } catch (e) {
        if (isSpendBlocked(e)) {
          res.deferredForBudget.push({ id: job.id, estimateBytes: est });
          log(`defer ${job.id}: cost governor`);
          break;
        }
        throw e;
      }
      let billed = Number(jobObj.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
      if (!Number.isFinite(billed)) {
        const refresh = (jobObj as { getMetadata?: () => Promise<[typeof jobObj.metadata]> }).getMetadata;
        if (refresh)
          billed = Number((await refresh.call(jobObj))[0].statistics?.query?.totalBytesBilled ?? Number.NaN);
      }
      const billedBytes = Number.isFinite(billed) ? billed : cap; // unknown is never free
      d.ledger.record(job.id, est, billedBytes);
      const iso = new Date(now()).toISOString();
      const a = await d.archive.archive({
        providerId: "near-bigquery",
        adapterVersion: BQ_ADAPTER_VERSION,
        method: "POST",
        url: "https://bigquery.googleapis.com/bigquery/v2/jobs",
        requestBody: { sql: prep.sql },
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
      const billedEntry = entry(job, "billed", now(), {
        estimateBytes: est,
        billedBytes,
        jobId: jobObj.id ?? jobObj.metadata.jobReference?.jobId ?? null,
        rawObjectHash: hash,
        rows: rows.length,
        completedAtUTC: iso,
      });
      d.state.put(job.id, billedEntry); // checkpoint BEFORE the load: a load failure never re-bills
      const loaded = await job.load(rows, { rawObjectHash: hash, fetchedAtUTC: iso });
      d.state.put(job.id, { ...billedEntry, status: "loaded", rows: loaded });
      res.loaded.push(job.id);
      log(`done ${job.id}: ${loaded} rows, billed ${billedBytes} B`);
    } finally {
      await job.cleanup?.().catch((e: unknown) => log(`cleanup ${job.id} failed: ${(e as Error).message}`));
    }
  }
  return res;
}

function entry(
  job: ForwardJobSpec,
  status: ForwardEntry["status"],
  nowMs: number,
  x: Partial<ForwardEntry> = {},
): ForwardEntry {
  return {
    status,
    kind: job.kind,
    day: job.day,
    estimateBytes: null,
    billedBytes: null,
    jobId: null,
    rawObjectHash: null,
    rows: null,
    completedAtUTC: new Date(nowMs).toISOString(),
    quotaDay: quotaDayStart(nowMs).toISOString().slice(0, 10),
    reason: null,
    ...x,
  };
}
