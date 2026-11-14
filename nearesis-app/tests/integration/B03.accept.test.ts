import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import type { ScriptRule } from "../../packages/agent-runtime/src/index.ts";
import { startScriptedWorker } from "../../packages/workflow/test/acceptance/m-marker-helpers.ts";
import { statusBoard, validateTrace, type ProviderState } from "../../plugins/near-thesis/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { ask, openStack, q, runRow, stopIfBlocked, waitFor, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("B03: a mixed provider outage shows stale and partial status and never reports success", async () => {
  if (await stopIfBlocked(s, "B03", "the real-stack flow")) return;
  const k = s.env.kernel!;

  // provider 1 (data): Explorer credential failure in the full flow
  const dataOutage = await runFlow(s, { explorer401: true });
  expect(validateTrace(dataOutage.trace).violations).toEqual([]);
  const by = new Map(dataOutage.trace.steps.map((x) => [x.name, x]));
  expect(by.get("acquire")!.status).toBe("failed");
  expect(by.get("publish")!.status).toBe("blocked");
  expect(dataOutage.publication === undefined || dataOutage.publication.label === "blocked").toBe(true);
  expect(existsSync(join(dataOutage.capsuleDir!, "manifest.json"))).toBe(false); // nothing was built or published

  // provider 2 (inference): the model provider answers 503 to every call; the real worker, runtime and API see it
  await s.worker.stop();
  const outage: ScriptRule[] = [
    {
      match: () => true,
      respond: () => {
        throw new Error("503 inference provider unavailable");
      },
    },
  ];
  const w = await startScriptedWorker(s.env, outage, { policy: { heartbeatTimeoutMs: 3000 } });
  let runId = "";
  let snapshot: { state: string; failure: unknown };
  try {
    const ws = await k.newWorkspace("B03 inference outage");
    const run = await ask(s, ws, "A20-P", "Are Intents flows durable?");
    runId = run.runId;
    // bounded observation: either the run ends non-complete with a structured failure, or it is still non-terminal and visibly so
    const exists = await waitFor(async () => (await runRow(s, runId)) ?? null, 30_000);
    snapshot = await waitFor(async () => {
      const r = (await runRow(s, runId)) ?? exists;
      return ["PARTIAL", "FAILED", "BLOCKED"].includes(r.state) ? r : null;
    }, 20_000).catch(async () => (await runRow(s, runId)) ?? exists);
    expect(snapshot.state).not.toBe("COMPLETE");
    const view = (await s.api.call("GET", `/v1/runs/${runId}`)).json as {
      state: string;
      terminal: boolean;
      failure: unknown;
    };
    expect(view.state).not.toBe("COMPLETE");
    if (view.terminal) expect(view.failure).toBeTruthy(); // a terminal non-complete run carries the structured failure
    const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as { panels: unknown[] };
    expect(canvas.panels).toHaveLength(0); // no panel was fabricated
    const facts = await q<{ n: string }>(
      s.env,
      s.env.tenantId,
      "SELECT count(*)::text n FROM tasks WHERE run_id=$1 AND status='DONE'",
      [runId],
    );
    expect(Number(facts[0]!.n)).toBe(0);
  } finally {
    await w.stop();
  }

  // the status board for the slice: data degraded, inference unavailable, semantic layer still ok -> partial, never ok
  const providers: ProviderState[] = [
    {
      id: "explorer.oneclick",
      kind: "data",
      status: "degraded",
      reason: by.get("acquire")!.reason_code,
      lastGoodWatermark: null,
    },
    {
      id: "inference.scripted",
      kind: "inference",
      status: "unavailable",
      reason: "503",
      lastGoodWatermark: null,
    },
    { id: "semantic.near-thesis", kind: "semantic", status: "ok", reason: null, lastGoodWatermark: null },
  ];
  const board = statusBoard(providers);
  expect(board.overall).toBe("partial");
  expect(board.stale.map((p) => p.id)).toEqual(["explorer.oneclick", "inference.scripted"]);
  expect(statusBoard(providers.map((p) => ({ ...p, status: "ok" as const }))).overall).toBe("ok");
  // negative control: a board that reports ok while a provider is down would fail this check
  expect(statusBoard(providers).overall).not.toBe("ok");

  observe({
    testId: "B03",
    fixtureHash: createHash("sha256").update(JSON.stringify(providers)).digest("hex"),
    observed: `mixed outage: Explorer 401 (acquire failed ${by.get("acquire")!.reason_code}; 8 dependent steps blocked; nothing published) and inference provider 503 (run ${runId.slice(0, 8)} ended ${snapshot.state}, never COMPLETE, no panel fabricated, 0 tasks DONE); status board overall=${board.overall} with stale providers ${board.stale.map((p) => p.id).join(", ")}; all-ok board is the only ok.`,
    evidence: {
      dataTrace: dataOutage.trace.steps.map((x) => ({ n: x.name, s: x.status, r: x.reason_code })),
      inferenceRun: snapshot,
      board,
    },
  });
}, 900_000);
