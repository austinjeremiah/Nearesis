import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RawArchive } from "../../src/archive/archive.ts";
import { MemoryObjectStore } from "../../src/archive/object-store.ts";
import type { BigQueryLike } from "../../src/adapters/bigquery.ts";
import { assertGuardedSql } from "../../src/adapters/bigquery-guard.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES, MIB } from "../../src/backfill/budget.ts";
import { BudgetedBigQuery } from "../../src/backfill/bq-runner.ts";
import { assertLive, createLiveCh, receiverRows, transactionRows } from "../../src/backfill/ch.ts";
import { coverageForChunk, runBigQueryPhase } from "../../src/backfill/orchestrator.ts";
import { monthRanges, planChunks, quotaDayStart } from "../../src/backfill/plan.ts";
import { billedSinceSql, receiversSql, transactionsSql } from "../../src/backfill/sql.ts";
import { StateStore } from "../../src/backfill/state.ts";
import { priceWindows, parseHourlyPoints } from "../../src/backfill/price-phase.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "backfill-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Counting double: estimate by chunk start date, records every job with its cap. */
function fakeBq(estimateOf: (sql: string) => number, billedOf: (est: number) => number = (e) => e) {
  const calls: Array<{ dry: boolean; cap?: string; sql: string }> = [];
  const bq: BigQueryLike = {
    getProjectId: async () => "proj-x",
    getDatasetMetadata: async () => ({ location: "us-east1" }),
    async createQueryJob(o) {
      calls.push({
        dry: !!o.dryRun,
        ...(o.maximumBytesBilled ? { cap: o.maximumBytesBilled } : {}),
        sql: o.query,
      });
      const est = estimateOf(o.query);
      return [
        {
          id: `job${calls.length}`,
          metadata: {
            statistics: {
              totalBytesProcessed: String(est),
              query: { totalBytesBilled: String(billedOf(est)), totalBytesProcessed: String(est) },
            },
          },
          getQueryResults: async () => [
            [
              {
                block_date: { value: (/DATE '(\d{4}-\d{2}-\d{2})'/.exec(o.query) ?? [])[1] },
                tx_count: 5,
                distinct_signers: 2,
              },
            ],
          ],
        },
      ];
    },
  };
  return { bq, calls };
}

