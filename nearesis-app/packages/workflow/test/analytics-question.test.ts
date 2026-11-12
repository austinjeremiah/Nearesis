/**
 * The owner's question through the real API, Temporal worker, kernel gateway (leases) and near-thesis plugin on the LIVE
 * warehouse (read only), with mock inference: "Intents swaps by status per week since August, how have refunds changed?"
 * The certified catalogue has no refund metric, so the composer must plan analytics panels, call intents.analyze@1 through
 * the governed gateway, and propose ANALYTICS_RESULT panels the owner can approve. Needs Postgres, Temporal, ClickHouse.
 *
 * With NEARESIS_ACCEPT_LIVE=1 a second test runs the same question with the real OpenRouter model (shared USD 5 ledger,
 * about USD 0.005) and prints the timeline of the composer.
 */
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { type InferenceProvider, type StructuredResult, PanelSpec } from "@nearesis/contracts";
import { createCh, createPg, loadQuery, LIVE_DATABASE } from "@nearesis/analytics";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "./helpers/harness.ts";

/** Timings and panels are written to $A27_REPORT (vitest swallows stdout of a passing run). */
const report = (line: string) =>
  process.env.A27_REPORT && appendFileSync(process.env.A27_REPORT, `${line}\n`);
const QUESTION = "Intents swaps by status per week since August, how have refunds changed?";
const ch = createCh({ database: LIVE_DATABASE });
const liveWarehouse = await ch
  .query({ query: "SELECT count() AS n FROM source_coverage" })
  .then(() => true)
  .catch(() => false);
await ch.close();

/** Deterministic stand-in for the model: sees the catalogue and the analytics tools, plans what a sensible model would. */
function mockModel(): { provider: InferenceProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider = {
    id: "scripted",
    health: async () => ({ ok: true, detail: "mock" }),
    listModels: async () => [],
    generateStructured: async <T>(a: {
      prompt: string;
      schema: z.ZodType<T>;
    }): Promise<StructuredResult<T>> => {
      prompts.push(a.prompt);
      const hasRefundMetric = /refund/i.test(a.prompt.split("<catalog")[1]?.split("</catalog>")[0] ?? "");
      const plan = hasRefundMetric
        ? { rationale: "catalogue answers it", panels: [], analyticsPanels: [] }
        : {
            rationale:
              "The certified catalogue has swap counts only; refunds and statuses come from the intents analytics.",
            panels: [],
            analyticsPanels: [
              [
                "Swaps by status per week",
                { analysis: "status", from: "2026-08-01", to: "2026-11-10", grain: "week" },
              ],
              [
                "Refund rate per week",
                {
                  analysis: "trend",
                  from: "2026-08-01",
                  to: "2026-11-10",
                  granularity: "week",
                  emphasis: "refund_rate",
                },
              ],
              [
                "Why swaps were refunded, per week",
                { analysis: "refund_causes", from: "2026-08-01", to: "2026-11-10", by: "week" },
              ],
              [
                "Refund rate by chain pair",
                { analysis: "refund_rates", from: "2026-10-01", to: "2026-11-10", by: "chain_pair", top: 10 },
              ],
            ].map(([title, input]) => ({
              title,
              capability: "intents.analyze@1",
              input: JSON.stringify(input),
            })),
          };
      return {
        output: a.schema.parse(plan),
        provider: "scripted",
        model: "scripted-1",
        requestId: `mock-${prompts.length}`,
        usage: { inputTokens: 1000, outputTokens: 300 },
        evidence: null,
        rawResponseSha256: "0".repeat(64),
      } as StructuredResult<T>;
    },
    streamText: async function* () {},
    verifyResponse: async () => ({ verified: false, status: "unattested_dev" as const, checks: [] }),
  } as unknown as InferenceProvider;
  return { provider, prompts };
}

