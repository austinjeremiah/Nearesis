/**
 * Live milestone path (directive section 18, steps 7-9): POST /questions -> Temporal -> agent runtime -> composer
 * (live OpenRouter model via near-thesis composeCanvas) -> canvas.preview -> owner approval via the approvals API ->
 * kernel canvas.apply_patch. Gated on NEARESIS_ACCEPT_LIVE=1; spend goes through the shared USD 5 ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePanelSpec } from "@nearesis/canvas-schema";
import { cubeReady, createPg, loadLiveRegistry, loadQuery, LIVE_CUBE_URL_DEFAULT } from "@nearesis/analytics";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "../helpers/harness.ts";

const live = process.env.NEARESIS_ACCEPT_LIVE === "1";
const C01_QUESTION = "investigate NEAR Intents activity after the private-settlement change";

/** The web panel route labels a panel LIVE when it is served by the live layer; its queries address live.* cube members only. */
const liveMembers = () => new Set(loadLiveRegistry().metrics.flatMap((m) => [m.id, m.cubeMember]));

describe.skipIf(!live)("question to canvas (live model)", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true });
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });

  it("completes with four valid persisted panels carrying query provenance", async () => {
    const r = await api.call(
      "POST",
      `/v1/workspaces/${env.workspaceId}/questions`,
      {
        question: C01_QUESTION,
        snapshotPolicy: "pinned",
        budget: { tokens: 200_000, toolCalls: 24, usd: 10 },
      },
      { "idempotency-key": `live-${Date.now()}-abcdef` },
    );
    expect(r.status).toBe(202);
    const { runId, workflowId } = r.json as { runId: string; workflowId: string };

    // the run waits for the owner; the approval request carries the exact patch hash
    const pending = await waitFor(async () => {
      const list = await api.call("GET", `/v1/runs/${runId}/approvals`);
      const first = (
        list.json.approvals as Array<{ approvalId: string; actionHash: string }> | undefined
      )?.[0];
      if (first) return first;
      const view = (await api.call("GET", `/v1/runs/${runId}`)).json;
      if (view.terminal)
        throw new Error(`run ended ${String(view.state)} before approval: ${JSON.stringify(view.failure)}`);
      return undefined;
    }, 240_000);
    const before = await env.kernel!.kernelAdmin.query(
      "SELECT count(*)::int AS n FROM canvas_patches WHERE workspace_id=$1",
      [env.workspaceId],
    );
    expect(before.rows[0].n).toBe(0); // nothing applied before approval
    const d = await api.call("POST", `/v1/runs/${runId}/approvals/${pending.approvalId}`, {
      decision: "approve",
      actionHash: pending.actionHash,
    });
    expect(d.status).toBe(202);
    const res = await env.client.workflow.getHandle(workflowId).result();
    expect(res.state).toBe("COMPLETE");

    const doc = await env.kernel!.kernel.canvas.get(env.kernel!.session, env.workspaceId);
    expect(doc.panels).toHaveLength(4);
    for (const panel of doc.panels) {
      expect(validatePanelSpec(panel).ok).toBe(true);
      expect((panel as { queryRef: { hash: string } }).queryRef.hash).toMatch(/^[0-9a-f]{64}$/);
      expect((panel as { provenanceRequired: boolean }).provenanceRequired).toBe(true);
    }
    const run = await q<{ snapshot_ref: string }>(
      env,
      env.tenantId,
      "SELECT snapshot_ref FROM runs WHERE id=$1",
      [runId],
    );
    expect(run[0]!.snapshot_ref.startsWith("pinned:")).toBe(true);
  }, 480_000);
});

/**
 * LIVE data variant (contracts 1.4.0 `source: "live"`): the worker's agents discover, query and preview against cube-live,
 * so every persisted panel's saved query addresses live metrics only (what the web labels LIVE).
 * Same shared USD 5 ledger; skipped unless NEARESIS_ACCEPT_LIVE=1 and cube-live (:4001) is reachable.
 */
const liveCube = live ? await cubeReady(LIVE_CUBE_URL_DEFAULT) : false;
describe.skipIf(!live || !liveCube)("question to canvas (LIVE data source)", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true });
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });

  it("persists panels whose source_label is LIVE (live cube members, real snapshots)", async () => {
    const r = await api.call(
      "POST",
      `/v1/workspaces/${env.workspaceId}/questions`,
      {
        question: "How has NEAR network activity and the NEAR price moved over the last 90 days?",
        snapshotPolicy: "pinned",
        source: "live",
        budget: { tokens: 200_000, toolCalls: 24, usd: 10 },
      },
      { "idempotency-key": `live-data-${Date.now()}-abcdef` },
    );
    expect(r.status).toBe(202);
    const { runId, workflowId } = r.json as { runId: string; workflowId: string };
    const pending = await waitFor(async () => {
      const list = await api.call("GET", `/v1/runs/${runId}/approvals`);
      const first = (
        list.json.approvals as Array<{ approvalId: string; actionHash: string }> | undefined
      )?.[0];
      if (first) return first;
      const view = (await api.call("GET", `/v1/runs/${runId}`)).json;
      if (view.terminal)
        throw new Error(`run ended ${String(view.state)} before approval: ${JSON.stringify(view.failure)}`);
      return undefined;
    }, 240_000);
    const d = await api.call("POST", `/v1/runs/${runId}/approvals/${pending.approvalId}`, {
      decision: "approve",
      actionHash: pending.actionHash,
    });
    expect(d.status).toBe(202);
    expect((await env.client.workflow.getHandle(workflowId).result()).state).toBe("COMPLETE");

    const stored = await q<{ source: string }>(env, env.tenantId, "SELECT source FROM runs WHERE id=$1", [
      runId,
    ]);
    expect(stored[0]!.source).toBe("live");
    const doc = await env.kernel!.kernel.canvas.get(env.kernel!.session, env.workspaceId);
    expect(doc.panels.length).toBeGreaterThanOrEqual(1);
    const members = liveMembers();
    const pg = createPg();
    try {
      for (const panel of doc.panels) {
        expect(validatePanelSpec(panel).ok).toBe(true);
        const hash = (panel as { queryRef: { hash: string } }).queryRef.hash;
        const saved = await loadQuery(pg, hash);
        expect(saved, `query ${hash} is recorded`).toBeTruthy();
        const measures = (saved!.ast as { measures: string[] }).measures;
        // source_label LIVE: the query addresses the live layer only (a fixture query would address fixture cubes)
        expect(measures.length).toBeGreaterThan(0);
        expect(
          measures.every((m) => members.has(m)),
          JSON.stringify(measures),
        ).toBe(true);
      }
    } finally {
      await pg.end();
    }
  }, 480_000);
});
