/**
 * PERF12: cost accounting and budget-burn stop (ch.13 "Cost model", ch.16b 6.2). Real kernel, API and Postgres
 * (disposable database), real ClickHouse (the isolated stack's `system.query_log` is the CPU/IO meter), the real model
 * path (`LedgerInference` + `CostGovernor` + scripted provider counting every delivery) and mock metered providers
 * for BigQuery (dry-run estimates), paid external calls and OutLayer compute.
 *  - ws_all: all nine ch.13 dimensions are metered (a)
 *  - ws_bq / ws_ai / ws_paid: scripted spend crosses the budget B through BigQuery dry-run estimates, AI tokens (real
 *    model path) and paid external calls; the crossing spend is refused BEFORE execution with a block row and an audit
 *    record, and the ledger never exceeds B plus the declared in-flight allowance (b); a paid operation without
 *    permission is denied (c)
 *  - the burn API (`GET /v1/workspaces/:id/cost/burn`) returns forecast labelled "projection" and per-workspace burn (d)
 *  - ws_storm: 500 alert triggers produce at most the capped number of alerts per window, the rest counted suppressed,
 *    and every sent alert is a `notification.created` event on the workspace journal (e)
 * Negative controls (same judges): a build that checks cost after execution FAILS (b); alerts with the cap off FAIL (e).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { z } from "zod";
import { DRYRUN, sha256Text } from "./_reference.ts";
import { evidenceBase, gateB, referenceB, thr } from "./_b.ts";
import { CH_URL, stack, stackHealthy, useIsolatedEnv } from "./_chaos.ts";

const th = thr("PERF12");
export const BUDGET = th.budgetUsd!;
export const ALLOWANCE = th.inflightAllowanceUsd!;
const API_PORT = 4782;
export const FIXTURE_SPEC = {
  dimensions: 9,
  budgetUsd: BUDGET,
  inflightAllowanceUsd: ALLOWANCE,
  rates: {
    bigquery_bytes_billed: 5e-9,
    external_requests: 0.004,
    ai_tokens: "usdForTokens (0.002 USD per 1k tokens, dev model)",
  },
  bigqueryDryRunBytes: 1_000_000,
  aiMaxTokens: 1000,
  paidCall: "paid_api",
  alertStorm: {
    triggers: th.alertStormTriggers,
    distinctKeys: 50,
    capPerWindow: th.alertCapPerWindow,
    windowSeconds: th.alertWindowSeconds,
  },
  deniedPaidOp: "outlayer_job without permission",
  control: ["post-execution cost check", "alert cap disabled"],
};
const g = gateB(import.meta.url);

/** (b) judgement, pure so the control runs the same code: nothing executed past the limit, spend within B + allowance. */
export const judgeBudget = (a: {
  ledgerUsd: number;
  cap: number;
  allowance: number;
  executedAfterLimit: number;
  blockRecords: number;
  auditRecords: number;
}) => {
  const problems: string[] = [];
  if (a.ledgerUsd > a.cap + a.allowance + 1e-12)
    problems.push(`ledger ${a.ledgerUsd} exceeds ${a.cap} + ${a.allowance}`);
  if (a.executedAfterLimit > 0) problems.push(`${a.executedAfterLimit} calls executed after the limit`);
  if (a.blockRecords < 1) problems.push("no block record");
  if (a.auditRecords < 1) problems.push("no audit record");
  return { ok: problems.length === 0, problems };
};
/** (e) judgement: at most the cap sent per window and sent + suppressed = triggers. */
export const judgeAlerts = (a: { triggers: number; sent: number; suppressed: number; cap: number }) => {
  const problems: string[] = [];
  if (a.sent > a.cap) problems.push(`${a.sent} alerts sent, cap ${a.cap}`);
  if (a.sent + a.suppressed !== a.triggers)
    problems.push(`sent + suppressed = ${a.sent + a.suppressed}, triggers ${a.triggers}`);
  return { ok: problems.length === 0, problems };
};

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamically imported harness handles */
let kdb: any,
  k: any,
  session: any,
  app: any,
  token = "",
  rt: any,
  blocked: string | null = null;
let ar: any;
/* eslint-enable @typescript-eslint/no-explicit-any */
useIsolatedEnv();

beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  let st = await stackHealthy();
  if (!st.ok) {
    stack("up");
    st = await stackHealthy();
  }
  if (!st.ok) {
    blocked = `isolated stack not healthy: ${st.down.join(", ")}`;
    return;
  }
  const kt = await import("../../packages/kernel/test/helpers/index.ts");
  const { buildApp } = await import("../../apps/api/src/index.ts");
  const { makeRt } = await import("../../packages/agent-runtime/test/helpers/rt.ts");
  ar = await import("../../packages/agent-runtime/src/index.ts");
  rt = await makeRt(); // runtime database with a Supervisor and tasks (real budget path)
  kdb = await kt.createTestDb();
  const wf = await import("../../packages/workflow/src/db.ts");
  await wf.migrate(wf.makePool(kdb.adminUrl, 2));
  const org = await kt.seedOrg(kdb.admin, "perf12", { alice: "owner" });
  k = kt.testKernel(kdb);
  await k.boot();
  k.outbox.start();
  session = await kt.loginSession(k, org.users.alice.subject);
  token = await k.devAuth.login(org.users.alice.subject);
  app = await buildApp({ kernel: k, nodeEnv: "test" });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
}, 300_000);
afterAll(async () => {
  k?.outbox.stop?.();
  await app?.close();
  await kdb?.drop?.();
  await rt?.stop?.();
}, 120_000);

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, bytes: Buffer.byteLength(text), json: text ? JSON.parse(text) : null };
};

const chq = async (sql: string) => {
  const u = new URL(CH_URL);
  u.searchParams.set("query", sql);
  const r = await fetch(u, {
    method: "POST",
    headers: { "x-clickhouse-user": "nearesis", "x-clickhouse-key": "nearesis" },
  });
  if (!r.ok) throw new Error(`ch ${r.status}`);
  return r.text();
};

