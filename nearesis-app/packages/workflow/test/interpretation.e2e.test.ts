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
import type { z } from "zod";
import type { InferenceProvider, InterpretedFinding, StructuredResult } from "@nearesis/contracts";
import { cubeReady, LIVE_CUBE_URL_DEFAULT } from "@nearesis/analytics";
import { createRuntimeProvider } from "../src/index.ts";
import { makeEnv, q, startApi, startWorker, waitFor, type Api, type Env } from "./helpers/harness.ts";

const report = (o: unknown) =>
  process.env.A28_REPORT && appendFileSync(process.env.A28_REPORT, `${JSON.stringify(o, null, 2)}\n`);
const QUESTION = "Daily NEAR transactions vs Intents swap volume since May, with NEAR price";
const cube = await cubeReady(LIVE_CUBE_URL_DEFAULT).catch(() => false);

interface Digest {
  panelId: string;
  title: string;
  col: string;
  first: { i: number; v: string };
  last: { i: number; v: string };
  firstAt: string;
  lastAt: string;
}
/** Reads the analyst prompt's digests, exactly what a model sees, and returns what it needs to cite cells. */
function parseDigests(prompt: string): Digest[] {
  const out: Digest[] = [];
  for (const block of prompt.split('<untrusted_data name="panel">').slice(1)) {
    const head = /^panel (\S+) "(.*)" queryHash/m.exec(block);
    const stat = /^stats (\S+): known=\d+ first\[(\d+)\]=(\S+) last\[(\d+)\]=(\S+)/m.exec(block);
    if (!head || !stat) continue;
    const at = (i: string) => new RegExp(`^\\[${i}\\] (\\S+)`, "m").exec(block)?.[1] ?? "";
    out.push({
      panelId: head[1]!,
      title: head[2]!,
      col: stat[1]!,
      first: { i: Number(stat[2]), v: stat[3]! },
      last: { i: Number(stat[4]), v: stat[5]! },
      firstAt: at(stat[2]!),
      lastAt: at(stat[4]!),
    });
  }
  return out;
}

