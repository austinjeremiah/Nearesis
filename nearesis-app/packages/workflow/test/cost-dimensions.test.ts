import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CostGovernor,
  exportLedger,
  scopedSpendGate,
  upsertPolicy,
  withTenant,
} from "@nearesis/agent-runtime";
import { submitOutlayerJob, type OutlayerTransport } from "../../capsule/src/outlayer-submit.ts";
import { createTestDatabase, type TestDatabase } from "../src/db.ts";
import { BLOCKABLE_ACTIVITIES, meterActivities } from "../src/cost-ops.ts";

/**
 * Block-before-execution for the OutLayer and workflow-operation dimensions on the real adapter code (submitOutlayerJob,
 * meterActivities as wired into createActivities), real CostGovernor, stubbed transport (no OutLayer job is ever submitted).
 */
let db: TestDatabase;
let gov: CostGovernor;
const tenant = randomUUID();
beforeAll(async () => {
  db = await createTestDatabase();
  gov = new CostGovernor({ pool: db.app });
}, 120_000);
afterAll(async () => db?.drop());

const policy = (workspaceId: string, p: Parameters<typeof upsertPolicy>[3]) =>
  withTenant(db.app, tenant, (c) => upsertPolicy(c, tenant, workspaceId, p, new Date()));
const ledger = (workspaceId: string) =>
  withTenant(db.app, tenant, (c) => exportLedger(c, tenant, workspaceId));

describe("outlayer_compute: OutLayer job submission", () => {
  const transport = () => {
    const submitted: string[] = [];
    const t: OutlayerTransport = {
      submit: async (j) => {
        submitted.push(j.jobId);
        return { status: "succeeded", computeUnitsUsed: j.maxComputeUnits / 2, output: { ok: true } };
      },
    };
    return { t, submitted };
  };

  it("a job is a paid operation: refused without permission, never submitted", async () => {
    const w = randomUUID();
    await policy(w, { capUsd: 10, rates: { outlayer_compute: 0.01 }, paidOpsPermitted: [] });
    const { t, submitted } = transport();
    const gate = scopedSpendGate(gov, { tenantId: tenant, workspaceId: w });
    await expect(
      submitOutlayerJob({ transport: t, gate }, { jobId: "job-1", maxComputeUnits: 100, input: {} }),
    ).rejects.toMatchObject({ costReason: "PAID_OP_NOT_PERMITTED" });
    expect(submitted).toEqual([]);
  });

  it("authorises the compute ceiling, settles the units the provider charged, and blocks at the cap", async () => {
    const w = randomUUID();
    await policy(w, { capUsd: 10, rates: { outlayer_compute: 0.01 }, paidOpsPermitted: ["outlayer_job"] });
    const { t, submitted } = transport();
    const gate = scopedSpendGate(gov, { tenantId: tenant, workspaceId: w });
    const job = (n: number) => ({ jobId: `job-${n}`, maxComputeUnits: 600, input: {} }); // reserves $6
    const r1 = await submitOutlayerJob({ transport: t, gate }, job(1)); // settles 300 units = $3
    expect(r1.computeUnitsUsed).toBe(300);
    await submitOutlayerJob({ transport: t, gate }, job(2)); // $3 settled + $6 reserved <= $10; settles to $6 total
    await expect(submitOutlayerJob({ transport: t, gate }, job(3))).rejects.toMatchObject({
      costReason: "CAP_REACHED", // $6 + $6 would be $12 > $10
    });
    expect(submitted).toEqual(["job-1", "job-2"]); // the third job never reached OutLayer
    const l = await ledger(w);
    expect(l.entries.filter((e) => e.state === "settled").reduce((n, e) => n + e.quantity, 0)).toBe(600);
    expect(l.blocks.map((b) => b.reason)).toEqual(["CAP_REACHED"]);
  });

  it("a transport failure before any charge releases the reservation", async () => {
    const w = randomUUID();
    await policy(w, { capUsd: 10, rates: { outlayer_compute: 0.01 }, paidOpsPermitted: ["outlayer_job"] });
    const gate = scopedSpendGate(gov, { tenantId: tenant, workspaceId: w });
    const down: OutlayerTransport = {
      submit: async () => {
        throw new Error("coordinator unreachable");
      },
    };
    await expect(
      submitOutlayerJob({ transport: down, gate }, { jobId: "j", maxComputeUnits: 900, input: {} }),
    ).rejects.toThrow("coordinator unreachable");
    const l = await ledger(w);
    expect(l.entries.filter((e) => e.state === "reserved" || e.state === "settled")).toHaveLength(0);
    // the released $9 is available again
    await submitOutlayerJob(
      { transport: transport().t, gate },
      { jobId: "j2", maxComputeUnits: 900, input: {} },
    );
  });
});

describe("workflow_operations: activities (createActivities wiring)", () => {
  const acts = () => {
    const ran: string[] = [];
    const mk = (n: string) => async (i: { tenantId?: string; workspaceId?: string }) => {
      ran.push(n);
      return { n, i };
    };
    return {
      ran,
      a: {
        planTask: mk("planTask"),
        runRoleTask: mk("runRoleTask"),
        recordRunEvent: mk("recordRunEvent"),
        finishTask: mk("finishTask"),
      },
    };
  };

  it("work-starting activities are authorised before they run and stop at the dimension limit; control activities still run", async () => {
    const w = randomUUID();
    await policy(w, {
      capUsd: 100,
      dimensionLimits: { workflow_operations: 3 },
      rates: { workflow_operations: 0.001 },
    });
    const { a, ran } = acts();
    let n = 0;
    const metered = meterActivities(a, gov, { attemptId: () => `t${++n}` });
    const i = { tenantId: tenant, workspaceId: w, runId: randomUUID() };
    await metered.planTask(i);
    await metered.runRoleTask(i);
    await metered.planTask(i);
    // limit of 3 reached: the 4th work-starting activity is refused BEFORE it executes, as a non-retryable BUDGET_EXCEEDED
    await expect(metered.runRoleTask(i)).rejects.toMatchObject({
      nonRetryable: true,
      type: "BUDGET_EXCEEDED",
    });
    expect(ran).toEqual(["planTask", "runRoleTask", "planTask"]);
    // the workspace is now hard-stopped; bookkeeping still runs so the run can be wound down, and is counted
    await metered.recordRunEvent(i);
    await metered.finishTask(i);
    expect(ran).toEqual(["planTask", "runRoleTask", "planTask", "recordRunEvent", "finishTask"]);
    await expect(metered.planTask(i)).rejects.toMatchObject({ type: "BUDGET_EXCEEDED" });
    const l = await ledger(w);
    const ops = l.entries.filter((e) => e.dimension === "workflow_operations");
    expect(ops.filter((e) => e.state === "settled")).toHaveLength(5);
    expect(l.blocks.length).toBe(2);
  });

  it("an activity without a workspace on its input is not attributable and passes through; the blockable set is the work-starting activities", async () => {
    const { a, ran } = acts();
    const metered = meterActivities(a, gov);
    await metered.planTask({});
    expect(ran).toEqual(["planTask"]);
    expect([...BLOCKABLE_ACTIVITIES].sort()).toEqual(
      ["executePrivilegedAction", "planTask", "reviewEvidence", "runRoleTask", "spawnTask"].sort(),
    );
  });
});
