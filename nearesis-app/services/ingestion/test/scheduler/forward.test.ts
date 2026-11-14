import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { BigQueryLike } from "../../src/adapters/bigquery.ts";
import { MemoryObjectStore } from "../../src/archive/object-store.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES, MIB } from "../../src/backfill/budget.ts";
import { loadConfig } from "../../src/scheduler/config.ts";
import {
  accountsJob,
  economicsJobs,
  forwardFlags,
  loadForwardAccountDay,
  pendingForwardDays,
  runForwardJobs,
  settlementJob,
  type ForwardJobSpec,
} from "../../src/scheduler/forward-jobs.ts";
import { ForwardStateStore } from "../../src/scheduler/forward-state.ts";
import { dueTasks } from "../../src/scheduler/plan.ts";
import { emptySchedulerState } from "../../src/scheduler/state.ts";

const T = (s: string): number => Date.parse(s);
const tmp = (): string => join(mkdtempSync(join(tmpdir(), "fwd-")), "forward-state.json");

class FakeBq {
  real = 0;
  dry = 0;
  constructor(
    private readonly est = 100 * MIB,
    private readonly billed = 100 * MIB,
  ) {}
  api(): BigQueryLike {
    return {
      createQueryJob: async (o: { dryRun?: boolean }) => {
        if (o.dryRun) {
          this.dry++;
          return [{ metadata: { statistics: { totalBytesProcessed: String(this.est) } } }];
        }
        this.real++;
        const n = this.real;
        return [
          {
            id: `job-${n}`,
            metadata: { statistics: { query: { totalBytesBilled: String(this.billed) } } },
            getQueryResults: async () => [[{ x: n }]],
          },
        ];
      },
    } as unknown as BigQueryLike;
  }
}

function fixture(est?: number) {
  const store = new MemoryObjectStore();
  return { store, archive: new RawArchive(store, null), bq: new FakeBq(est), loads: [] as string[] };
}
const job = (id: string, loads: string[], over: Partial<ForwardJobSpec> = {}): ForwardJobSpec => ({
  id,
  kind: "economics",
  day: "2026-11-10",
  maxBytes: 1024 * MIB,
  prepare: async () => ({
    sql: "SELECT 1 FROM `bigquery-public-data.crypto_near_mainnet_us.blocks` WHERE block_date >= DATE '2026-11-10' AND block_date < DATE '2026-11-11'",
  }),
  load: async () => {
    loads.push(id);
    return 1;
  },
  ...over,
});

describe("flags and scheduling", () => {
  it("every forward job is disabled by default and only the explicit flag enables it", () => {
    expect(forwardFlags({})).toEqual({ economics: false, accounts: false, settlement: false });
    expect(forwardFlags({ NEARESIS_ECONOMICS_DAILY: "1" }).economics).toBe(true);
    expect(forwardFlags({ NEARESIS_ACCOUNTS_DAILY: "0" }).accounts).toBe(false);
    expect(forwardFlags({ NEARESIS_SETTLEMENT_DAILY: "true" }).settlement).toBe(true);
  });
  it("the forward task is never due with nothing pending (flags off) and waits for the daily delay otherwise", () => {
    const st = emptySchedulerState();
    const cfg = loadConfig({});
    const f = { bqPending: 0, pricePending: 0, explorerInflight: false };
    expect(dueTasks(T("2026-11-11T05:00:00Z"), st, cfg, f, ["forward"])).toEqual([]);
    expect(dueTasks(T("2026-11-11T01:00:00Z"), st, cfg, { ...f, forwardPending: 1 }, ["forward"])).toEqual(
      [],
    );
    expect(dueTasks(T("2026-11-11T03:00:00Z"), st, cfg, { ...f, forwardPending: 1 }, ["forward"])).toEqual([
      "forward",
    ]);
  });
  it("pending days need the provider day loaded (no lag gaps) and skip settled ids", () => {
    const state = new ForwardStateStore(tmp());
    const base = {
      kind: "economics",
      day: "",
      estimateBytes: null,
      billedBytes: null,
      jobId: null,
      rawObjectHash: null,
      rows: null,
      completedAtUTC: "x",
      quotaDay: null,
      reason: null,
    } as const;
    for (const f of ["outcomes", "conversion", "gas_price"])
      state.put(`economics:${f}:2026-11-10`, { ...base, status: "loaded" });
    state.put("economics:outcomes:2026-11-11", { ...base, status: "loaded" });
    const now = T("2026-11-14T09:00:00Z"); // last completed day 2026-11-13
    expect(pendingForwardDays(now, "economics", state, (d) => d !== "2026-11-13")).toEqual([
      "2026-11-11",
      "2026-11-12",
    ]);
    expect(pendingForwardDays(T("2026-11-10T09:00:00Z"), "economics", state, () => true)).toEqual([]);
  });
  it("builds the three lean economics jobs for a day, each with its own id", () => {
    const jobs = economicsJobs("2026-11-10", {} as ClickHouseClient);
    expect(jobs.map((j) => j.id)).toEqual([
      "economics:outcomes:2026-11-10",
      "economics:conversion:2026-11-10",
      "economics:gas_price:2026-11-10",
    ]);
  });
});

