import { observe } from "@nearesis/acceptance";
import { expect, it } from "vitest";
import { BigQueryGuard, type BigQueryJobLike, type BigQueryLike } from "../../src/adapters/bigquery.ts";
import { ONE_GIB } from "../../src/adapters/bigquery-guard.ts";

/** Counting double at the BigQuery client boundary. The guard under test is real. */
class CountingBq implements BigQueryLike {
  calls: Array<{ dryRun: boolean; maximumBytesBilled?: string; location?: string }> = [];
  constructor(private readonly estimate: number) {}
  async getProjectId() {
    return "discovered-project";
  }
  async getDatasetMetadata() {
    return { location: "discovered-location" };
  }
  async createQueryJob(o: {
    dryRun?: boolean;
    maximumBytesBilled?: string;
    location?: string;
  }): Promise<[BigQueryJobLike]> {
    this.calls.push({ dryRun: !!o.dryRun, maximumBytesBilled: o.maximumBytesBilled, location: o.location });
    return [
      {
        id: "job-1",
        metadata: {
          statistics: {
            totalBytesProcessed: String(this.estimate),
            query: { totalBytesBilled: String(Math.min(this.estimate, 10_000_000)) },
          },
          user_email: "caller@example.invalid",
        },
        getQueryResults: async () => [[{ block_date: "2026-10-01", n: 1 }]],
      },
    ];
  }
}

const T = "`bigquery-public-data.crypto_near_mainnet_us.transactions`";
const RA = "`bigquery-public-data.crypto_near_mainnet_us.receipt_actions`";
const RO = "`bigquery-public-data.crypto_near_mainnet_us.receipt_origin_transaction`";
const good = `SELECT t.block_date, COUNT(*) c FROM ${T} t WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-10-02' GROUP BY 1`;
// ch.20 sample query shape: predicate only on the first of three tables (never executed here)
const ch20 = `DECLARE start_date DATE DEFAULT DATE '2026-08-01'; DECLARE end_date DATE DEFAULT DATE '2026-09-01';
SELECT ra.block_date AS day, COUNT(*) FROM ${RA} ra JOIN ${RO} ro ON ro.receipt_id = ra.receipt_id JOIN ${T} t ON t.transaction_hash = ro.originated_from_transaction_hash
WHERE ra.block_date >= start_date AND ra.block_date < end_date AND ra.action_kind = 'FUNCTION_CALL' GROUP BY day`;

// D10: BigQuery unbounded query -> reject without block_date and estimated cost cap
it("rejects unbounded or over-cap queries with 0 jobs executed, and runs a bounded one under the 1 GiB cap", async () => {
  const rejected: Array<{ name: string; reason: string }> = [];
  const cases: Array<[string, string, number]> = [
    ["no-predicate", `SELECT COUNT(*) FROM ${T}`, 1],
    ["upper-bound-missing", `SELECT COUNT(*) FROM ${T} t WHERE t.block_date >= DATE '2026-10-01'`, 1],
    [
      "join-second-table-unbounded",
      `SELECT 1 FROM ${T} t JOIN ${RA} ra ON ra.x = t.x WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-10-02'`,
      1,
    ],
    ["ch20-sample-three-tables-one-predicate", ch20, 1],
    ["dml", `DELETE FROM ${T} WHERE true`, 1],
  ];
  for (const [name, sql, est] of cases) {
    const bq = new CountingBq(est);
    const g = new BigQueryGuard(bq);
    await expect(g.run(sql, "loc")).rejects.toMatchObject({ code: "BQ_REJECTED" });
    expect(bq.calls.length).toBe(0); // no dry run, no job
    expect(g.jobsExecuted).toBe(0);
    expect(g.dryRunsExecuted).toBe(0);
    rejected.push({ name, reason: "static: missing/unbounded block_date or non-SELECT" });
  }
  // bounded query whose dry-run estimate exceeds the 1 GiB cap: dry run only, 0 billed jobs
  const big = new CountingBq(ONE_GIB + 1);
  const g2 = new BigQueryGuard(big);
  await expect(g2.run(good, "loc")).rejects.toMatchObject({ code: "BQ_REJECTED" });
  expect(big.calls.map((c) => c.dryRun)).toEqual([true]);
  expect(g2.jobsExecuted).toBe(0);
  rejected.push({ name: "estimate-over-cap", reason: "dry-run estimate > 1 GiB" });
  // caller cannot raise the cap above 1 GiB
  expect(
    () =>
      new BigQueryGuard(new CountingBq(1), {
        perQueryBytes: ONE_GIB * 2,
        totalBytes: ONE_GIB * 4,
        maxBilledJobs: 3,
      }),
  ).toThrow();
  // bounded and cheap: executes with maximumBytesBilled <= 1 GiB, in the discovered location
  const ok = new CountingBq(50_000_000);
  const g3 = new BigQueryGuard(ok);
  const d = await g3.discover();
  const run = await g3.run(good, d.datasetLocation);
  expect(ok.calls.map((c) => c.dryRun)).toEqual([true, false]);
  expect(Number(ok.calls[1]!.maximumBytesBilled)).toBeLessThanOrEqual(ONE_GIB);
  expect(ok.calls[1]!.location).toBe("discovered-location");
  expect(g3.jobsExecuted).toBe(1);
  expect(run.rows.length).toBe(1);
  observe({
    testId: "D10",
    observed: `${rejected.length} unsafe queries rejected with BQ_REJECTED and 0 jobs executed (statically: ${cases.length}, 0 dry-runs; over-cap estimate: 1 dry-run, 0 jobs); bounded query ran 1 job with maximumBytesBilled=${ok.calls[1]!.maximumBytesBilled} (<= 1 GiB)`,
    evidence: {
      rejected,
      jobsExecutedOnRejection: 0,
      boundedMaximumBytesBilled: Number(ok.calls[1]!.maximumBytesBilled),
      capBytes: ONE_GIB,
    },
  });
});
