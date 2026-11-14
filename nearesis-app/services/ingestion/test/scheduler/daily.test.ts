import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BigQueryLike } from "../../src/adapters/bigquery.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { BudgetedBigQuery } from "../../src/backfill/bq-runner.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../../src/backfill/budget.ts";
import { makeChSink } from "../../src/backfill/orchestrator.ts";
import { StateStore } from "../../src/backfill/state.ts";
import { CredentialSource } from "../../src/http/credentials.ts";
import { loadConfig } from "../../src/scheduler/config.ts";
import { planBqDry, runBqDaily, runPriceDaily } from "../../src/scheduler/daily.ts";
import { SchedulerStateStore } from "../../src/scheduler/state.ts";
import { toFetchResponse } from "../../src/testing/servers.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
let tmp: string;
beforeAll(() => void (tmp = mkdtempSync(join(tmpdir(), "sched-daily-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Inserted {
  table: string;
  values: Array<Record<string, unknown>>;
}
const fakeCh = (): { ch: ClickHouseClient; inserted: Inserted[] } => {
  const inserted: Inserted[] = [];
  const ch = { insert: async (a: Inserted) => void inserted.push(a) } as unknown as ClickHouseClient;
  return { ch, inserted };
};

interface Job {
  query: string;
  dryRun?: boolean;
  maximumBytesBilled?: string;
}
function fakeBq(estimate: number, rowsOf: (sql: string) => unknown[]): { bq: BigQueryLike; jobs: Job[] } {
  const jobs: Job[] = [];
  const bq: BigQueryLike = {
    getProjectId: async () => "p",
    getDatasetMetadata: async () => ({ location: "us-east1" }),
    createQueryJob: async (o) => {
      jobs.push(o);
      const billed = o.dryRun ? 0 : Math.min(estimate, Number(o.maximumBytesBilled ?? estimate));
      return [
        {
          id: `job${jobs.length}`,
          metadata: {
            statistics: {
              totalBytesProcessed: String(estimate),
              query: {
                totalBytesProcessed: String(estimate),
                totalBilled: 0,
                totalBytesBilled: String(billed),
              },
            },
          },
          getQueryResults: async () => [rowsOf(o.query)],
        },
      ] as never;
    },
  };
  return { bq, jobs };
}
const archive = (n: string) => new RawArchive(new FsObjectStore(join(tmp, n, "raw")), null);
const txRows = [{ block_date: { value: "2026-11-10" }, tx_count: 5, distinct_signers: 3 }];
const recvRows = [
  { block_date: { value: "2026-11-10" }, receiver_out: "a.near", interactions: 100, receiver_count: 1 },
];
const rowsOf = (sql: string): unknown[] => (sql.includes("receipt_actions") ? recvRows : txRows);
const bqRig = (n: string) => ({
  bqStore: new StateStore(join(tmp, n, "bq.json"), "2026-11-10", "2026-11-10"),
  sched: new SchedulerStateStore(join(tmp, n, "state.json")),
  cfg: { ...loadConfig({}), emptyDayRetries: 2, emptyDayRetrySpacingMs: 1000 },
});

describe("BigQuery daily collection", () => {
  it("loads the last completed day, partition-filtered and capped at 1.1 x the dry-run estimate, and resumes without re-running", async () => {
    const rig = bqRig("bq-ok");
    const { bq, jobs } = fakeBq(1000, rowsOf);
    const sinkCalls: string[] = [];
    const run = () =>
      runBqDaily({
        runner: new BudgetedBigQuery(bq, archive("bq-ok")),
        ...rig,
        sink: async (c) => (sinkCalls.push(c.id), 1),
        ledger: new BudgetLedger(0),
        location: "us-east1",
        nowMs: () => NOW,
      });
    const first = await run();
    expect(first.completed).toEqual(["transactions:2026-11-10", "receivers:2026-11-10"]);
    const real = jobs.filter((j) => !j.dryRun);
    expect(real).toHaveLength(2);
    for (const j of real) {
      expect(Number(j.maximumBytesBilled)).toBeLessThanOrEqual(Math.ceil(1000 * 1.1));
      expect(j.query).toContain("block_date >= DATE '2026-11-10' AND");
      expect(j.query).toContain("< DATE '2026-11-11'");
    }
    expect(jobs.filter((j) => j.dryRun)).toHaveLength(2); // dry run before every real job
    const reopened = bqRig("bq-ok"); // new process reads state from disk
    const before = jobs.length;
    const second = await runBqDaily({
      runner: new BudgetedBigQuery(bq, archive("bq-ok")),
      ...reopened,
      sink: async () => 1,
      ledger: new BudgetLedger(0),
      location: "us-east1",
      nowMs: () => NOW,
    });
    expect(second.completed).toEqual([]);
    expect(jobs.length).toBe(before);
  });

  it("refuses to run when the estimate does not fit today's remaining budget: no billed job, nothing checkpointed", async () => {
    const rig = bqRig("bq-budget");
    const { bq, jobs } = fakeBq(50 * 1024 ** 3, rowsOf);
    let sink = 0;
    const res = await runBqDaily({
      runner: new BudgetedBigQuery(bq, archive("bq-budget")),
      ...rig,
      sink: async () => ++sink,
      ledger: new BudgetLedger(DAILY_LIMIT_BYTES - 1024 ** 3), // 1 GiB left
      location: "us-east1",
      nowMs: () => NOW,
    });
    expect(res.completed).toEqual([]);
    expect(res.budgetSkipped.map((x) => x.id)).toEqual(["transactions:2026-11-10", "receivers:2026-11-10"]);
    expect(jobs.filter((j) => !j.dryRun)).toHaveLength(0);
    expect(sink).toBe(0);
    expect(rig.bqStore.isDone("transactions:2026-11-10")).toBe(false);
  });

  it("a day with no rows is retried (provider lag), then recorded as a gap: never zero rows", async () => {
    const rig = bqRig("bq-empty");
    const { bq } = fakeBq(1000, () => []);
    const { ch, inserted } = fakeCh();
    let now = NOW;
    const run = () =>
      runBqDaily({
        runner: new BudgetedBigQuery(bq, archive("bq-empty")),
        ...rig,
        sink: makeChSink(ch),
        ledger: new BudgetLedger(0),
        location: "us-east1",
        nowMs: () => now,
      });
    const first = await run();
    expect(first.retryLater).toEqual(["2026-11-10"]);
    expect(inserted).toHaveLength(0); // nothing written for the day yet
    expect(rig.bqStore.isDone("transactions:2026-11-10")).toBe(false);
    now += 5000;
    const second = await run();
    expect(second.completed).toContain("transactions:2026-11-10");
    expect(second.gapsRecorded).toContain("transactions:2026-11-10");
    expect(inserted.some((i) => i.table === "near_daily_tx")).toBe(false); // no zero row
    const gaps = inserted.filter((i) => i.table === "quality_gaps").flatMap((i) => i.values);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.reason_code === "PROVIDER_GAP" && g.state === "unavailable")).toBe(true);
    const cov = inserted.filter((i) => i.table === "source_coverage").flatMap((i) => i.values);
    expect(cov.every((c) => c.state === "unavailable")).toBe(true);
  });

  it("dry-run planning only issues dry-run queries", async () => {
    const rig = bqRig("bq-plan");
    const { bq, jobs } = fakeBq(2048, rowsOf);
    const plan = await planBqDry({
      bq,
      location: "us-east1",
      ledger: new BudgetLedger(0),
      bqStore: rig.bqStore,
      cfg: rig.cfg,
      nowMs: NOW,
    });
    expect(plan.map((p) => [p.id, p.estimateBytes, p.fits])).toEqual([
      ["transactions:2026-11-10", 2048, true],
      ["receivers:2026-11-10", 2048, true],
    ]);
    expect(jobs.every((j) => j.dryRun === true)).toBe(true);
  });
});

const hourly = (day: string, n: number, price = 3.65): string =>
  JSON.stringify({
    prices: Array.from({ length: n }, (_, h) => [
      Date.parse(`${day}T00:00:00Z`) + h * 3_600_000,
      price + h / 100,
    ]),
  });
const cgFetch =
  (body: string, seen: string[] = []) =>
  async (url: string) => {
    seen.push(url);
    return toFetchResponse({ status: 200, body });
  };

describe("CoinGecko daily price", () => {
  const cfg = { ...loadConfig({}), priceAttemptsBeforeGap: 2 };
  const creds = CredentialSource.fromMap({});

  it("loads a day with all 24 hourly samples as LIVE and marks it done", async () => {
    const { ch, inserted } = fakeCh();
    const sched = new SchedulerStateStore(join(tmp, "price-ok", "state.json"));
    const seen: string[] = [];
    const res = await runPriceDaily({
      ch,
      archive: archive("price-ok"),
      creds,
      sched,
      cfg,
      nowMs: () => NOW,
      fetchImpl: cgFetch(hourly("2026-11-10", 24), seen),
    });
    expect(res.daysLoaded).toEqual(["2026-11-10"]);
    const candles = inserted.find((i) => i.table === "price_candles")!.values;
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      coin_id: "near",
      day: "2026-11-10",
      source_label: "LIVE",
      interval: "1d",
    });
    expect(sched.state.price.doneDays).toEqual(["2026-11-10"]);
    expect(seen).toHaveLength(1);
    // already settled: no further request
    const again = await runPriceDaily({
      ch,
      archive: archive("price-ok"),
      creds,
      sched,
      cfg,
      nowMs: () => NOW,
      fetchImpl: cgFetch("{}", seen),
    });
    expect(again.requests).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("an incomplete day is retried, then recorded as a gap and never filled", async () => {
    const { ch, inserted } = fakeCh();
    const sched = new SchedulerStateStore(join(tmp, "price-gap", "state.json"));
    const run = () =>
      runPriceDaily({
        ch,
        archive: archive("price-gap"),
        creds,
        sched,
        cfg,
        nowMs: () => NOW,
        fetchImpl: cgFetch(hourly("2026-11-10", 23)),
      });
    const a = await run();
    expect(a.retryLater).toEqual(["2026-11-10"]);
    expect(sched.state.price.gapDays).toEqual([]);
    const b = await run();
    expect(b.gapsRecorded).toEqual(["2026-11-10"]);
    expect(inserted.some((i) => i.table === "price_candles" && i.values.length > 0)).toBe(false);
    const gaps = inserted.filter((i) => i.table === "quality_gaps").flatMap((i) => i.values);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      provider_id: "coingecko",
      reason_code: "PROVIDER_GAP",
      state: "unavailable",
    });
  });
});