describe("runForwardJobs", () => {
  it("is idempotent and a restart (new state object on the same file) never bills a settled job again", async () => {
    const f = fixture();
    const path = tmp();
    const loads: string[] = [];
    const run = async () =>
      runForwardJobs({
        bq: f.bq.api(),
        archive: f.archive,
        state: new ForwardStateStore(path),
        ledger: new BudgetLedger(0),
        location: "us-east1",
        jobs: [job("economics:outcomes:2026-11-10", loads)],
        readRaw: (h) => f.store.get(h),
      });
    const a = await run();
    expect(a.loaded).toEqual(["economics:outcomes:2026-11-10"]);
    expect(f.bq.real).toBe(1);
    const b = await run(); // process restart
    expect(b.loaded).toEqual([]);
    expect(f.bq.real).toBe(1);
    expect(f.bq.dry).toBe(1); // not even a dry run for a settled id
    expect(loads).toEqual(["economics:outcomes:2026-11-10"]);
    const e = new ForwardStateStore(path).get("economics:outcomes:2026-11-10");
    expect(e?.status).toBe("loaded");
    expect(e?.jobId).toBe("job-1");
    expect(e?.billedBytes).toBe(100 * MIB);
    expect(e?.rawObjectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a load failure after billing is checkpointed as billed and the next run reloads from the archive without a new job", async () => {
    const f = fixture();
    const path = tmp();
    let fail = true;
    const loads: string[] = [];
    const mk = (): ForwardJobSpec =>
      job("economics:outcomes:2026-11-10", loads, {
        load: async () => {
          if (fail) throw new Error("clickhouse down");
          loads.push("ok");
          return 7;
        },
      });
    const run = () =>
      runForwardJobs({
        bq: f.bq.api(),
        archive: f.archive,
        state: new ForwardStateStore(path),
        ledger: new BudgetLedger(0),
        location: "us-east1",
        jobs: [mk()],
        readRaw: (h) => f.store.get(h),
      });
    await expect(run()).rejects.toThrow("clickhouse down");
    expect(new ForwardStateStore(path).get("economics:outcomes:2026-11-10")?.status).toBe("billed");
    expect(f.bq.real).toBe(1);
    fail = false;
    const r = await run();
    expect(r.reloaded).toEqual(["economics:outcomes:2026-11-10"]);
    expect(f.bq.real).toBe(1); // no re-billing
    expect(new ForwardStateStore(path).get("economics:outcomes:2026-11-10")?.status).toBe("loaded");
    expect(new ForwardStateStore(path).get("economics:outcomes:2026-11-10")?.rows).toBe(7);
  });

  it("defers when the quota ledger has no room, stops the run, and runs the jobs on the next quota day", async () => {
    const f = fixture(500 * MIB);
    const path = tmp();
    const loads: string[] = [];
    const jobs = [job("a", loads), job("b", loads)];
    const full = new BudgetLedger(DAILY_LIMIT_BYTES - 100 * MIB); // 100 MiB left, job needs 500 MiB x 1.02
    const r1 = await runForwardJobs({
      bq: f.bq.api(),
      archive: f.archive,
      state: new ForwardStateStore(path),
      ledger: full,
      location: "us-east1",
      jobs,
      readRaw: (h) => f.store.get(h),
    });
    expect(r1.deferredForBudget.map((x) => x.id)).toEqual(["a"]);
    expect(f.bq.real).toBe(0);
    expect(f.bq.dry).toBe(1); // stopped at the first deferral
    expect(new ForwardStateStore(path).get("a")).toBeUndefined(); // not settled: stays pending
    const r2 = await runForwardJobs({
      bq: f.bq.api(),
      archive: f.archive,
      state: new ForwardStateStore(path),
      ledger: new BudgetLedger(0),
      location: "us-east1",
      jobs,
      readRaw: (h) => f.store.get(h),
    });
    expect(r2.loaded).toEqual(["a", "b"]);
    expect(f.bq.real).toBe(2);
  });

  it("refuses a job whose dry run exceeds its ceiling, records it, and never retries it with other parameters", async () => {
    const f = fixture(2048 * MIB);
    const path = tmp();
    const loads: string[] = [];
    const run = () =>
      runForwardJobs({
        bq: f.bq.api(),
        archive: f.archive,
        state: new ForwardStateStore(path),
        ledger: new BudgetLedger(0),
        location: "us-east1",
        jobs: [job("a", loads, { maxBytes: 1024 * MIB })],
        readRaw: (h) => f.store.get(h),
      });
    const r = await run();
    expect(r.refused).toHaveLength(1);
    expect(f.bq.real).toBe(0);
    expect(new ForwardStateStore(path).get("a")?.status).toBe("refused");
    await run();
    expect(f.bq.dry).toBe(1);
    expect(loads).toEqual([]);
  });

  it("sets maximumBytesBilled from the ledger cap and never below the 10 MiB billing minimum", async () => {
    const caps: string[] = [];
    const bq = {
      createQueryJob: async (o: { dryRun?: boolean; maximumBytesBilled?: string }) => {
        if (o.dryRun) return [{ metadata: { statistics: { totalBytesProcessed: String(2 * MIB) } } }];
        caps.push(String(o.maximumBytesBilled));
        return [
          {
            id: "j",
            metadata: { statistics: { query: { totalBytesBilled: String(10 * MIB) } } },
            getQueryResults: async () => [[]],
          },
        ];
      },
    } as unknown as BigQueryLike;
    const store = new MemoryObjectStore();
    await runForwardJobs({
      bq,
      archive: new RawArchive(store, null),
      state: new ForwardStateStore(tmp()),
      ledger: new BudgetLedger(0),
      location: "us-east1",
      jobs: [job("a", [])],
      readRaw: (h) => store.get(h),
    });
    expect(Number(caps[0])).toBe(10 * MIB);
  });
});

describe("settlement forward job", () => {
  const io = (calls: string[]) => ({
    scratchProject: "p",
    location: "us-east1",
    hashesForDay: async () => {
      calls.push("hashes");
      return ["5".repeat(44)];
    },
    loadScratch: async () => void calls.push("load"),
    deleteScratch: async () => void calls.push("delete"),
    loadDay: async () => 1,
  });
  it("a private-era day is recorded not_applicable with no BigQuery call and no scratch table", async () => {
    const f = fixture();
    const calls: string[] = [];
    const state = new ForwardStateStore(tmp());
    const r = await runForwardJobs({
      bq: f.bq.api(),
      archive: f.archive,
      state,
      ledger: new BudgetLedger(0),
      location: "us-east1",
      jobs: [settlementJob("2026-11-10", io(calls))],
      readRaw: (h) => f.store.get(h),
    });
    expect(r.skipped).toEqual([{ id: "settlement:2026-11-10", reason: "PRIVATE_ERA_CANNOT_COMPUTE" }]);
    expect(f.bq.dry + f.bq.real).toBe(0);
    expect(calls).toEqual([]);
    expect(state.get("settlement:2026-11-10")?.status).toBe("not_applicable");
  });
  it("a public-era day creates the scratch table, bills once and always deletes the scratch table", async () => {
    const f = fixture(50 * MIB);
    const calls: string[] = [];
    const r = await runForwardJobs({
      bq: f.bq.api(),
      archive: f.archive,
      state: new ForwardStateStore(tmp()),
      ledger: new BudgetLedger(0),
      location: "us-east1",
      jobs: [settlementJob("2026-10-19", io(calls))],
      readRaw: (h) => f.store.get(h),
    });
    expect(r.loaded).toEqual(["settlement:2026-10-19"]);
    expect(calls).toEqual(["hashes", "load", "delete"]);
    expect(f.bq.real).toBe(1);
  });
});

describe("accounts forward day", () => {
  const rows = [
    {
      kind: "day_a",
      block_date: "2026-11-10",
      key: null,
      v1: 5,
      v2: 10,
      v3: 0,
      v4: 0,
      v5: 0,
      v6: 3,
      v7: 10,
      v8: 10,
    },
    {
      kind: "day_b",
      block_date: "2026-11-10",
      key: null,
      v1: 3,
      v2: 10,
      v3: 3,
      v4: 10,
      v5: 1,
      v6: 4,
      v7: 1,
      v8: 4,
    },
    { kind: "entity", block_date: "2026-11-10", key: "__unclassified__", v1: 5, v2: 10, v3: 3, v4: 10 },
    { kind: "retention", block_date: "2026-11-09", key: "2026-11-09", v1: 3 },
  ];
  it("loads head, tail and entity with the cohort window start, never new/returning, retention or profile rows", async () => {
    const inserted: Record<string, Array<Record<string, unknown>>> = {};
    const ch = {
      insert: async (o: { table: string; values: Array<Record<string, unknown>> }) => {
        inserted[o.table] = [...(inserted[o.table] ?? []), ...o.values];
      },
    } as unknown as ClickHouseClient;
    await loadForwardAccountDay(
      ch,
      "2026-11-10",
      rows,
      { rawObjectHash: "h", fetchedAtUTC: "2026-11-11T02:00:00.000Z" },
      { head: 100, registryVersion: "r1" },
    );
    expect(inserted.account_daily_tail?.[0]).toMatchObject({
      block_date: "2026-11-10",
      tail_signers: "3",
      window_start: "2025-11-10",
    });
    expect(inserted.entity_daily_signers).toHaveLength(1);
    expect(inserted.account_daily_new_returning).toBeUndefined();
    expect(inserted.account_cohort_week_retention).toBeUndefined();
    expect(inserted.account_head_profile).toBeUndefined();
    const cov = inserted.source_coverage ?? [];
    const nr = cov.find((c) => c.dataset === "account_daily_new_returning");
    expect(nr).toMatchObject({ state: "partial", reason: "NEW_REQUIRES_WINDOW_START_HISTORY" });
    expect(cov.find((c) => c.dataset === "account_daily_head")).toMatchObject({ state: "complete" });
  });
  it("builds a one-day scan job", async () => {
    const j = accountsJob("2026-11-10", {} as ClickHouseClient, async () => ({
      registryVersion: "r1",
      mappings: [
        {
          mappingId: "m1",
          entityId: "e1",
          network: "near",
          matchType: "exact" as const,
          account: "a.near",
          effectiveFrom: "2020-01-01T00:00:00Z",
          effectiveTo: null,
          verification: "verified" as const,
          precedence: 1,
        },
      ],
    }));
    const p = await j.prepare();
    expect("sql" in p && p.sql).toContain("DATE '2026-11-10'");
    expect("sql" in p && p.sql).toContain("DATE '2026-11-11'");
  });
});
