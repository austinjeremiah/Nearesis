/**
 * PERF06 real-stack variant: a freshly generated four-panel canvas (ch.13; ch.16b 6.2), measured with the clock starting at
 * the OWNER'S APPROVAL (interpretation recorded for owner confirmation: the composer's approval is a human gate).
 *
 * Path, all real except the model: POST /questions (real API, Temporal-backed engine) -> run worker -> near-thesis composer
 * (deterministic MOCK inference with a declared fixed latency, no paid call) -> canvas.preview through the kernel gateway
 * and the Cube fixture layer -> approval request -> owner approval through the approvals API -> progressive apply (one
 * canvas.apply_patch per panel) -> the real SSE stream. The time from prompt to approval request (mock latency, semantic
 * queries, workflow) is reported as a separate line and never judged or hidden.
 *
 * Runs: cold (every run asks for query windows no earlier run asked for) and warm (repeats of earlier windows).
 * Negative control: a build that applies the whole patch in one command and answers the start request only after the run
 * completed must FAIL (b) and (c) under the same judgement functions. PERF_DRYRUN=1 runs the body without a verdict.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "../../apps/api/src/index.ts";
import { temporalEngine } from "../../apps/api/src/temporal-engine.ts";
import { SseParser } from "../../apps/web/src/lib/event-store.ts";
import { KernelCanvasExecutor, taskIdFromHash } from "../../packages/agent-runtime/src/index.ts";
import { buildKernelDeps, createWorker } from "../../packages/workflow/src/index.ts";
import { guardInference, modelPolicyFromEnv } from "../../packages/kernel/src/index.ts";
import { execReq, giveLease, grant } from "../../packages/kernel/test/helpers/index.ts";
import { makeEnv, q, waitFor, type Env } from "../../packages/workflow/test/helpers/harness.ts";
import { DRYRUN, percentile, sha256Text, stats } from "./_reference.ts";
import { MockComposerProvider, promptFor, windowFor } from "./_composer-mock.ts";

const TH = {
  coldRuns: 30,
  warmRuns: 10,
  panels: 4,
  firstPanelP95Ms: 8000,
  firstBeforeFourthMinRatePct: 95,
  mockInferenceMs: 400,
};
const API_PORT = 4762;
const COLD = DRYRUN && process.env.PERF_COLD ? Number(process.env.PERF_COLD) : TH.coldRuns;
const WARM = DRYRUN && process.env.PERF_WARM ? Number(process.env.PERF_WARM) : TH.warmRuns;
const CONTROL_RUNS = 5;

export interface PanelFrame {
  panelId: string;
  patchedAt: number;
  patchedSeq: number;
  completedAt: number | null;
  completedSeq: number | null;
  status: "QUERYING" | "READY" | "ERROR";
}
export interface RunTimeline {
  approvalAt: number;
  panels: PanelFrame[];
  start: { runId: string | null; runReadable: boolean; terminalAtResponse: boolean };
  completedAt: number;
  fabricatedWhilePending: boolean;
}
export const firstPanelMs = (r: RunTimeline): number | null =>
  r.panels.length ? Math.min(...r.panels.map((p) => p.patchedAt)) - r.approvalAt : null;
export const fourthPanelMs = (r: RunTimeline): number | null =>
  r.panels.length >= TH.panels
    ? r.panels.map((p) => p.patchedAt).sort((a, b) => a - b)[TH.panels - 1]! - r.approvalAt
    : null;
export const passesA = (runs: RunTimeline[], boundMs: number): boolean => {
  const xs = runs.map(firstPanelMs);
  return (
    xs.length > 0 &&
    xs.every((x) => x !== null) &&
    percentile(
      (xs as number[]).sort((a, b) => a - b),
      95,
    ) < boundMs
  );
};
/** (b) durable run id before completion, and every panel exposed QUERYING (its canvas.patched) and then a final status (its query.completed, later in the stream). */
export const passesB = (r: RunTimeline): boolean =>
  r.start.runId !== null &&
  r.start.runReadable &&
  !r.start.terminalAtResponse &&
  r.panels.length === TH.panels &&
  r.panels.every(
    (p) =>
      p.completedSeq !== null &&
      p.completedSeq > p.patchedSeq &&
      (p.status === "READY" || p.status === "ERROR") &&
      p.completedAt! >= p.patchedAt,
  );