it("PERF12: all dimensions metered, spend blocked before execution at the limit, alert storm capped", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF12", observed: "not executed", blocked: g.reason });
    return;
  }
  if (blocked) {
    observe({ testId: "PERF12", observed: "not executed", blocked });
    return;
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF12 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF12).toBe(fixtureHash);
  const { createWs } = await import("../../packages/kernel/test/helpers/index.ts");
  const {
    CostGovernor,
    kernelAlertSink,
    emitAlert,
    collectClickHouseUsage,
    LedgerInference,
    ScriptedProvider,
  } = ar;
  const tenant: string = session.principal.orgId;
  const sink = kernelAlertSink(k);
  const audit = {
    rows: [] as Array<{ kind: string; reasonCode?: string | null }>,
    write: async (r: { kind: string; reasonCode?: string | null }) => void audit.rows.push(r),
  };
  const gov = new CostGovernor({ pool: kdb.app.pool, audit, sink });
  const mk = async (name: string) => (await createWs(k, session, name)).workspaceId as string;
  const policyOf = (over: Record<string, unknown>) => ({
    capUsd: BUDGET,
    inflightAllowanceUsd: ALLOWANCE,
    ...over,
  });
  const put = async (ws: string, body: Record<string, unknown>) => {
    const r = await api("PUT", `/v1/workspaces/${ws}/cost/policy`, body);
    expect(r.status).toBe(200);
  };
  let egressBytes = 0;
  const burn = async (ws: string) => {
    const r = await api("GET", `/v1/workspaces/${ws}/cost/burn`);
    egressBytes += r.bytes;
    expect(r.status).toBe(200);
    return r.json;
  };

  // ---- (a) ws_all: every dimension metered
  const wsAll = await mk("perf12 all");
  await put(
    wsAll,
    policyOf({
      capUsd: BUDGET * 10,
      rates: { bigquery_bytes_billed: 5e-9, external_requests: 0.004 },
      paidOpsPermitted: ["paid_api", "outlayer_job", "inference"],
    }),
  );
  const base = { tenantId: tenant, workspaceId: wsAll };
  await gov.spend(
    { ...base, key: "all:bq", dimension: "bigquery_bytes_billed", quantity: 1_000_000 },
    async () => ({ result: null, quantity: 800_000 }),
  ); // dry-run estimate 1 MB, billed 0.8 MB
  await gov.spend(
    { ...base, key: "all:ext", dimension: "external_requests", quantity: 1, paidOp: "paid_api" },
    async () => ({ result: null, quantity: 1 }),
  );
  await gov.spend(
    {
      ...base,
      key: "all:ol",
      dimension: "outlayer_compute",
      quantity: 3,
      usd: 0.003,
      paidOp: "outlayer_job",
    },
    async () => ({ result: null, quantity: 2.5, usd: 0.0025 }),
  ); // mock OutLayer job
  // AI tokens through the real model path
  const provider = new ScriptedProvider([
    { match: () => true, respond: () => ({ ok: true }), usage: { inputTokens: 100, outputTokens: 900 } },
  ]);
  // supervisor budget and task for the kernel's tenant (the runtime database holds the run budget ledger)
  const budgetId = randomUUID();
  const runId = randomUUID();
  await ar.withTenant(rt.pool, tenant, (c: { query(t: string, p?: unknown[]): Promise<unknown> }) =>
    c.query(
      "INSERT INTO budgets (id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000000,100000,1000)",
      [budgetId, tenant, wsAll],
    ),
  );
  const roles = ar.loadRoles();
  const root = await rt.sup.createRootTask({
    tenantId: tenant,
    workspaceId: wsAll,
    runId,
    investigationId: randomUUID(),
    budgetId,
    snapshotRef: "s",
    role: "director",
    capabilities: [...ar.INVESTIGATION_GRANT, ...roles.get("director")!.allowedTools],
    budget: { tokens: 500000, toolCalls: 1000, usd: 100 },
  });
  const child = await rt.sup.spawn(
    {
      role: "semantic_analyst",
      objective: "perf12",
      workspaceId: wsAll,
      allowedCapabilities: ["semantic.query@1"],
      maxChildDepth: 0,
      budget: { tokens: 400000, toolCalls: 100, usd: 50 },
    } as never,
    {
      tenantId: tenant,
      runId,
      budgetId,
      parent: {
        taskId: root.taskId,
        depth: 0,
        allowedCapabilities: [...ar.INVESTIGATION_GRANT, "agent.spawn@1"],
      },
      dedupKey: {
        workspaceId: wsAll,
        investigationId: "inv",
        task: "perf12",
        modelVersion: "m",
        inputSnapshot: "s",
      },
      hypothesisId: "h-perf12",
    },
  );
  const task = { taskId: child.taskId };
  const infer = (ws: string, cg: unknown, key: string, ctxOver: Record<string, unknown> = {}) =>
    new LedgerInference(
      provider,
      rt.pool,
      rt.sup,
      {
        tenantId: tenant,
        workspaceId: ws,
        runId,
        budgetId,
        taskId: task.taskId,
        model: "scripted-1",
        ...ctxOver,
      },
      cg,
    ).generate({
      key,
      system: "s",
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 1000,
    });
  await infer(wsAll, gov, "all:ai");
  // ClickHouse CPU and IO from the real query_log (the collector the production meter uses)
  const chDb = `perf12_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  await chq(`CREATE DATABASE ${chDb}`);
  await chq(`CREATE TABLE ${chDb}.t (a UInt64, b String) ENGINE = MergeTree ORDER BY a`);
  await chq(`INSERT INTO ${chDb}.t SELECT number, toString(number) FROM numbers(200000)`);
  const t0 = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 20; i++)
    await chq(`SELECT count(), sum(cityHash64(b)) FROM ${chDb}.t WHERE a > ${i} FORMAT Null`);
  await chq("SYSTEM FLUSH LOGS");
  const usage = await collectClickHouseUsage(
    async (sql: string) =>
      (await chq(`${sql} FORMAT JSONEachRow`))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    { database: chDb, sinceIso: t0 },
  );
  await chq(`DROP DATABASE ${chDb}`);
  expect(usage.length).toBeGreaterThanOrEqual(20);
  for (const r of usage) {
    await gov.observed({
      ...base,
      key: `ch:cpu:${r.queryId}`,
      dimension: "clickhouse_cpu",
      quantity: r.cpuMicros,
    });
    await gov.observed({
      ...base,
      key: `ch:io:${r.queryId}`,
      dimension: "clickhouse_io",
      quantity: r.readBytes,
    });
  }
  const rows = usage;
  // object storage: the real size of a fixture object directory, expressed as GB-month for the current month
  const objDir = mkdtempSync(join(tmpdir(), "perf12-objects-"));
  writeFileSync(join(objDir, "capsule.json"), Buffer.alloc(2_000_000, 1));
  await gov.observed({
    ...base,
    key: "all:obj",
    dimension: "object_storage_gb_month",
    quantity: 2_000_000 / 1e9,
  });
  await gov.observed({ ...base, key: "all:wf", dimension: "workflow_operations", quantity: 42 });
  const allBurn1 = await burn(wsAll); // its own response size is the egress sample
  await gov.observed({
    ...base,
    key: "all:egress",
    dimension: "network_egress_bytes",
    quantity: egressBytes,
  });
  const allBurn = await burn(wsAll);
  const unmetered = allBurn.dimensions
    .filter((d: { quantity: number | null }) => d.quantity === null)
    .map((d: { dimension: string }) => d.dimension);
  expect(allBurn.dimensions).toHaveLength(th.dimensions!);
  expect(unmetered).toEqual([]);

  // ---- (b)/(c) crossing B in three dimensions; every crossing spend refused before execution
  interface Crossing {
    name: string;
    executed: number;
    blockedAt: number;
    ledgerUsd: number;
    executedAfterLimit: number;
    blocks: number;
    audits: number;
  }
  const crossings: Crossing[] = [];
  const crossing = async (name: string, ws: string, step: () => Promise<void>, execCount: () => number) => {
    let blockedAt = -1;
    let afterLimit = 0;
    const auditBefore = audit.rows.length;
    for (let i = 0; i < 400 && blockedAt < 0; i++) {
      const before = execCount();
      try {
        await step();
      } catch (e) {
        if (
          !(e instanceof ar.CostBlockedError) &&
          (e as { reasonCode?: string }).reasonCode !== "BUDGET_EXCEEDED"
        )
          throw e;
        blockedAt = i;
        afterLimit += execCount() - before; // must be 0: refused before execution
      }
    }
    // further attempts keep being refused (hard stop), none executed
    for (let i = 0; i < 5; i++) {
      const before = execCount();
      await step().catch(() => undefined);
      afterLimit += execCount() - before;
    }
    const b = await burn(ws);
    const auditRows = audit.rows.slice(auditBefore).filter((r) => r.kind === "cost.blocked").length;
    crossings.push({
      name,
      executed: execCount(),
      blockedAt,
      ledgerUsd: b.spentUsd + b.reservedUsd,
      executedAfterLimit: afterLimit,
      blocks: b.blocks.total,
      audits: auditRows,
    });
    return b;
  };

  // BigQuery bytes: the dry-run estimate is authorised, the billed bytes settle (never above the estimate here)
  const wsBq = await mk("perf12 bq");
  await put(wsBq, policyOf({ rates: { bigquery_bytes_billed: 5e-9 }, paidOpsPermitted: [] }));
  let bqJobs = 0;
  let bqN = 0;
  const bqB = await crossing(
    "bigquery_bytes_billed",
    wsBq,
    async () => {
      await gov.spend(
        {
          tenantId: tenant,
          workspaceId: wsBq,
          key: `bq:${bqN++}`,
          dimension: "bigquery_bytes_billed",
          quantity: 1_000_000 /* dry run */,
        },
        async () => {
          bqJobs++;
          return { result: null, quantity: 1_000_000 };
        },
      );
    },
    () => bqJobs,
  );

  // AI tokens through the REAL model path (LedgerInference, supervisor budget ledger, scripted provider deliveries)
  const wsAi = await mk("perf12 ai");
  await put(wsAi, policyOf({ rates: {}, paidOpsPermitted: ["inference"] }));
  let aiN = 0;
  const deliveries = () => [...provider.deliveries.keys()].filter((x) => x.startsWith("ai:")).length;
  const aiB = await crossing(
    "ai_tokens",
    wsAi,
    async () => {
      await infer(wsAi, gov, `ai:${aiN++}`);
    },
    deliveries,
  );

  // paid external calls
  const wsPaid = await mk("perf12 paid");
  await put(wsPaid, policyOf({ rates: { external_requests: 0.004 }, paidOpsPermitted: [] }));
  // (c) a paid operation without permission is denied before execution
  let deniedExecuted = 0;
  const denied = await gov
    .spend(
      {
        tenantId: tenant,
        workspaceId: wsPaid,
        key: "paid:denied",
        dimension: "external_requests",
        quantity: 1,
        paidOp: "paid_api",
      },
      async () => {
        deniedExecuted++;
        return { result: null, quantity: 1 };
      },
    )
    .then(
      () => null,
      (e: { costReason?: string }) => e.costReason ?? "error",
    );
  expect(denied).toBe("PAID_OP_NOT_PERMITTED");
  expect(deniedExecuted).toBe(0);
  await put(wsPaid, policyOf({ rates: { external_requests: 0.004 }, paidOpsPermitted: ["paid_api"] }));
  await api("POST", `/v1/workspaces/${wsPaid}/cost/resume`);
  let paidCalls = 0;
  let paidN = 0;
  const paidB = await crossing(
    "external_requests",
    wsPaid,
    async () => {
      await gov.spend(
        {
          tenantId: tenant,
          workspaceId: wsPaid,
          key: `paid:${paidN++}`,
          dimension: "external_requests",
          quantity: 1,
          paidOp: "paid_api",
        },
        async () => {
          paidCalls++;
          return { result: null, quantity: 1 };
        },
      );
    },
    () => paidCalls,
  );
  void bqB;
  void aiB;
  void paidB;

  const verdicts = crossings.map((c) => ({
    c,
    v: judgeBudget({
      ledgerUsd: c.ledgerUsd,
      cap: BUDGET,
      allowance: ALLOWANCE,
      executedAfterLimit: c.executedAfterLimit,
      blockRecords: c.blocks,
      auditRecords: c.audits,
    }),
  }));
  for (const { c, v } of verdicts) {
    expect(c.blockedAt, `${c.name} never blocked`).toBeGreaterThan(0);
    expect(v.problems, c.name).toEqual([]);
  }

  // (d) forecast and per-workspace burn (API contract)
  const bq = await burn(wsBq);
  expect(bq.forecast.label).toBe("projection");
  expect(bq.forecast.method).toBe("linear_to_period_end");
  expect(bq.capUsd).toBe(BUDGET);
  expect(bq.burnFraction).toBeGreaterThan(0.9);
  expect(bq.hardStopped).toBe(true);
  expect(
    typeof bq.forecast.projectedPeriodUsd === "number" || bq.forecast.confidence === "insufficient_data",
  ).toBe(true);
  const ledgerExport = (await api("GET", `/v1/workspaces/${wsBq}/cost/ledger`)).json;
  expect(ledgerExport.blocks.length).toBeGreaterThan(0);

  // ---- (e) alert storm: 500 triggers, capped, counted, delivered on the kernel event path
  const wsStorm = await mk("perf12 storm");
  const caps = {
    maxPerWindow: th.alertCapPerWindow!,
    windowSeconds: th.alertWindowSeconds!,
    cooldownSeconds: th.alertCooldownSeconds!,
  };
  const storm = async (cap: number, ws: string, kind: string) => {
    let sent = 0;
    let suppressed = 0;
    const triggers = th.alertStormTriggers!;
    for (let i = 0; i < triggers; i += 25) {
      const rs = await Promise.all(
        Array.from({ length: Math.min(25, triggers - i) }, (_, j) =>
          emitAlert(
            kdb.app.pool,
            sink,
            {
              tenantId: tenant,
              workspaceId: ws,
              key: `${kind}:${(i + j) % 50}`,
              kind,
              severity: "warning",
              title: "storm",
              detail: { n: i + j },
            },
            { ...caps, maxPerWindow: cap },
            new Date(),
          ),
        ),
      );
      for (const r of rs) {
        if (r.status === "sent") sent++;
        else suppressed++;
      }
    }
    const events = Number(
      (
        await kdb.admin.query(
          "SELECT count(*)::int AS n FROM workspace_events WHERE workspace_id=$1 AND event_type='notification.created' AND payload->>'kind'=$2",
          [ws, kind],
        )
      ).rows[0].n,
    );
    const rowsSent = Number(
      (
        await kdb.admin.query(
          "SELECT count(*)::int AS n FROM runtime.ops_alerts WHERE workspace_id=$1 AND kind=$2 AND status='sent'",
          [ws, kind],
        )
      ).rows[0].n,
    );
    const rowsSuppressed = Number(
      (
        await kdb.admin.query(
          "SELECT count(*)::int AS n FROM runtime.ops_alerts WHERE workspace_id=$1 AND kind=$2 AND status='suppressed'",
          [ws, kind],
        )
      ).rows[0].n,
    );
    return { triggers, sent, suppressed, events, rowsSent, rowsSuppressed };
  };
  const stormRun = await storm(caps.maxPerWindow, wsStorm, "cost.storm");
  const alertVerdict = judgeAlerts({
    triggers: stormRun.triggers,
    sent: stormRun.sent,
    suppressed: stormRun.suppressed,
    cap: caps.maxPerWindow,
  });
  expect(alertVerdict.problems).toEqual([]);
  expect(stormRun.events).toBe(stormRun.sent); // every sent alert is a journal event; suppressed ones are not
  expect(stormRun.rowsSent).toBe(stormRun.sent);
  expect(stormRun.rowsSuppressed).toBe(stormRun.suppressed);

  // ---- negative controls (same judges)
  // 1. a build that checks cost AFTER execution: runs every call, only then compares to the cap
  const naiveLedger = { usd: 0 };
  let naiveExecuted = 0;
  let naiveBlocks = 0;
  let naiveAfterLimit = 0;
  for (let i = 0; i < 40; i++) {
    const overLimit = naiveLedger.usd >= BUDGET;
    naiveExecuted++; // the provider call happens first
    if (overLimit) naiveAfterLimit++;
    naiveLedger.usd += 0.004;
    if (naiveLedger.usd > BUDGET) naiveBlocks++; // the check, too late
  }
  const control1 = judgeBudget({
    ledgerUsd: naiveLedger.usd,
    cap: BUDGET,
    allowance: ALLOWANCE,
    executedAfterLimit: naiveAfterLimit,
    blockRecords: naiveBlocks,
    auditRecords: 0,
  });
  expect(control1.ok).toBe(false);
  expect(control1.problems.length).toBeGreaterThanOrEqual(2);
  // 2. alerts with the cap off
  const wsFlood = await mk("perf12 flood");
  const flood = await storm(10_000, wsFlood, "cost.flood");
  const control2 = judgeAlerts({
    triggers: flood.triggers,
    sent: flood.sent,
    suppressed: flood.suppressed,
    cap: caps.maxPerWindow,
  });
  expect(control2.ok).toBe(false);
  void naiveExecuted;

  if (DRYRUN) {
    process.stderr.write(
      `DRYRUN summary ${JSON.stringify({ crossings, storm: stormRun, flood: { sent: flood.sent }, control1: control1.problems, control2: control2.problems, unmetered, forecast: bq.forecast })}\n`,
    );
    return;
  }
  observe({
    testId: "PERF12",
    observed: `all ${th.dimensions} ch.13 dimensions metered in the ledger (ClickHouse CPU/IO from ${rows.length} real query_log rows; AI tokens through LedgerInference); budget ${BUDGET} USD crossed through ${crossings.map((c) => `${c.name} (blocked at call ${c.blockedAt}, ledger ${c.ledgerUsd.toFixed(4)} USD, ${c.executedAfterLimit} executed after the limit)`).join(", ")}, each refused before execution with block and audit records, ledger <= B + ${ALLOWANCE}; paid operation without permission denied (0 executions); burn API returned a forecast labelled projection (${bq.forecast.confidence}) and per-workspace burn ${(bq.burnFraction * 100).toFixed(0)}%; ${stormRun.triggers} alert triggers -> ${stormRun.sent} sent (cap ${caps.maxPerWindow}) and ${stormRun.suppressed} suppressed, ${stormRun.events} journal events. Controls FAILED as required: post-execution check (${control1.problems.join("; ")}); uncapped alerts (${flood.sent} sent)`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf12 scripted spend (SYNTHETIC)", sha256: fixtureHash, spec: FIXTURE_SPEC },
        concurrency: { alertStormBatch: 25 },
        cacheState: "n/a",
      }),
      hardware: { cpu: cpus()[0]!.model, cores: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30) },
      dimensions: allBurn.dimensions,
      crossings,
      verdicts: verdicts.map((x) => x.v),
      burn: { bq, ai: aiB, paid: paidB },
      ledgerExport: { entries: ledgerExport.entries.length, blocks: ledgerExport.blocks },
      alertStorm: stormRun,
      controls: {
        postExecutionCheck: control1.problems,
        alertFlood: { sent: flood.sent, problems: control2.problems },
      },
      egressBytesMetered: egressBytes,
      allBurnFirst: allBurn1.spentUsd,
    },
  });
}, 900_000);
