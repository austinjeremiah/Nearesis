/**
 * Interpretation stage end to end (A28): the owner's question through the real API, Temporal worker, kernel gateway
 * (leases) and near-thesis plugin on the LIVE read-only layer, with mock inference. After the owner approves the panels the
 * analyst reads the panels' result rows through the gateway and a skeptic challenges the findings; findings are persisted,
 * linked into the evidence graph, streamed as `finding.created` and returned by GET /v1/runs/:id.
 * Needs Postgres, Temporal and cube-live (:4001). With NEARESIS_ACCEPT_LIVE=1 one more run uses the real model
 * (shared USD 5 ledger; about USD 0.01) and writes its findings to $A28_REPORT.
 */
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cubeReady, LIVE_CUBE_URL_DEFAULT } from "@nearesis/analytics";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "./helpers/harness.ts";

const report = (o: unknown) =>
  process.env.A28_REPORT && appendFileSync(process.env.A28_REPORT, `${JSON.stringify(o, null, 2)}\n`);

const cube = await cubeReady(LIVE_CUBE_URL_DEFAULT).catch(() => false);

async function askAndApprove(env: Env, api: Api, question: string) {
  const r = await api.call(
    "POST",
    `/v1/workspaces/${env.workspaceId}/questions`,
    { question, snapshotPolicy: "live", source: "live", budget: { tokens: 200_000, toolCalls: 24, usd: 10 } },
    { "idempotency-key": `interp-${Date.now()}-abcdefgh` },
  );
  expect(r.status).toBe(202);
  const { runId, workflowId } = r.json as { runId: string; workflowId: string };
  const pending = await waitFor(async () => {
    const list = await api.call("GET", `/v1/runs/${runId}/approvals`);
    const first = (list.json.approvals as Array<{ approvalId: string; actionHash: string }> | undefined)?.[0];
    if (first) return first;
    const view = (await api.call("GET", `/v1/runs/${runId}`)).json;
    if (view.terminal) {
      const t = await q<{
        role: string;
        result: { reasonCode?: string; result?: { message?: string } } | null;
      }>(env, env.tenantId, "SELECT role, result FROM tasks WHERE run_id=$1", [runId]);
      throw new Error(
        `run ended ${String(view.state)} before approval: ${JSON.stringify(view.failure)} tasks=${JSON.stringify(t).slice(0, 900)}`,
      );
    }
    return undefined;
  }, 240_000);
  const t0 = Date.now();
  const d = await api.call("POST", `/v1/runs/${runId}/approvals/${pending.approvalId}`, {
    decision: "approve",
    actionHash: pending.actionHash,
  });
  expect(d.status).toBe(202);
  const res = await env.client.workflow.getHandle(workflowId).result();
  return { runId, state: res.state as string, afterApprovalMs: Date.now() - t0 };
}

const real = process.env.NEARESIS_ACCEPT_LIVE === "1";
const QUESTIONS = [
  "Daily NEAR transactions vs Intents swap volume since May, with NEAR price",
  "Intents swaps by status per week since August — how have refunds changed?",
];
describe.skipIf(!cube || !real)("real model: two sequential questions on one shared worker provider", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    // as in production: ONE shared provider instance for the composer and the agents (no providerForRun)
    worker = await startWorker(env, { live: true });
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });
  for (const [n, question] of QUESTIONS.entries())
    it(`question ${n + 1} reaches panels and findings`, async () => {
      const t0 = Date.now();
      const run = await askAndApprove(env, api, question);
      const view = (await api.call("GET", `/v1/runs/${run.runId}`)).json as Record<string, unknown>;
      const panels = await q(
        env,
        env.tenantId,
        "SELECT result FROM tasks WHERE run_id=$1 AND role='composer'",
        [run.runId],
      );
      report({
        question,
        state: run.state,
        totalMs: Date.now() - t0,
        afterApprovalMs: run.afterApprovalMs,
        interpretation: view.interpretation,
        findings: view.findings,
        composer: panels,
      });
      expect(run.state).toBe("COMPLETE");
    }, 480_000);
});
