import type { ClickHouseClient } from "@clickhouse/client";
import { Redis } from "ioredis";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import type { RawArchive } from "../archive/archive.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { insertLive } from "../backfill/ch.ts";
import { loadCredentials, REDIS_URL } from "../backfill/env.ts";
import { makeChSink } from "../backfill/orchestrator.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { StateStore } from "../backfill/state.ts";
import { AccountStateStore } from "../backfill/account-run.ts";
import { systemClock, type Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { ALLOW_ONECLICK, HttpClient } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import {
  ALL_TASKS,
  FORWARD_FROM_DAY,
  SCHEDULER_ACCOUNT_STATE_PATH,
  SCHEDULER_BQ_STATE_PATH,
  SCHEDULER_FORWARD_STATE_PATH,
  SCHEDULER_LOAD_STATE_PATH,
  type SchedulerConfig,
  type TaskName,
} from "./config.ts";
import { pendingAccountDays, runAccountDaily } from "./account-forward.ts";
import { runBqDaily, runPriceDaily } from "./daily.ts";
import {
  accountsJob,
  anyForwardEnabled,
  economicsJobs,
  forwardFlags,
  pendingForwardDays,
  runForwardJobs,
  settlementJob,
  type ForwardJobSpec,
  type ForwardKind,
} from "./forward-jobs.ts";
import { loadSettlementDay } from "./forward-settlement.ts";
import { ForwardStateStore } from "./forward-state.ts";
import { runExplorerForward } from "./explorer-forward.ts";
import { backoffMs, dueTasks, pendingBqDays, pendingPriceDays, type Facts } from "./plan.ts";
import { runQuoteRound } from "./quotes.ts";
import { OneClickQuoteSampler } from "../adapters/oneclick.ts";
import type { SchedulerStateStore } from "./state.ts";
import { emitWatermarks } from "./watermarks.ts";

export interface SchedulerDeps {
  ch: ClickHouseClient;
  db: Db;
  archive: RawArchive;
  cfg: SchedulerConfig;
  sched: SchedulerStateStore;
  creds?: CredentialSource;
  clock?: Clock;
  only?: readonly TaskName[];
  /** Loop-mode gate for the quote task; absent means enabled (explicit operator runs). */
  quotesEnabled?: () => boolean;
  /** Test seam; defaults to the NEARESIS_*_DAILY environment flags. */
  forwardFlags?: () => ReturnType<typeof forwardFlags>;
  shouldStop?: () => boolean;
  log?: (m: string) => void;
}

/** Runs the due tasks sequentially. Each task is isolated: a failure backs that task off and never stops the others. */
export class Scheduler {
  private readonly clock: Clock;
  private readonly creds: CredentialSource;
  private readonly log: (m: string) => void;
  private readonly bqStore = new StateStore(SCHEDULER_BQ_STATE_PATH, FORWARD_FROM_DAY, FORWARD_FROM_DAY);
  private readonly accountStore = new AccountStateStore(SCHEDULER_ACCOUNT_STATE_PATH);
  private readonly forwardStore = new ForwardStateStore(SCHEDULER_FORWARD_STATE_PATH);
  private readonly loadStore = new StateStore(SCHEDULER_LOAD_STATE_PATH, FORWARD_FROM_DAY, FORWARD_FROM_DAY);
  constructor(private readonly d: SchedulerDeps) {
    this.clock = d.clock ?? systemClock;
    this.creds = d.creds ?? loadCredentials();
    this.log = d.log ?? ((m) => console.log(`[scheduler ${new Date().toISOString()}] ${m}`));
  }

  facts(): Facts {
    const now = this.clock.now();
    return {
      bqPending: pendingBqDays(now, (id) => this.bqStore.isDone(id)).length + this.accountPending(now).length,
      pricePending: pendingPriceDays(now, this.d.sched.state.price).length,
      explorerInflight: this.d.sched.state.explorer.inflight !== null,
      forwardPending: this.forwardPending(now),
    };
  }

  /** Forward daily jobs are opt-in (NEARESIS_ECONOMICS_DAILY / _ACCOUNTS_DAILY / _SETTLEMENT_DAILY); all off means nothing is ever pending. */
  private forwardPending(now: number): number {
    const f = (this.d.forwardFlags ?? forwardFlags)();
    if (!anyForwardEnabled(f)) return 0;
    const txDone = (day: string): boolean => this.bqStore.isDone(`transactions:${day}`);
    return (["economics", "accounts", "settlement"] as ForwardKind[])
      .filter((k) => f[k])
      .reduce((n, k) => n + pendingForwardDays(now, k, this.forwardStore, txDone).length, 0);
  }

  private accountPending(now: number): string[] {
    return pendingAccountDays(now, this.accountStore, (day) => this.bqStore.isDone(`transactions:${day}`));
  }

  due(): TaskName[] {
    const tasks = (this.d.only ?? ALL_TASKS).filter(
      (t) => t !== "quotes" || (this.d.quotesEnabled?.() ?? true),
    );
    return dueTasks(this.clock.now(), this.d.sched.state, this.d.cfg, this.facts(), tasks);
  }

  /** One pass over the due tasks. Returns the tasks that ran. */
  async tick(): Promise<TaskName[]> {
    const ran: TaskName[] = [];
    for (const t of this.due()) {
      if (this.d.shouldStop?.()) break;
      await this.runTask(t);
      ran.push(t);
    }
    return ran;
  }

  async runTask(t: TaskName): Promise<void> {
    const st = this.d.sched.state.tasks[t];
    st.lastRunAtMs = this.clock.now();
    try {
      await this.execute(t);
      st.lastOkAtMs = this.clock.now();
      st.lastError = null;
      st.failures = 0;
      st.nextAttemptAtMs = 0;
    } catch (e) {
      st.failures++;
      st.lastError = `${(e as Error).name}${(e as { code?: string }).code ? `:${(e as { code: string }).code}` : ""}`;
      st.nextAttemptAtMs = this.clock.now() + backoffMs(st.failures);
      this.log(
        `${t} failed (${st.lastError}); next attempt in ${Math.round(backoffMs(st.failures) / 1000)}s`,
      );
    }
    this.d.sched.save();
    try {
      await emitWatermarks(this.d.ch, this.d.sched.state, this.clock.now());
    } catch (e) {
      this.log(`watermark emit failed: ${(e as Error).name}`);
    }
  }

  private async execute(t: TaskName): Promise<void> {
    const { ch, db, archive, cfg, sched } = this.d;
    const nowMs = (): number => this.clock.now();
    switch (t) {
      case "bq": {
        const runner = new BudgetedBigQuery(createBigQueryClient(), archive);
        const discovery = await runner.discover(adcCredentialKind());
        const since = quotaDayStart(nowMs());
        const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
        const ledger = new BudgetLedger(reading.bytes);
        this.log(
          `bq: billed so far in quota day ${Math.round(reading.bytes / 1048576)} MiB, remaining ${Math.round(ledger.remaining / 1048576)} MiB`,
        );
        const r = await runBqDaily({
          runner,
          bqStore: this.bqStore,
          sched,
          sink: makeChSink(ch),
          ledger,
          location: discovery.datasetLocation,
          cfg,
          nowMs,
          log: this.log,
        });
        this.log(
          `bq: completed ${r.completed.length}, deferred(budget) ${r.budgetSkipped.length}, retry-later ${r.retryLater.length}`,
        );
        // Account-level daily activity (organic target): same ledger, so the 95% daily cap covers every job.
        const acct = await runAccountDaily({
          bq: createBigQueryClient(),
          archive,
          ch,
          store: this.accountStore,
          ledger,
          location: discovery.datasetLocation,
          days: this.accountPending(nowMs()),
          maxDays: cfg.bqMaxDaysPerRun,
          nowMs,
          log: this.log,
        });
        this.log(
          `account: completed ${acct.completed.length}, deferred(budget) ${acct.skippedForBudget.length}`,
        );
        if (r.budgetSkipped.length > 0 || acct.skippedForBudget.length > 0)
          throw Object.assign(new Error("budget"), { name: "BudgetDeferred" });
        return;
      }
      case "price": {
        const r = await runPriceDaily({ ch, archive, creds: this.creds, sched, cfg, nowMs, log: this.log });
        this.log(
          `price: loaded ${r.daysLoaded.length}, gaps ${r.gapsRecorded.length}, retry-later ${r.retryLater.length}`,
        );
        return;
      }
      case "explorer": {
        const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
        try {
          const r = await runExplorerForward({
            ch,
            db,
            archive,
            creds: this.creds,
            redis,
            clock: this.clock,
            sched,
            loadStore: this.loadStore,
            cfg,
            log: this.log,
          });
          if (!r.complete && r.status !== "no_credential" && r.status !== "max_pages")
            throw Object.assign(new Error(r.status), { name: "ExplorerStatus", code: r.status });
          return;
        } finally {
          redis.disconnect();
        }
      }
      case "forward": {
        const flags = (this.d.forwardFlags ?? forwardFlags)();
        if (!anyForwardEnabled(flags)) return;
        const bq = createBigQueryClient();
        const runner = new BudgetedBigQuery(bq, archive);
        const discovery = await runner.discover(adcCredentialKind());
        const reading = await runner.billedSince(
          discovery.datasetLocation,
          quotaDayStart(nowMs()).toISOString(),
        );
        const ledger = new BudgetLedger(reading.bytes);
        const txDone = (day: string): boolean => this.bqStore.isDone(`transactions:${day}`);
        const jobs: ForwardJobSpec[] = [];
        for (const kind of ["economics", "accounts", "settlement"] as ForwardKind[]) {
          if (!flags[kind]) continue;
          for (const day of pendingForwardDays(nowMs(), kind, this.forwardStore, txDone).slice(
            0,
            cfg.bqMaxDaysPerRun,
          )) {
            if (kind === "economics") jobs.push(...economicsJobs(day, ch));
            else if (kind === "accounts") jobs.push(accountsJob(day, ch));
            else
              jobs.push(
                settlementJob(day, {
                  scratchProject: (await bq.getProjectId?.()) ?? "near-514307",
                  location: discovery.datasetLocation,
                  hashesForDay: async (d) =>
                    (
                      await db.query<{ h: string }>(
                        `SELECT DISTINCT jsonb_array_elements_text(record->'nearTxHashes') AS h FROM ingestion.explorer_swaps
                          WHERE created_at >= $1::date AND created_at < ($1::date + 1)`,
                        [d],
                      )
                    ).rows.map((r) => r.h),
                  loadScratch: (ref, hs, loc) => bq.loadScratchTable(ref, hs, loc),
                  deleteScratch: (ref, loc) => bq.deleteScratchTable(ref, loc),
                  loadDay: (d, rows, p) => loadSettlementDay(ch, d, rows, p),
                }),
              );
          }
        }
        this.log(
          `forward: billed so far in quota day ${Math.round(reading.bytes / 1048576)} MiB, ${jobs.length} jobs planned`,
        );
        const r = await runForwardJobs({
          bq,
          archive,
          state: this.forwardStore,
          ledger,
          location: discovery.datasetLocation,
          jobs,
          readRaw: (h) => archive.store.get(h),
          nowMs,
          log: this.log,
        });
        this.log(
          `forward: loaded ${r.loaded.length}, reloaded ${r.reloaded.length}, skipped ${r.skipped.length}, refused ${r.refused.length}, deferred(budget) ${r.deferredForBudget.length}`,
        );
        if (r.deferredForBudget.length > 0)
          throw Object.assign(new Error("budget"), { name: "BudgetDeferred" });
        return;
      }
      case "quotes": {
        const http = new HttpClient({ allow: [ALLOW_ONECLICK], credentials: this.creds, clock: this.clock });
        const sampler = new OneClickQuoteSampler({
          http,
          archive,
          clock: this.clock,
          sourceEnvironment: "live",
          ...(this.creds.has("INTENTS_1CLICK_JWT") ? { credentialName: "INTENTS_1CLICK_JWT" } : {}),
        });
        const r = await runQuoteRound({
          sampler,
          creds: this.creds,
          cfg,
          store: sched,
          nowMs,
          sleep: (ms) => this.clock.sleep(ms),
          insert: async (rows) => void (await insertLive(ch, "quote_attempts", rows)),
          ...(this.d.shouldStop ? { shouldStop: this.d.shouldStop } : {}),
          log: this.log,
        });
        void r;
        return;
      }
    }
  }
}