function mockModel(o: { analyst?: "hang" } = {}): {
  provider: InferenceProvider;
  calls: Array<{ stage: string; prompt: string }>;
} {
  const calls: Array<{ stage: string; prompt: string }> = [];
  const respond = (a: { system: string; prompt: string; schema: z.ZodType<unknown> }): unknown => {
    if (a.system.includes("compose research dashboards")) {
      calls.push({ stage: "composer", prompt: a.prompt });
      const catalog = JSON.parse(/<catalog[^>]*>\n([\s\S]*)\n<\/catalog>/.exec(a.prompt)![1]!) as Array<{
        id: string;
        dataWindow: { from: string; to: string } | null;
      }>;
      const pick = (id: string, title: string) => {
        const m = catalog.find((c) => c.id === id && c.dataWindow);
        if (!m) return null;
        const from = m.dataWindow!.from > "2026-05-01" ? m.dataWindow!.from : "2026-05-01";
        const toDay = new Date(
          Date.parse(`${m.dataWindow!.to.slice(0, 10)}T00:00:00Z`) + 86_400_000,
        ).toISOString();
        return {
          title,
          mark: "line",
          measures: [id],
          grain: "day",
          from: `${from.slice(0, 10)}T00:00:00Z`,
          to: toDay,
        };
      };
      const panels = [
        pick("live.near_tx_count", "Daily NEAR transactions"),
        pick("live.oneclick_swap_count", "Daily Intents swaps"),
        pick("live.price_close_usd", "NEAR price (USD)"),
      ].filter((x) => x !== null);
      return { rationale: "Three panels for the three series asked about.", panels, analyticsPanels: [] };
    }
    if (a.system.includes("Nearesis analyst")) {
      calls.push({ stage: "analyst", prompt: a.prompt });
      const d = parseDigests(a.prompt);
      const pct = (x: Digest) =>
        (((Number(x.last.v) - Number(x.first.v)) / Math.abs(Number(x.first.v))) * 100).toFixed(1);
      const ref = (x: Digest, w: "first" | "last") => ({ panelId: x.panelId, column: x.col, row: x[w].i });
      const change = (x: Digest) => ({
        kind: "change",
        basis: "observation",
        status: "supported",
        statement: `${x.title} went from ${x.first.v} on ${x.firstAt} to ${x.last.v} on ${x.lastAt}, a ${pct(x)}% change.`,
        facts: [
          { value: x.first.v, unit: "", op: "cell", of: [ref(x, "first")] },
          { value: x.last.v, unit: "", op: "cell", of: [ref(x, "last")] },
          { value: `${pct(x)}%`, unit: "percent", op: "pct_change", of: [ref(x, "first"), ref(x, "last")] },
        ],
        limitations: [],
      });
      const findings: unknown[] = d.map(change);
      if (d.length >= 2)
        findings.push({
          kind: "comparison",
          basis: "inference",
          status: "supported",
          statement: `${d[0]!.title} changed by ${pct(d[0]!)}% while ${d[1]!.title} changed by ${pct(d[1]!)}%; the two series moved over the same window, which does not show that either drives the other.`,
          facts: [
            {
              value: `${pct(d[0]!)}%`,
              unit: "percent",
              op: "pct_change",
              of: [ref(d[0]!, "first"), ref(d[0]!, "last")],
            },
            {
              value: `${pct(d[1]!)}%`,
              unit: "percent",
              op: "pct_change",
              of: [ref(d[1]!, "first"), ref(d[1]!, "last")],
            },
          ],
          limitations: [],
        });
      return { findings };
    }
    if (a.system.includes("Nearesis skeptic")) {
      calls.push({ stage: "skeptic", prompt: a.prompt });
      const n = /"index":(\d+)/g.exec(a.prompt) ? [...a.prompt.matchAll(/"index":(\d+)/g)].length : 0;
      return {
        notes: Array.from({ length: n }, (_x, i) => ({
          findingIndex: i,
          alternativeExplanations: ["Other activity during the same weeks could produce the same rows."],
          selectionEffects: ["The window starts on the first day the planner chose."],
          coverageCaveats: [],
          verdict: "holds",
        })),
      };
    }
    throw new Error(`unexpected model call: ${a.system.slice(0, 60)}`);
  };
  const provider = {
    id: "scripted",
    health: async () => ({ ok: true, detail: "mock" }),
    listModels: async () => [],
    generateStructured: async <T>(a: {
      system: string;
      prompt: string;
      schema: z.ZodType<T>;
    }): Promise<StructuredResult<T>> => {
      if (o.analyst === "hang" && a.system.includes("Nearesis analyst")) {
        calls.push({ stage: "analyst", prompt: a.prompt });
        return new Promise<StructuredResult<T>>(() => undefined);
      }
      return {
        output: a.schema.parse(respond(a)),
        provider: "scripted",
        model: "scripted-1",
        requestId: `mock-${calls.length}`,
        usage: { inputTokens: 1200, outputTokens: 400 },
        evidence: null,
        rawResponseSha256: "0".repeat(64),
      } as StructuredResult<T>;
    },
    streamText: async function* () {},
    verifyResponse: async () => ({ verified: false, status: "unattested_dev" as const, checks: [] }),
  } as unknown as InferenceProvider;
  return { provider, calls };
}

