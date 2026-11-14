import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CostGovernor,
  exportLedger,
  scopedSpendGate,
  upsertPolicy,
  withTenant,
  type CostDimension,
} from "@nearesis/agent-runtime";
import type { SpendGate } from "@nearesis/contracts";
import { createTestDatabase, type TestDatabase } from "../../../../packages/workflow/src/db.ts";
import { BigQueryGuard, type BigQueryLike } from "../../src/adapters/bigquery.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { MemoryObjectStore } from "../../src/archive/object-store.ts";
import { BudgetedBigQuery } from "../../src/backfill/bq-runner.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../../src/backfill/budget.ts";
import { planChunks } from "../../src/backfill/plan.ts";
import { setAmbientSpendGate } from "../../src/cost/ambient.ts";
import { gateBigQuery, gateObjectStore } from "../../src/cost/gates.ts";
import { ALLOW_COINGECKO_PRO, ALLOW_ONECLICK, HttpClient } from "../../src/http/client.ts";

/**
 * Block-before-execution on the REAL ingestion adapter code paths, with a real CostGovernor on a disposable Postgres
 * database and stubbed transports (no BigQuery job, HTTP request or paid call ever leaves the machine).
 */
let db: TestDatabase;
let gov: CostGovernor;
const tenant = randomUUID();
const GB = 1e9;

const ws = () => randomUUID();
async function setup(
  workspaceId: string,
  p: Parameters<typeof upsertPolicy>[3],
): Promise<{ gate: SpendGate; ledger: () => ReturnType<typeof exportLedger> }> {
  await withTenant(db.app, tenant, (c) => upsertPolicy(c, tenant, workspaceId, p, new Date()));
  return {
    gate: scopedSpendGate(gov, { tenantId: tenant, workspaceId }),
    ledger: () => withTenant(db.app, tenant, (c) => exportLedger(c, tenant, workspaceId)),
  };
}
const qty = (l: Awaited<ReturnType<typeof exportLedger>>, d: CostDimension, state?: string): number =>
  l.entries
    .filter((e) => e.dimension === d && (state === undefined || e.state === state))
    .reduce((n, e) => n + e.quantity, 0);

beforeAll(async () => {
  db = await createTestDatabase();
  gov = new CostGovernor({ pool: db.app });
}, 120_000);
afterAll(async () => db?.drop());
afterEach(() => setAmbientSpendGate(undefined));

/** Counting BigQuery double: every non-dry job is a provider job (and bills `billedOf(estimate)`). */
function fakeBq(estimate: number, billedOf: (e: number) => number = (e) => e) {
  const jobs: Array<{ dry: boolean; sql: string }> = [];
  const bq: BigQueryLike = {
    getProjectId: async () => "p",
    getDatasetMetadata: async () => ({ location: "us-east1" }),
    async createQueryJob(o) {
      jobs.push({ dry: !!o.dryRun, sql: o.query });
      return [
        {
          id: `j${jobs.length}`,
          metadata: {
            statistics: {
              totalBytesProcessed: String(estimate),
              query: { totalBytesBilled: String(billedOf(estimate)), totalBytesProcessed: String(estimate) },
            },
          },
          getQueryResults: async () => [[{ block_date: { value: "2026-11-01" }, tx_count: 1 }]],
        },
      ];
    },
  };
  return { bq, jobs, billedJobs: () => jobs.filter((j) => !j.dry).length };
}