/** (c) the first panel appears strictly before the fourth. */
export const passesC = (r: RunTimeline): boolean => {
  const a = firstPanelMs(r);
  const d = fourthPanelMs(r);
  return a !== null && d !== null && a < d;
};
export const ratePct = (runs: RunTimeline[], f: (r: RunTimeline) => boolean): number =>
  runs.length ? (100 * runs.filter(f).length) / runs.length : 0;

let env: Env | null = null;
let blocked: string | null = null;
const stop: Array<() => Promise<unknown>> = [];
let mock: MockComposerProvider;
let token = "";
let mode: "progressive" | "whole" = "progressive";

/** The pre-progressive behaviour, used only by the negative control: the whole approved patch in ONE command. */
async function wholePatch(
  e: Env,
  a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    actionHash: string;
    params: Record<string, unknown>;
  },
) {
  const k = e.kernel!;
  const patch = (a.params as { patch: Record<string, unknown> }).patch;
  const composer = (
    await q<{ id: string }>(
      e,
      a.tenantId,
      "SELECT id FROM tasks WHERE run_id=$1 AND role='composer' ORDER BY created_at LIMIT 1",
      [a.runId],
    )
  )[0]!.id;
  const exec = new KernelCanvasExecutor(k.kernel);
  const session = exec.sessionFor({
    tenantId: a.tenantId,
    runId: a.runId,
    agentActorId: composer,
    requester: { userId: k.userId, role: "owner" },
  });
  const revision = await exec.documentRevision(session, a.workspaceId);
  const r = await exec.apply(session, a.workspaceId, {
    ...patch,
    expectedRevision: revision,
    operationId: taskIdFromHash(a.actionHash),
  } as never);
  return { state: "ok", detail: { workspaceVersion: r.workspaceVersion, eventSeq: r.eventSeq } };
}

beforeAll(async () => {
  if (!DRYRUN && process.env.PERF06_STACK !== "1") return;
  const e = await makeEnv({ kernel: true });
  stop.push(() => e.stop());
  const k = e.kernel!;
  const probe = await k.newWorkspace("perf06-probe");
  await giveLease(k.kernel, k.session, probe, "semantic.discover@1", [
    grant({ resource: "semantic", action: "discover" }),
  ]);
  const d = await k.kernel.gateway.invoke(
    k.session.principal,
    execReq(k.session, probe, "semantic.discover@1", {}),
  );
  if (d.state !== "ok") {
    blocked = `semantic layer unavailable through the plugin gateway: ${JSON.stringify(d).slice(0, 200)}`;
    return;
  }
  mock = new MockComposerProvider(TH.mockInferenceMs);
  const deps = buildKernelDeps({
    pool: e.db.app,
    appUrl: e.db.appUrl,
    kernel: k.kernel,
    provider: guardInference(mock, modelPolicyFromEnv()),
    liveComposer: true,
    model: "mock-composer-1",
  });
  const progressive = deps.canvas;
  deps.canvas = { apply: async (a) => (mode === "progressive" ? progressive.apply(a) : wholePatch(e, a)) };
  const { worker, connection } = await createWorker({
    deps,
    taskQueue: e.taskQueue,
    workflowBundlePath: e.bundlePath,
  });
  const running = worker.run();
  stop.push(async () => {
    worker.shutdown();
    await running;
    await connection.close();
  });
  const app = await buildApp({
    kernel: k.kernel,
    engine: temporalEngine({ taskQueue: e.taskQueue }),
    nodeEnv: "test",
    ssePollMs: 50,
  });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  stop.push(() => app.close());
  token = await k.kernel.devAuth!.login(k.subject);
  env = e;
}, 600_000);
afterAll(async () => {
  for (const s of stop.reverse()) await s().catch(() => undefined);
}, 120_000);

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

interface Frame {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: number;
}
function sseClient(url: string): { frames: Frame[]; close(): void; ready: Promise<void> } {
  const frames: Frame[] = [];
  const ctrl = new AbortController();
  let up!: () => void;
  const ready = new Promise<void>((r) => (up = r));
  void (async () => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": "0" },
      signal: ctrl.signal,
    });
    up();
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const at = performance.now();
        for (const f of parser.push(value)) {
          if (!f.id) continue;
          try {
            const ev = JSON.parse(f.data) as { seq: number; type: string; data: Record<string, unknown> };
            frames.push({ seq: Number(f.id), type: ev.type ?? f.event ?? "", data: ev.data ?? {}, at });
          } catch {
            /* non-event frame */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    }
  })();
  return { frames, close: () => ctrl.abort(), ready };
}