async function askAndApprove(env: Env, api: Api, question = QUESTION) {
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

describe.skipIf(!cube)("interpretation: the owner's question with mock inference", () => {
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

  it("reads the approved panels' rows, grounds and challenges the findings, and returns them from GET /v1/runs/:id", async () => {
    const run = await askAndApprove(env, api);
    expect(run.state).toBe("COMPLETE");
    // one composer call, one analyst call, one skeptic call: within the run's own budget
    expect(m.calls.map((c) => c.stage)).toEqual(["composer", "analyst", "skeptic"]);

    const view = (await api.call("GET", `/v1/runs/${run.runId}`)).json as {
      findings: InterpretedFinding[];
      interpretation: { state: string; reason: string | null; findingCount: number };
      budget: { spent: { usd: number } };
    };
    expect(view.interpretation).toMatchObject({ state: "ready", reason: null });
    expect(view.findings.length).toBeGreaterThanOrEqual(2);
    expect(view.interpretation.findingCount).toBe(view.findings.length);
    for (const f of view.findings) {
      expect(["observation", "inference"]).toContain(f.basis);
      expect(f.facts.length).toBeGreaterThan(0);
      for (const fact of f.facts) {
        expect(fact.resultRef.queryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(fact.resultRef.rowIds.length).toBeGreaterThan(0);
      }
      expect(f.skepticNotes.length).toBeGreaterThan(0);
      expect(f.limitations.length).toBeGreaterThan(0);
    }
    expect(view.findings.some((f) => f.basis === "inference")).toBe(true);
    expect(view.findings.find((f) => f.basis === "inference")!.skepticNotes.join(" ")).toContain(
      "Correlation is not causation",
    );

    // the analyst read what the panels returned (digest rows), not the question alone
    expect(m.calls[1]!.prompt).toContain("certification=");

    // persisted
    const rows = await q<{ n: number }>(
      env,
      env.tenantId,
      "SELECT count(*)::int AS n FROM run_findings WHERE run_id=$1",
      [run.runId],
    );
    expect(rows[0]!.n).toBe(view.findings.length);

    // streamed: one finding.created frame per finding
    const ev = await env.kernel!.kernelAdmin.query(
      "SELECT payload FROM workspace_events WHERE workspace_id=$1 AND event_type='finding.created' ORDER BY seq",
      [env.workspaceId],
    );
    expect(ev.rows).toHaveLength(view.findings.length);
    expect(ev.rows[0].payload).toMatchObject({ runId: run.runId, index: 0, total: view.findings.length });

    // evidence graph: each finding is a claim derived from the query nodes of its panels
    const graph = await env.kernel!.kernelAdmin.query(
      `SELECT (SELECT count(*)::int FROM evidence_nodes WHERE workspace_id=$1 AND kind='claim') AS claims,
              (SELECT count(*)::int FROM evidence_nodes WHERE workspace_id=$1 AND kind='query') AS queries,
              (SELECT count(*)::int FROM evidence_edges WHERE workspace_id=$1 AND relation='derived_from') AS edges`,
      [env.workspaceId],
    );
    expect(graph.rows[0].claims).toBe(view.findings.length);
    expect(graph.rows[0].queries).toBeGreaterThanOrEqual(2);
    expect(graph.rows[0].edges).toBeGreaterThanOrEqual(view.findings.length);
    report({
      mock: {
        afterApprovalMs: run.afterApprovalMs,
        findings: view.findings.map((f) => ({ basis: f.basis, status: f.status, statement: f.statement })),
      },
    });
  }, 480_000);
});

describe.skipIf(!cube)("interpretation degrades without failing the run", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true, provider: mockModel({ analyst: "hang" }).provider });
    worker.deps.interpretation = { analystTimeoutMs: 4000 };
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });

  it("a model that never answers leaves the panels applied and records interpretation unavailable (MODEL_TIMEOUT)", async () => {
    const run = await askAndApprove(env, api);
    expect(run.state).toBe("COMPLETE");
    const doc = await env.kernel!.kernel.canvas.get(env.kernel!.session, env.workspaceId);
    expect(doc.panels.length).toBeGreaterThanOrEqual(1);
    const view = (await api.call("GET", `/v1/runs/${run.runId}`)).json as {
      findings: unknown[];
      interpretation: { state: string; reason: string };
    };
    expect(view.findings).toEqual([]);
    expect(view.interpretation).toMatchObject({ state: "unavailable", reason: "MODEL_TIMEOUT" });
  }, 480_000);
});

const real = process.env.NEARESIS_ACCEPT_LIVE === "1";
describe.skipIf(!cube || !real)("interpretation with the real model (shared USD 5 ceiling)", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true });
    // as in the production worker (no injected provider): the interpretation stage gets a fresh per-run provider
    worker.deps.providerForRun = createRuntimeProvider;
  }, 180_000);
  afterAll(async () => {
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });
  it("produces grounded findings for the owner question", async () => {
    const run = await askAndApprove(env, api);
    const view = (await api.call("GET", `/v1/runs/${run.runId}`)).json as {
      findings: InterpretedFinding[];
      interpretation: unknown;
      budget: unknown;
    };
    const rej = await q(
      env,
      env.tenantId,
      "SELECT state, reason, rejected FROM run_interpretation WHERE run_id=$1",
      [run.runId],
    );
    report({
      real: {
        state: run.state,
        afterApprovalMs: run.afterApprovalMs,
        interpretation: view.interpretation,
        budget: view.budget,
        run_interpretation: rej,
        findings: view.findings,
      },
    });
    expect(run.state).toBe("COMPLETE");
  }, 480_000);
});