describe("bigquery_bytes_billed: BudgetedBigQuery (backfill and scheduler runner) and BigQueryGuard", () => {
  it("authorises against the dry-run estimate, settles with billed bytes, and a refused chunk never creates a job", async () => {
    const { gate, ledger } = await setup(ws(), {
      capUsd: 10,
      rates: { bigquery_bytes_billed: 1e-9 }, // $1 per GB
      paidOpsPermitted: ["bigquery_query"],
    });
    const f = fakeBq(4 * GB, (e) => e * 0.5); // estimate 4 GB ($4), billed 2 GB ($2)
    const runner = new BudgetedBigQuery(
      gateBigQuery(f.bq, gate),
      new RawArchive(new MemoryObjectStore(), null),
    );
    const bl = new BudgetLedger(0);
    const chunks = planChunks();
    const done: Awaited<ReturnType<typeof runner.runChunk>>[] = [];
    for (const c of chunks.slice(0, 5)) done.push(await runner.runChunk(c, bl, "us-east1"));
    // each chunk reserves $4 and settles at $2 (billed bytes): four fit under the $10 cap, the fifth reservation does not
    const statuses = done.map((d) => d.status);
    expect(statuses).toEqual(["done", "done", "done", "done", "budget"]);
    expect(done[4]).toMatchObject({ reason: expect.stringContaining("cost governor") });
    // no provider job for any refused chunk: billed jobs == chunks that completed
    expect(f.billedJobs()).toBe(statuses.filter((s) => s === "done").length);
    const l = await ledger();
    expect(qty(l, "bigquery_bytes_billed", "settled")).toBe(f.billedJobs() * 2 * GB); // billed bytes, not estimates
    expect(qty(l, "bigquery_bytes_billed", "reserved")).toBe(0);
    expect(l.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("the paid-operation permission is enforced and a job that fails to start releases its reservation", async () => {
    const { gate, ledger } = await setup(ws(), {
      capUsd: 10,
      rates: { bigquery_bytes_billed: 1e-9 },
      paidOpsPermitted: [],
    });
    const f = fakeBq(GB);
    const runner = new BudgetedBigQuery(
      gateBigQuery(f.bq, gate),
      new RawArchive(new MemoryObjectStore(), null),
    );
    const out = await runner.runChunk(planChunks()[0]!, new BudgetLedger(0), "us-east1");
    expect(out).toMatchObject({ status: "budget", reason: "cost governor: PAID_OP_NOT_PERMITTED" });
    expect(f.billedJobs()).toBe(0);

    const w2 = await setup(ws(), {
      capUsd: 10,
      rates: { bigquery_bytes_billed: 1e-9 },
      paidOpsPermitted: ["bigquery_query"],
    });
    const broken: BigQueryLike = {
      ...f.bq,
      createQueryJob: async (o) => {
        if (o.dryRun) return f.bq.createQueryJob(o);
        throw new Error("provider unavailable");
      },
    };
    const r2 = new BudgetedBigQuery(
      gateBigQuery(broken, w2.gate),
      new RawArchive(new MemoryObjectStore(), null),
    );
    await expect(r2.runChunk(planChunks()[0]!, new BudgetLedger(0), "us-east1")).rejects.toThrow(
      "provider unavailable",
    );
    const l = await w2.ledger();
    expect(qty(l, "bigquery_bytes_billed", "reserved") + qty(l, "bigquery_bytes_billed", "settled")).toBe(0);
    expect(await ledger()).toBeTruthy();
  });

  it("the 95% daily quota guard still applies in front of the governor (governor is in addition)", async () => {
    const { gate } = await setup(ws(), {
      capUsd: 1000,
      rates: { bigquery_bytes_billed: 1e-9 },
      paidOpsPermitted: ["bigquery_query"],
    });
    const f = fakeBq(5 * GB);
    const runner = new BudgetedBigQuery(
      gateBigQuery(f.bq, gate),
      new RawArchive(new MemoryObjectStore(), null),
    );
    const out = await runner.runChunk(planChunks()[0]!, new BudgetLedger(DAILY_LIMIT_BYTES - 1), "us-east1");
    expect(out).toMatchObject({ status: "budget" });
    expect((out as { reason: string }).reason).not.toContain("cost governor");
    expect(f.billedJobs()).toBe(0);
  });

  it("BigQueryGuard.run (adapter path) is gated too", async () => {
    const { gate } = await setup(ws(), {
      capUsd: 0.5,
      rates: { bigquery_bytes_billed: 1e-9 },
      paidOpsPermitted: ["bigquery_query"],
    });
    const f = fakeBq(0.9 * GB); // $0.90 > cap $0.50, under the guard's own 1 GiB per-query cap
    const guard = new BigQueryGuard(gateBigQuery(f.bq, gate), {
      perQueryBytes: 1 * GB,
      totalBytes: 2 * GB,
      maxBilledJobs: 5,
    });
    const sql = (await import("../../src/backfill/sql.ts")).chunkSql(planChunks()[0]!);
    await expect(guard.run(sql, "us-east1")).rejects.toMatchObject({ costReason: "CAP_REACHED" });
    expect(f.billedJobs()).toBe(0);
  });
});

describe("object_storage_gb_month: raw archive writes", () => {
  it("blocks a write before any byte is stored once the dimension limit is reached", async () => {
    const { gate, ledger } = await setup(ws(), {
      capUsd: 100,
      rates: { object_storage_gb_month: 1000 },
      dimensionLimits: { object_storage_gb_month: 2.5e-3 }, // 2.5 MB
    });
    const store = new MemoryObjectStore();
    const archive = new RawArchive(gateObjectStore(store, gate), null);
    const put = (i: number) =>
      archive.archive({
        providerId: "near-bigquery",
        adapterVersion: "t",
        method: "POST",
        url: "https://bigquery.googleapis.com/bigquery/v2/jobs",
        sourceEnvironment: "live",
        fetchedAtUTC: "2026-11-12T00:00:00.000Z",
        receivedAtUTC: "2026-11-12T00:00:00.000Z",
        providerEventAtUTC: null,
        providerEventAtNullReason: "n/a",
        responseStatus: 200,
        contentType: "application/octet-stream",
        payload: Buffer.alloc(1_000_000, i),
        recordsClaimed: 1,
        recordsParsed: 1,
        privacyVisibility: "public",
        completeness: "complete",
      });
    await put(1);
    await put(2);
    await expect(put(3)).rejects.toMatchObject({ costReason: "DIMENSION_LIMIT" });
    expect(await store.has((await import("../../src/hash.ts")).sha256Hex(Buffer.alloc(1_000_000, 3)))).toBe(
      false,
    );
    await put(1); // identical bytes already stored: nothing new to pay for, never refused as a new write
    const l = await ledger();
    expect(qty(l, "object_storage_gb_month", "settled")).toBeCloseTo(2e-3, 9);
  });
});

describe("external_requests and network_egress_bytes: paid HTTP", () => {
  const body = new TextEncoder().encode('{"ok":true}');
  const stub = () => {
    let sent = 0;
    return {
      sent: () => sent,
      fetchImpl: async () => {
        sent++;
        return { status: 200, headers: new Headers(), arrayBuffer: async () => body.buffer as ArrayBuffer };
      },
    };
  };
  const get = (h: HttpClient, host: string) =>
    h.request({ method: "GET", url: `https://${host}/api/v3/ping` });

  it("a paid host is refused before the socket opens without the paid_api permission; permitted calls are metered", async () => {
    const { gate, ledger } = await setup(ws(), {
      capUsd: 1,
      rates: { external_requests: 0.004 },
      paidOpsPermitted: [],
    });
    const s = stub();
    setAmbientSpendGate(gate); // exactly how the CLIs install it (installSpendGateFromEnv)
    const h = new HttpClient({ allow: [ALLOW_COINGECKO_PRO], fetchImpl: s.fetchImpl });
    await expect(get(h, "pro-api.coingecko.com")).rejects.toMatchObject({
      costReason: "PAID_OP_NOT_PERMITTED",
    });
    expect(s.sent()).toBe(0);
    expect(h.requestLog.at(-1)?.outcome).toBe("denied"); // a budget stop, not a "network_error"
    expect((await ledger()).blocks).toHaveLength(1);
  });

  it("stops at the cap: the request that would exceed it never reaches the provider", async () => {
    const { gate, ledger } = await setup(ws(), {
      capUsd: 0.01,
      rates: { external_requests: 0.004 },
      paidOpsPermitted: ["paid_api"],
    });
    const s = stub();
    const h = new HttpClient({
      allow: [ALLOW_COINGECKO_PRO, ALLOW_ONECLICK],
      fetchImpl: s.fetchImpl,
      spend: { gate, paidOp: (host) => (host === "pro-api.coingecko.com" ? "paid_api" : undefined) },
    });
    expect((await get(h, "pro-api.coingecko.com")).status).toBe(200);
    expect((await get(h, "pro-api.coingecko.com")).status).toBe(200);
    await expect(get(h, "pro-api.coingecko.com")).rejects.toMatchObject({ costReason: "CAP_REACHED" });
    expect(s.sent()).toBe(2);
    const l = await ledger();
    expect(qty(l, "external_requests", "settled")).toBe(2);
    expect(qty(l, "network_egress_bytes")).toBe(2 * body.byteLength);
  });
});