async function ask(env: Env, api: Api) {
  const t0 = Date.now();
  const r = await api.call(
    "POST",
    `/v1/workspaces/${env.workspaceId}/questions`,
    {
      question: QUESTION,
      snapshotPolicy: "pinned",
      source: "live",
      budget: { tokens: 200_000, toolCalls: 24, usd: 10 },
    },
    { "idempotency-key": `an-${Date.now()}-abcdefgh` },
  );
  expect(r.status).toBe(202);
  const { runId, workflowId } = r.json as { runId: string; workflowId: string };
  const pending = await waitFor(async () => {
    const list = await api.call("GET", `/v1/runs/${runId}/approvals`);
    const first = (list.json.approvals as Array<{ approvalId: string; actionHash: string }> | undefined)?.[0];
    if (first) return first;
    const view = (await api.call("GET", `/v1/runs/${runId}`)).json;
    if (view.terminal)
      throw new Error(`run ended ${String(view.state)} before approval: ${JSON.stringify(view.failure)}`);
    return undefined;
  }, 240_000);
  const toApproval = Date.now() - t0;
  const composer = await q<{
    result: {
      result: {
        proposal: {
          patch: { operations: Array<{ panel: unknown }> };
          analytics: Array<Record<string, unknown>>;
        };
      };
    };
    created_at: string;
    updated_at: string;
  }>(
    env,
    env.tenantId,
    "SELECT result, created_at, updated_at FROM tasks WHERE run_id=$1 AND role='composer'",
    [runId],
  );
  return { runId, workflowId, pending, composer: composer[0]!, toApproval };
}

describe.skipIf(!liveWarehouse)("owner question: refunds by status per week (mock inference)", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  const m = mockModel();
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true, provider: m.provider });
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });

  it("composes ANALYTICS_RESULT panels from the intents analytics and the owner can approve them", async () => {
    const a = await ask(env, api);
    expect(m.prompts.length).toBe(1); // one model call for the whole composition
    const proposal = a.composer.result.result.proposal;
    expect(proposal.analytics.map((c) => c.outcome)).toEqual(["OK", "OK", "OK", "OK"]);
    const panels = proposal.patch.operations.map((o) => PanelSpec.parse(o.panel));
    expect(panels).toHaveLength(4);
    for (const p of panels) {
      expect(p.queryRef.resultKind).toBe("analytics_result");
      expect(p.analytics).toMatchObject({
        label: "ANALYTICS_RESULT",
        certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
      });
      expect(p.note).toMatch(/not a certified semantic metric/);
    }
    // the stored call re-executes: every panel hash resolves to the analytics call the capability stored
    const pg = createPg();
    for (const p of panels) {
      const saved = await loadQuery(pg, p.queryRef.hash);
      expect((saved?.ast as { kind?: string })?.kind).toBe("analytics_call");
    }
    await pg.end();

    const before = await env.kernel!.kernelAdmin.query(
      "SELECT count(*)::int AS n FROM canvas_patches WHERE workspace_id=$1",
      [env.workspaceId],
    );
    expect(before.rows[0].n).toBe(0); // nothing applied before approval
    const d = await api.call("POST", `/v1/runs/${a.runId}/approvals/${a.pending.approvalId}`, {
      decision: "approve",
      actionHash: a.pending.actionHash,
    });
    expect(d.status).toBe(202);
    expect((await env.client.workflow.getHandle(a.workflowId).result()).state).toBe("COMPLETE");
    const doc = await env.kernel!.kernel.canvas.get(env.kernel!.session, env.workspaceId);
    expect(doc.panels).toHaveLength(4);
    const kinds = doc.panels.map((p) => (p as { kind: string }).kind);
    report(
      JSON.stringify({
        mockRun: {
          toApprovalMs: a.toApproval,
          composerMs: Date.parse(a.composer.updated_at) - Date.parse(a.composer.created_at),
        },
        panels: panels.map((p) => ({
          title: p.title,
          kind: p.kind,
          completeness: p.dataBinding.completeness,
          x: p.encoding.x,
          y: p.encoding.y,
          series: p.encoding.series,
        })),
        kinds,
      }),
    );
  }, 300_000);
});

const real = process.env.NEARESIS_ACCEPT_LIVE === "1";
describe.skipIf(!liveWarehouse || !real)(
  "owner question with the real model (spend inside the shared USD 5 ceiling)",
  () => {
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
    it("plans analytics panels and times the composer", async () => {
      const a = await ask(env, api);
      const ms = Date.parse(a.composer.updated_at) - Date.parse(a.composer.created_at);
      const proposal = a.composer.result.result.proposal;
      report(
        JSON.stringify({
          realRun: { toApprovalMs: a.toApproval, composerMs: ms, calls: proposal?.analytics },
        }),
      );
      expect(proposal.analytics.some((c) => c.outcome === "OK")).toBe(true);
    }, 300_000);
  },
);
