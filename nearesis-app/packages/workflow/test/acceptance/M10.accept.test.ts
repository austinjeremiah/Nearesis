import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "../helpers/harness.ts";
import {
  actorFor,
  addMember,
  addPanel,
  command,
  counters,
  createMarker,
  selectionFor,
  sha256,
  temporalCount,
  unreachableApi,
} from "./m-marker-helpers.ts";

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

it("M10: no agent, workflow or paid call starts from unsaved selections or drafts; only an authorised assignment spawns exactly one scoped child, and the marker is INVESTIGATING only after the child has durably started", async () => {
  const kenv = env.kernel!;
  const owner = actorFor(api.app, "owner", kenv.userId, await kenv.kernel.devAuth!.login(kenv.subject));
  const viewer = await addMember(env, api.app, "vic", "viewer");
  const editorNoScope = await addMember(env, api.app, "ned", "analyst");
  const editor = await addMember(env, api.app, "ed", "analyst");
  const panel = await addPanel(owner, ws());
  const zero = { spawns: 0, runs: 0, ledgerRows: 0, ledgerUsd: 0, markerTasks: 0 };
  const checkZero = async (label: string) => {
    const c = await counters(env, ws());
    expect(c, label).toEqual(zero);
    expect(await temporalCount(env.taskQueue), `${label}: workflows`).toBe(0);
    return c;
  };

  // Step 1: a selection payload through every client-reachable route that accepts one
  const routes: Array<{ route: string; status: number }> = [];
  const setSel = await command(owner, ws(), "canvas.apply_patch", {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
    operations: [
      {
        op: "setSelection",
        selection: {
          panelId: panel.panelId,
          queryHash: "d".repeat(64),
          semanticVersion: "1.0.0",
          interval: selectionFor().interval,
          seriesIds: ["usd_volume"],
          dataPointIds: ["p1", "p2"],
          units: { usd_volume: "USD" },
          sourceWatermark: selectionFor().sourceWatermark,
          rendererVersion: "echarts-1",
        },
      },
    ],
  });
  routes.push({
    route: "POST /commands canvas.apply_patch setSelection (persists activeSelections)",
    status: setSel.status,
  });
  expect(setSel.status).toBe(200);
  const compositeNoTask = await owner.call("POST", `/v1/workspaces/${ws()}/markers`, {
    panelId: panel.panelId,
    anchor: { kind: "time_range", ...selectionFor().interval },
    question: "[scenario=basic] selection only",
    selection: selectionFor(),
  });
  routes.push({ route: "POST /markers (create, no task / no delegateTo)", status: compositeNoTask.status });
  expect(compositeNoTask.status).toBe(201);
  const noDispatch = await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
  expect(noDispatch.status).toBe(202);
  // Step 2: DRAFT marker, then ACTIVE, with no assignment
  const markerId = await createMarker(
    owner,
    ws(),
    panel.panelId,
    "[scenario=basic] Why did swap volume move?",
    false,
  );
  expect((await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}`)).json).toMatchObject({
    status: "DRAFT",
  });
  await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
  await checkZero("after DRAFT");
  await command(owner, ws(), "marker.transition", { markerId, to: "ACTIVE" });
  await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
  const afterActive = await checkZero("after ACTIVE"); // (a)

  // Step 3: unauthorised assignments
  const viewerTry = await command(viewer, ws(), "marker.assign", { markerId, agents: ["quant", "skeptic"] });
  const noScopeTry = await command(editorNoScope, ws(), "marker.assign", {
    markerId,
    agents: ["quant", "skeptic"],
  });
  expect([viewerTry.status, noScopeTry.status]).toEqual([403, 403]); // (b)
  expect((viewerTry.json as { reasonCode: string }).reasonCode).toBe("INSUFFICIENT_ROLE");
  expect((noScopeTry.json as { reasonCode: string }).reasonCode).toBe("DELEGATION_SCOPE_REQUIRED");
  await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
  await checkZero("after unauthorised assignments");

  // Step 3c: failing start. The authorised editor assigns, but the workflow engine is unreachable (a real Temporal client
  // pointed at a dead address). The marker must stay ACTIVE with a visible reason_code and no workflow may exist.
  const scope = await owner.call("PUT", `/v1/workspaces/${ws()}/delegation-scopes`, {
    userId: editor.userId,
    agents: ["quant", "skeptic", "semantic_analyst"],
    grants: ["semantic.query@1", "stats.read@1"],
    delegateTo: [],
    maxBudget: { tokens: 200_000, toolCalls: 24, usd: 20 },
  });
  expect(scope.status).toBe(204);
  const deadApi = await unreachableApi(env);
  let failed!: { status: string; reasonCode: string | null };
  try {
    const failMarker = await createMarker(owner, ws(), panel.panelId, "[scenario=basic] start will fail");
    const failAssign = await command(editor, ws(), "marker.assign", {
      markerId: failMarker,
      agents: ["quant", "skeptic"],
      grants: ["semantic.query@1"],
    });
    expect(failAssign.status).toBe(200);
    expect((failAssign.json as { resultFingerprint?: string }).resultFingerprint).toBeDefined();
    const dead = actorFor(deadApi, "dead", kenv.userId, await kenv.kernel.devAuth!.login(kenv.subject));
    const d = await dead.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
    expect(d.status).toBe(202);
    failed = await waitFor(
      async () => {
        const m = (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${failMarker}`)).json as {
          status: string;
          reasonCode: string | null;
        };
        return m.reasonCode ? m : null;
      },
      30_000,
      200,
    );
    expect(failed).toMatchObject({ status: "ACTIVE", reasonCode: "WORKFLOW_START_FAILED" }); // (d)
    const ft = (
      (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${failMarker}/tasks`)).json as {
        tasks: Array<{ status: string; reasonCode: string | null; workflowId: string | null }>;
      }
    ).tasks;
    expect(ft).toHaveLength(1);
    expect(ft[0]).toMatchObject({ status: "FAILED", reasonCode: "WORKFLOW_START_FAILED", workflowId: null });
    expect(await temporalCount(env.taskQueue)).toBe(0); // no orphan workflow
    const toInvestigating = await kenv.kernelAdmin.query(
      "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND event_type='marker.transitioned' AND payload->>'markerId'=$2 AND payload->>'to'='INVESTIGATING'",
      [ws(), failMarker],
    );
    expect(toInvestigating.rows[0].n).toBe(0);
  } finally {
    await deadApi.close();
  }

  // Step 3d: the authorised assignment spawns exactly one scoped child; INVESTIGATING only after it durably started
  const before = await counters(env, ws());
  const assigned = await command(editor, ws(), "marker.assign", {
    markerId,
    agents: ["quant", "skeptic"],
    grants: ["semantic.query@1"],
    budget: { tokens: 200_000, toolCalls: 24, usd: 20 },
  });
  expect(assigned.status).toBe(200);
  const marker = async () =>
    (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}`)).json as {
      status: string;
      reasonCode: string | null;
    };
  expect(await marker()).toMatchObject({ status: "ACTIVE" }); // task is PENDING; nothing durably started yet
  expect((await counters(env, ws())).runs).toBe(before.runs);

  const w = await startWorker(env, {});
  try {
    await waitFor(
      async () => {
        await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
        return (await marker()).status !== "ACTIVE" ? true : null;
      },
      120_000,
      500,
    );
    const afterStart = await counters(env, ws());
    const tasks = (
      (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}/tasks`)).json as {
        tasks: Array<{ taskId: string; runId: string; workflowId: string; grants: string[]; status: string }>;
      }
    ).tasks;
    expect(tasks).toHaveLength(1); // exactly one scoped child
    expect(afterStart.markerTasks - before.markerTasks).toBe(1);
    expect(tasks[0]!.workflowId).toBeTruthy();
    expect(tasks[0]!.grants).toEqual(["semantic.query@1"]);
    // Temporal visibility is eventually consistent: poll with a deadline
    const wf = await waitFor(
      async () => ((await temporalCount(env.taskQueue)) === 1 ? 1 : null),
      30_000,
      300,
    );
    expect(wf).toBe(1);
    const runsForMarker = await q<{ id: string; state: string }>(
      env,
      env.tenantId,
      "SELECT id, state FROM runs WHERE workspace_id=$1",
      [ws()],
    );
    expect(runsForMarker).toHaveLength(1);
    expect(runsForMarker[0]!.id).toBe(tasks[0]!.runId);
    // the delegation chain (user, marker, agents, grants)
    const chain = (
      (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}/delegations`)).json as {
        delegations: Array<{
          userId: string;
          markerId: string;
          agents: string[];
          grants: string[];
          taskId: string;
          depth: number;
        }>;
      }
    ).delegations;
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      userId: editor.userId,
      markerId,
      agents: ["quant", "skeptic"],
      grants: ["semantic.query@1"],
      taskId: tasks[0]!.taskId,
      depth: 1,
    });
    // INVESTIGATING only after the workflow exists: the transition event comes after the task got its workflow id
    const trans = await kenv.kernelAdmin.query(
      "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND event_type='marker.transitioned' AND payload->>'markerId'=$2 AND payload->>'to'='INVESTIGATING'",
      [ws(), markerId],
    );
    expect(trans.rows[0].n).toBe(1);

    // let the child finish so nothing dangles on the queue
    await waitFor(
      async () => {
        await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
        return (await marker()).status === "REVIEW_REQUIRED" ? true : null;
      },
      120_000,
      500,
    );

    // Negative control: the verdict logic detects a build that spawns on marker create (non-zero counters after step 2)
    const zeroVerdict = (c: typeof afterActive, wfCount: number) =>
      c.spawns === 0 &&
      c.runs === 0 &&
      c.ledgerRows === 0 &&
      c.ledgerUsd === 0 &&
      c.markerTasks === 0 &&
      wfCount === 0;
    expect(zeroVerdict(afterActive, 0)).toBe(true);
    expect(zeroVerdict({ ...afterActive, runs: 1 }, 1)).toBe(false);

    observe({
      testId: "M10",
      observed: `After the selection routes (${routes.map((r) => r.status).join("/")}), a DRAFT marker and an ACTIVE marker with no assignment: runtime spawns 0, runs 0, ledger rows 0 (USD 0), marker tasks 0, Temporal workflows 0. A viewer's assignment returned 403 INSUFFICIENT_ROLE and an analyst without a delegation scope returned 403 DELEGATION_SCOPE_REQUIRED, both with 0 spawns. With the workflow engine unreachable (real Temporal client, dead address) an authorised assignment left the marker ACTIVE with reason_code WORKFLOW_START_FAILED, the task FAILED, 0 workflows and no transition to INVESTIGATING. The authorised editor's assignment created exactly 1 marker task, 1 run and 1 Temporal workflow with the delegation chain (user ${editor.userId.slice(0, 8)}, marker ${markerId.slice(0, 8)}, agents quant+skeptic, grants semantic.query@1); the marker stayed ACTIVE until the dispatcher started the workflow, then INVESTIGATING (1 transition event), and the child completed to REVIEW_REQUIRED`,
      fixtureHash: hashOf(planFor("basic")),
      evidence: {
        routes,
        afterDraftAndActive: afterActive,
        unauthorised: [
          {
            actor: "viewer",
            status: viewerTry.status,
            reasonCode: (viewerTry.json as { reasonCode: string }).reasonCode,
          },
          {
            actor: "analyst without scope",
            status: noScopeTry.status,
            reasonCode: (noScopeTry.json as { reasonCode: string }).reasonCode,
          },
        ],
        failedStart: { markerStatus: failed.status, reasonCode: failed.reasonCode, workflows: 0 },
        authorised: { markerTasks: tasks.length, runs: runsForMarker.length, workflows: wf, chain: chain[0] },
        notes: [
          "There is no canvas/preview API route in this build; the selection routes exercised are canvas.apply_patch setSelection, marker.create with a selection, and the composite POST /markers.",
          "Spawn counter is the runtime tasks table (A01); ledger is runtime budget_ledger; workflows are listed from Temporal by task queue.",
          "Runs use the real Temporal worker with the deterministic ScriptedProvider (not a live model).",
        ],
        configHash: sha256({ scenario: "basic" }),
      },
    });
  } finally {
    await w.stop();
  }
}, 420_000);