interface RunOut {
  timeline: RunTimeline;
  composeMs: number;
  startMs: number;
  mockMs: number;
  state: string;
}
async function approve(id: string): Promise<number> {
  const pending = await waitFor(
    async () => {
      const l = (await (await api(`/v1/runs/${id}/approvals`)).json()) as {
        approvals?: Array<{ approvalId: string; actionHash: string }>;
      };
      return l.approvals?.[0];
    },
    120_000,
    20,
  );
  const at = performance.now(); // the clock starts here: the approval request is sent
  const d = await api(`/v1/runs/${id}/approvals/${pending.approvalId}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", actionHash: pending.actionHash }),
  });
  expect(d.status).toBe(202);
  return at;
}
const dataLike = (v: unknown): boolean =>
  /"(rows|values|series|points|cells)"\s*:/.test(JSON.stringify(v ?? {}));

async function oneRun(e: Env, variant: number, o: { blockingStart?: boolean } = {}): Promise<RunOut> {
  const k = e.kernel!;
  const workspaceId = await k.newWorkspace(`perf06-${variant}-${randomUUID().slice(0, 6)}`);
  const sse = sseClient(`http://127.0.0.1:${API_PORT}/v1/workspaces/${workspaceId}/events`);
  await sse.ready;
  const mockBefore = mock.calls.length;
  const t0 = performance.now();
  const res = await api(`/v1/workspaces/${workspaceId}/questions`, {
    method: "POST",
    headers: { "idempotency-key": `perf06-${randomUUID()}` },
    body: JSON.stringify({
      question: promptFor(variant),
      snapshotPolicy: "pinned",
      budget: { tokens: 200_000, toolCalls: 24, usd: 20 },
    }),
  });
  const body = (await res.json()) as { runId?: string; workflowId?: string };
  expect(res.status).toBe(202);
  const runId = body.runId!;
  const hand = e.client.workflow.getHandle(body.workflowId!);
  let tApprove: number;
  let tResp: number;
  let composeMs: number;
  if (o.blockingStart) {
    // control: a start request that only answers once the whole run has finished
    tApprove = await approve(runId);
    composeMs = tApprove - t0;
    await hand.result();
    tResp = performance.now();
  } else {
    tResp = performance.now();
  }
  // durable: Temporal holds the started workflow (not finished) and the run id is readable through the API
  const desc = await hand.describe();
  const view = await waitFor(
    async () => ((await api(`/v1/runs/${runId}`)).status === 200 ? true : null),
    10_000,
    20,
  ).catch(() => false);
  const terminal = desc.status.name !== "RUNNING";
  const row = view ? { state: desc.status.name } : undefined;
  if (!o.blockingStart) {
    tApprove = await approve(runId);
    composeMs = tApprove - t0;
  }
  const result = (await hand.result()) as { state: string };
  const tDone = performance.now();
  await waitFor(
    async () =>
      sse.frames.filter((f) => f.type === "query.completed" && f.data.runId === runId).length >= TH.panels,
    5_000,
    20,
  ).catch(() => undefined);
  sse.close();

  const patched = sse.frames.filter((f) => f.type === "canvas.patched");
  const added: PanelFrame[] = [];
  for (const f of patched)
    for (const op of (f.data.operations as Array<{ op: string; ref: string }> | undefined) ?? []) {
      if (op.op !== "addPanel") continue;
      const done = sse.frames.find((c) => c.type === "query.completed" && c.data.panelId === op.ref);
      added.push({
        panelId: op.ref,
        patchedAt: f.at,
        patchedSeq: f.seq,
        completedAt: done?.at ?? null,
        completedSeq: done?.seq ?? null,
        status: done ? (done.data.status as PanelFrame["status"]) : "QUERYING",
      });
    }
  const doc = (await k.kernel.canvas.get(k.session, workspaceId)) as {
    panels: Array<Record<string, unknown>>;
  };
  if (doc.panels.length !== TH.panels)
    process.stderr.write(
      `DIAG state ${result.state} frames ${JSON.stringify(sse.frames.map((f) => [f.seq, f.type]))} tasks ${JSON.stringify(await q(e, e.tenantId, "SELECT role,status,left(coalesce(result::text,''),400) r FROM tasks WHERE run_id=$1", [runId]))} run ${JSON.stringify(await q(e, e.tenantId, "SELECT state, failure FROM runs WHERE id=$1", [runId]))}\n`,
    );
  expect(doc.panels).toHaveLength(TH.panels);
  // (d) only a query reference arrives with a panel: no rows or values in patch frames or stored specs, and nothing READY before its query completed
  const fabricated =
    patched.some((f) => dataLike(f.data)) ||
    doc.panels.some((p) => dataLike(p)) ||
    added.some((p) => p.status !== "QUERYING" && (p.completedSeq === null || p.completedSeq < p.patchedSeq));
  return {
    timeline: {
      approvalAt: tApprove!,
      panels: added,
      start: { runId, runReadable: !!row, terminalAtResponse: terminal },
      completedAt: tDone,
      fabricatedWhilePending: fabricated,
    },
    composeMs: composeMs!,
    startMs: tResp - t0,
    mockMs: mock.calls.slice(mockBefore).reduce((s, c) => s + c.ms, 0),
    state: result.state,
  };
}

it("PERF06 (real stack, approval clock): first panel p95 < 8 s after approval, progressive panels with per-query status", async () => {
  if (!DRYRUN && process.env.PERF06_STACK !== "1") {
    observe({
      testId: "PERF06",
      observed: "real-stack variant not executed (PERF06_STACK=1 or PERF_DRYRUN=1 to run)",
      blocked: "opt-in variant",
    });
    return;
  }
  if (blocked || !env) {
    observe({
      testId: "PERF06",
      observed: "not executed: stack unavailable",
      blocked: blocked ?? "no stack",
    });
    return;
  }
  const e = env;
  mode = "progressive";
  const cold: RunOut[] = [];
  for (let i = 0; i < COLD; i++) cold.push(await oneRun(e, i));
  const warm: RunOut[] = [];
  for (let i = 0; i < WARM; i++) warm.push(await oneRun(e, i));
  const all = [...cold, ...warm];
  mode = "whole";
  const control: RunOut[] = [];
  for (let i = 0; i < CONTROL_RUNS; i++) control.push(await oneRun(e, 100 + i, { blockingStart: true }));
  mode = "progressive";

  const coldT = cold.map((r) => r.timeline);
  const allT = all.map((r) => r.timeline);
  const controlT = control.map((r) => r.timeline);
  const coldFirst = coldT.map((t) => firstPanelMs(t)!);
  const out = {
    coldFirst: stats(coldFirst),
    warmFirst: stats(warm.map((r) => firstPanelMs(r.timeline)!)),
    fourth: stats(allT.map((t) => fourthPanelMs(t)!)),
    start: stats(all.map((r) => r.startMs)),
    promptToApproval: stats(all.map((r) => r.composeMs)),
    mock: stats(all.map((r) => r.mockMs)),
    rateB: ratePct(allT, passesB),
    rateC: ratePct(allT, passesC),
    fabricated: allT.filter((t) => t.fabricatedWhilePending).length,
    control: {
      a: passesA(controlT, TH.firstPanelP95Ms),
      b: ratePct(controlT, passesB),
      c: ratePct(controlT, passesC),
    },
    states: [...new Set(all.map((r) => r.state))],
    fixtureHash: sha256Text(
      JSON.stringify({ TH, windows: Array.from({ length: COLD }, (_, i) => windowFor(i)) }),
    ),
  };
  process.stderr.write("PERF06STACK " + JSON.stringify(out) + "\n");
  expect(out.states).toEqual(["COMPLETE"]);
  expect(out.fabricated).toBe(0);
  expect(out.control.b).toBe(0);
  expect(out.control.c).toBe(0);
  expect(out.rateB).toBe(100);
  expect(out.rateC).toBeGreaterThanOrEqual(TH.firstBeforeFourthMinRatePct);
  expect(passesA(coldT, TH.firstPanelP95Ms)).toBe(true);
}, 3_600_000);
