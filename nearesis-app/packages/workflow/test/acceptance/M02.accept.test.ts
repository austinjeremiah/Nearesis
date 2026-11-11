import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "@nearesis/contracts";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "../helpers/harness.ts";

let env: Env;
let api: Api;
beforeAll(async () => {
  env = await makeEnv({ kernel: true });
  api = await startApi(env);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await env.stop();
});

const ws = () => env.workspaceId;
async function command(commandType: string, payload: Record<string, unknown>) {
  const v = ((await api.call("GET", `/v1/workspaces/${ws()}`)).json as { version: number }).version;
  const r = await api.call("POST", `/v1/workspaces/${ws()}/commands`, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType,
    payload,
    expectedVersion: v,
  });
  return r;
}

it("M02: an agent assigned to a marker runs a scoped child investigation whose output links to the marker's evidence", async () => {
  const panel = PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Swap volume",
    queryRef: { hash: "d".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: {
      fields: ["day", "usd_volume"],
      units: { usd_volume: "USD" },
      timezone: "UTC",
      completeness: "complete",
    },
    encoding: { x: "day", y: ["usd_volume"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });
  expect(
    (
      await command("canvas.apply_patch", {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [{ op: "addPanel", panel }],
      })
    ).status,
  ).toBe(200);

  const markerId = randomUUID();
  const interval = { start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" };
  expect(
    (
      await command("marker.create", {
        panelId: panel.panelId,
        markerId,
        anchor: { kind: "time_range", ...interval },
        question: "[scenario=basic] Why did swap volume move in this week?",
        selection: {
          queryHash: "d".repeat(64),
          semanticVersion: "1.0.0",
          interval,
          seriesIds: ["usd_volume"],
          axisUnits: { usd_volume: "USD" },
          sourceWatermark: interval.end,
        },
      })
    ).status,
  ).toBe(200);

  // Scope guards: a drafted marker cannot be assigned; evidence that does not exist cannot be linked.
  const early = await command("marker.assign", { markerId, agents: ["quant", "skeptic"] });
  expect(early.status).toBe(422);
  expect((early.json as { reasonCode: string }).reasonCode).toBe("MARKER_NOT_ACTIVE");
  const orphan = await command("marker.link_evidence", { markerId, evidenceIds: [randomUUID()] });
  expect((orphan.json as { reasonCode: string }).reasonCode).toBe("EVIDENCE_NOT_FOUND");
  expect((await command("marker.transition", { markerId, to: "ACTIVE" })).status).toBe(200);
  const assigned = await command("marker.assign", {
    markerId,
    agents: ["quant", "skeptic"],
    budget: { tokens: 200_000, toolCalls: 24, usd: 20 },
  });
  expect(assigned.status).toBe(200);

  const w = await startWorker(env, {});
  try {
    const marker = async () =>
      (await api.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}`)).json as {
        status: string;
        linkedEvidenceIds: string[];
        assignedAgents: string[];
      };
    expect((await marker()).status).toBe("INVESTIGATING");
    // The dispatcher starts the child run, then reconciles it once terminal.
    const done = await waitFor(
      async () => {
        const d = await api.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
        expect(d.status).toBe(202);
        const m = await marker();
        return m.status === "REVIEW_REQUIRED" ? m : null;
      },
      120_000,
      500,
    );

    const tasks = (
      (await api.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}/tasks`)).json as {
        tasks: Array<{ status: string; runId: string; workflowId: string; origin: string; mode: string }>;
      }
    ).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "COMPLETE", origin: "assign", mode: "live" });
    const runId = tasks[0]!.runId;

    const run = await q<{ workspace_id: string; state: string }>(
      env,
      env.tenantId,
      "SELECT workspace_id, state FROM runs WHERE id=$1",
      [runId],
    );
    expect(run[0]).toMatchObject({ workspace_id: ws(), state: "COMPLETE" });
    const kids = await q<{ id: string; output_ref: string | null; role: string }>(
      env,
      env.tenantId,
      "SELECT id, output_ref, role FROM tasks WHERE run_id=$1 AND depth>0 AND output_ref IS NOT NULL",
      [runId],
    );
    expect(kids.length).toBeGreaterThan(0);

    const ev = await env.kernel!.kernelAdmin.query(
      "SELECT id, kind, data FROM evidence_nodes WHERE workspace_id=$1 AND id = ANY($2::uuid[])",
      [ws(), done.linkedEvidenceIds],
    );
    expect(done.linkedEvidenceIds).toHaveLength(kids.length);
    expect(ev.rows).toHaveLength(kids.length);
    for (const row of ev.rows) {
      expect(row.data.markerId).toBe(markerId);
      expect(row.data.runId).toBe(runId);
      expect(kids.some((k) => k.id === row.data.agentTaskId && k.output_ref === row.data.outputRef)).toBe(
        true,
      );
    }
    const edges = await env.kernel!.kernelAdmin.query(
      "SELECT to_node FROM evidence_edges WHERE workspace_id=$1 AND from_node=$2 AND relation='references'",
      [ws(), markerId],
    );
    expect(edges.rows.map((r) => r.to_node).sort()).toEqual([...done.linkedEvidenceIds].sort());
    const budget = await q<{ tokens_total: number; tool_calls_total: number; usd_total: string }>(
      env,
      env.tenantId,
      "SELECT b.tokens_total, b.tool_calls_total, b.usd_total FROM budgets b JOIN runs r ON r.budget_id=b.id WHERE r.id=$1",
      [runId],
    );
    expect(Number(budget[0]!.tokens_total)).toBeLessThanOrEqual(200_000);
    expect(Number(budget[0]!.usd_total)).toBeLessThanOrEqual(20);

    // Re-dispatching a finished task starts nothing and links nothing more.
    await api.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
    expect((await marker()).linkedEvidenceIds).toEqual(done.linkedEvidenceIds);
    expect(
      (
        (await api.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}/tasks`)).json as {
          tasks: unknown[];
        }
      ).tasks,
    ).toHaveLength(1);

    observe({
      testId: "M02",
      observed: `marker ACTIVE -> assign [quant, skeptic] -> INVESTIGATING; dispatcher started 1 child run ${runId.slice(0, 8)} in workspace ${ws().slice(0, 8)} (budget <= 200k tokens / 24 calls / USD 20); run ${run[0]!.state} with ${kids.length} agent outputs; ${done.linkedEvidenceIds.length} evidence nodes each carry markerId, runId and the agent task's outputRef; marker -> REVIEW_REQUIRED with linkedEvidenceIds = those nodes (+ references edges); draft assign and orphan evidence rejected; re-dispatch is a no-op (1 task)`,
      fixtureHash: hashOf(planFor("basic")),
      evidence: {
        markerId,
        runId,
        status: done.status,
        linkedEvidenceIds: done.linkedEvidenceIds,
        agentOutputs: kids.map((k) => ({ taskId: k.id, role: k.role, outputRef: k.output_ref })),
        engine: "real Temporal worker with the deterministic ScriptedProvider (not a live model)",
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