describe("chunk planning", () => {
  it("splits the 365-day window into calendar months, newest first, transactions before receivers", () => {
    const months = monthRanges("2025-11-10", "2026-11-09");
    expect(months).toHaveLength(13);
    expect(months[0]).toEqual({ from: "2025-11-10", to: "2025-12-01" });
    expect(months.at(-1)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
    const days = months.reduce((n, m) => n + (Date.parse(m.to) - Date.parse(m.from)) / 86_400_000, 0);
    expect(days).toBe(365);
    const plan = planChunks();
    expect(plan).toHaveLength(26);
    expect(plan[0]?.id).toBe("transactions:2026-11-01");
    expect(plan[13]?.family).toBe("receivers");
  });
  it("quota day starts at 08:00 UTC", () => {
    expect(quotaDayStart(Date.parse("2026-11-10T13:00:00Z")).toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(quotaDayStart(Date.parse("2026-11-10T07:59:00Z")).toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });
});

describe("SQL is always partition filtered", () => {
  it("every generated chunk query passes the cost guard", () => {
    for (const c of planChunks()) {
      const sql = c.family === "transactions" ? transactionsSql(c) : receiversSql(c);
      expect(assertGuardedSql(sql).ok).toBe(true);
    }
  });
  it("rejects an unbounded query", () => {
    expect(() =>
      assertGuardedSql("SELECT COUNT(*) FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`"),
    ).toThrow();
  });
  it("budget query only reads INFORMATION_SCHEMA of a validated region", () => {
    expect(billedSinceSql("us-east1", "2026-11-10T08:00:00.000Z")).toContain(
      "INFORMATION_SCHEMA.JOBS_BY_PROJECT",
    );
    expect(() => billedSinceSql("us-east1`; DROP", "2026-11-10T08:00:00.000Z")).toThrow();
  });
});

describe("budget accounting", () => {
  it("refuses an estimate that exceeds the remaining budget (2% margin) and caps jobs at estimate x 1.1", () => {
    const l = new BudgetLedger(DAILY_LIMIT_BYTES - 1000 * MIB);
    expect(l.check(980 * MIB).ok).toBe(true); // 980 x 1.02 = 999.6 fits 1000
    expect(l.check(990 * MIB)).toMatchObject({ ok: false }); // 1009.8 > 1000
    const fit = l.check(100);
    expect(fit).toEqual({ ok: true, maximumBytesBilled: 110 });
  });
  it("decrements by actual billed bytes", () => {
    const l = new BudgetLedger(0);
    l.record("a", 10, 7);
    expect(l.billedToday).toBe(7);
    expect(l.remaining).toBe(DAILY_LIMIT_BYTES - 7);
  });
});

describe("orchestrator: checkpoint, resume and stop on budget", () => {
  it("stops when the next chunks do not fit, then resumes from the checkpoint without re-running done chunks", async () => {
    const dir = tmp();
    const store = new StateStore(join(dir, "state.json"), "2025-11-10", "2026-11-09");
    const archive = new RawArchive(new MemoryObjectStore(), null);
    // every chunk is estimated at 100 MiB; budget has room for exactly two
    const f = fakeBq(() => 100 * MIB);
    const runner = new BudgetedBigQuery(f.bq, archive);
    const ledger = new BudgetLedger(DAILY_LIMIT_BYTES - 210 * MIB);
    const loaded: string[] = [];
    const run = (l: BudgetLedger, s: StateStore) =>
      runBigQueryPhase({
        runner: new BudgetedBigQuery(f.bq, archive),
        store: s,
        ledger: l,
        location: "us-east1",
        sink: async (c) => {
          loaded.push(c.id);
          return 1;
        },
        chunks: planChunks().filter((c) => c.family === "transactions"),
        nowMs: () => Date.parse("2026-11-10T13:00:00Z"),
      });
    void runner;
    const first = await run(ledger, store);
    expect(first.completed).toHaveLength(2);
    expect(first.stopReason).toBe("daily_budget");
    expect(first.remaining).toHaveLength(11);
    // never exceeds the daily limit
    expect(ledger.billedToday).toBeLessThanOrEqual(DAILY_LIMIT_BYTES);
    // every executed job carried a cap of estimate x 1.1
    const caps = f.calls.filter((c) => !c.dry).map((c) => c.cap);
    expect(caps).toEqual([String((100 * MIB * 11) / 10), String((100 * MIB * 11) / 10)]);
    // next day: fresh process, same state file
    const store2 = new StateStore(join(dir, "state.json"), "2025-11-10", "2026-11-09");
    expect(Object.keys(store2.state.chunks)).toHaveLength(2);
    const second = await run(new BudgetLedger(0), store2);
    expect(second.completed).toHaveLength(11);
    expect(second.stopReason).toBe("all_chunks_done");
    expect(new Set(loaded).size).toBe(13); // each chunk loaded exactly once
  });
  it("a billed figure missing from the job is never treated as free", async () => {
    const f = fakeBq(() => 5 * MIB);
    const j = f.bq.createQueryJob.bind(f.bq);
    f.bq.createQueryJob = async (o) => {
      const [job] = await j(o);
      delete job.metadata.statistics?.query?.totalBytesBilled;
      return [job];
    };
    const ledger = new BudgetLedger(0);
    const r = await new BudgetedBigQuery(f.bq, new RawArchive(new MemoryObjectStore(), null)).runChunk(
      planChunks()[0]!,
      ledger,
      "us-east1",
    );
    expect(r.status).toBe("done");
    expect(ledger.billedToday).toBe(Math.ceil((5 * MIB * 11) / 10));
  });
  it("refreshes job metadata when the result returns before billing statistics are populated", async () => {
    const f = fakeBq(() => 5 * MIB);
    const j = f.bq.createQueryJob.bind(f.bq);
    f.bq.createQueryJob = async (o) => {
      const [job] = await j(o);
      if (o.dryRun) return [job];
      delete job.metadata.statistics?.query?.totalBytesBilled;
      (job as unknown as { getMetadata: () => Promise<unknown> }).getMetadata = async () => [
        { statistics: { query: { totalBytesBilled: String(5 * MIB) } } },
      ];
      return [job];
    };
    const ledger = new BudgetLedger(0);
    const r = await new BudgetedBigQuery(f.bq, new RawArchive(new MemoryObjectStore(), null)).runChunk(
      planChunks()[0]!,
      ledger,
      "us-east1",
    );
    expect(r.status).toBe("done");
    expect(ledger.billedToday).toBe(5 * MIB);
  });
  it("days missing from a chunk result become gaps, never zero rows", () => {
    const chunk = planChunks()[0]!; // 2026-11-01..2026-11-10
    const { coverage, gaps } = coverageForChunk(chunk, new Set(["2026-11-01", "2026-11-03"]), 1);
    expect(coverage.filter((c) => c.state === "complete")).toHaveLength(2);
    expect(gaps).toHaveLength(7);
    expect(gaps.every((g) => g.reason_code === "PROVIDER_GAP")).toBe(true);
  });
});

describe("label enforcement and row shaping", () => {
  it("every produced row is LIVE and assertLive refuses anything else", () => {
    const p = { rawObjectHash: "h".repeat(64), fetchedAtUTC: "2026-11-10T13:00:00.000Z" };
    const tx = transactionRows(
      [{ block_date: { value: "2026-11-01" }, tx_count: 5, distinct_signers: "2" }],
      p,
    );
    expect(tx[0]).toMatchObject({ tx_count: "5", distinct_signer_proxy: "2", source_label: "LIVE" });
    const { named, below } = receiverRows(
      [
        { block_date: { value: "2026-11-01" }, receiver_out: "a.near", interactions: 150, receiver_count: 1 },
        { block_date: { value: "2026-11-01" }, receiver_out: null, interactions: 800, receiver_count: 40 },
      ],
      p,
    );
    expect(named).toHaveLength(1);
    expect(below[0]).toMatchObject({ receiver_count: "40", interactions: "800", threshold: 100 });
    expect([...tx, ...named, ...below].every((r) => r.source_label === "LIVE")).toBe(true);
    expect(() => assertLive("t", [{ source_label: "SYNTHETIC" }])).toThrow(/LIVE/);
    expect(() => assertLive("t", [{}])).toThrow(/LIVE/);
  });
  it("never targets the fixture database", () => {
    expect(() => createLiveCh("nearesis")).toThrow(/fixture/);
  });
  it("rejects unsafe integers instead of rounding", () => {
    const p = { rawObjectHash: "h", fetchedAtUTC: "2026-11-10T13:00:00.000Z" };
    expect(() =>
      transactionRows([{ block_date: "2026-11-01", tx_count: 2 ** 60, distinct_signers: 1 }], p),
    ).toThrow();
  });
});

describe("price windows", () => {
  it("covers all 365 days in whole-day windows of at most 89 days", () => {
    const w = priceWindows("2025-11-10", "2026-11-09");
    expect(w[0]?.from).toBe("2025-11-10");
    expect(w.at(-1)?.to).toBe("2026-11-10");
    expect(w.every((x) => (Date.parse(x.to) - Date.parse(x.from)) / 86_400_000 <= 89)).toBe(true);
    expect(w).toHaveLength(5);
  });
  it("parses price points keeping exact decimal text", () => {
    const c = parseHourlyPoints(
      new TextEncoder().encode('{"prices":[[1762732800000,3.0519107318170433e0]]}'),
    );
    expect(c[0]).toMatchObject({ tsMs: 1762732800000, close: "3.0519107318170433" });
  });
});
