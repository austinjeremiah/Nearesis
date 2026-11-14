/**
 * P10 with REAL inference (one run, explicit flag NEARESIS_LIVE_INFERENCE=1): the live question goes through the real
 * director plan and the live composer, whose model calls use the OpenRouter provider (INFERENCE_PROVIDER=openrouter) and are
 * metered on the shared USD 5 ledger (.data/spend/openrouter.json). This task's hard cap is USD 0.50 on top of what the
 * ledger already holds: the provider's own ledger cap is set to `spent + 0.50` before the worker starts, so a call whose
 * worst case would cross it is refused before anything is sent. Scripted scenario questions (marker agents of step 8) stay
 * on scripted rules and are labelled `mock`. Without the flag the test is skipped: mock inference is the default.
 *
 * The step-12 commit uses the loopback chain here (the live testnet commit is the other P10 test's job).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, defaultLedgerPath, loadEnvVar } from "../../packages/inference/src/index.ts";
import { validatePanelSpec } from "../../packages/canvas-schema/src/index.ts";
import { STEP_NAMES, validateTrace } from "../../plugins/near-thesis/src/index.ts";
import { loadLiveRegistry, cubeReady, LIVE_CUBE_URL_DEFAULT } from "../../services/analytics/src/index.ts";
import { buildLiveCapsuleInput } from "../../packages/capsule/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, type Stack } from "./lib/stack.ts";

const ENABLED = process.env.NEARESIS_LIVE_INFERENCE === "1";
const TASK_CAP_USD = 0.5;
const LIVE_ID = "live-20260603-20261111-live-organic-v2-15fe2ad62d6c";
const APP = join(import.meta.dirname, "..", "..");

let s: Stack;
let ledger: SpendLedger;
let spentBefore = 0;
let startedAt = "";
beforeAll(async () => {
  if (!ENABLED) return;
  process.env.INFERENCE_PROVIDER = "openrouter";
  const key = loadEnvVar("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");
  ledger = new SpendLedger({ apiKey: key, path: defaultLedgerPath("openrouter.json") });
  spentBefore = await ledger.spentUsd();
  // hard cap for this task, enforced by the provider's reservation check on the shared ledger
  process.env.INFERENCE_BUDGET_USD = Math.min(5, spentBefore + TASK_CAP_USD).toFixed(6);
  startedAt = new Date().toISOString();
  if (!(await cubeReady(LIVE_CUBE_URL_DEFAULT))) throw new Error("cube-live (:4001) must be reachable");
  s = await openStack({ liveInference: true });
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it.skipIf(!ENABLED)(
  "P10 real inference: the live composer plans the canvas with OpenRouter inside the USD 0.50 task cap",
  async () => {
    const input = mkdtempSync(join(tmpdir(), "p10-inf-input-"));
    buildLiveCapsuleInput({
      liveSnapshotDir: join(APP, "docs/research/live-snapshots", LIVE_ID),
      outDir: input,
      analysisCodeCommit: "3b5c4fd",
    });
    const f = await runFlow(s, {
      live: true,
      liveInference: true,
      question: "Show NEAR daily transaction counts for October 2026 as a time series.",
      liveCapsule: {
        snapshotDir: input,
        researchBundleDir: join(APP, "docs/research/live-results", LIVE_ID),
      },
      commit: { mode: "fixture", note: "P10 real-inference run" },
    });
    const why = f.trace.steps
      .map((x) => `${x.name}:${x.status}:${x.reason_code ?? ""}:${x.detail ?? ""}`)
      .join(" | ");

    console.log(`P10 TRACE ${why}`);
    // the ledger is the evidence of what was spent
    const entries = (await ledger.entries()).filter((e) => e.at >= startedAt);
    const settled = entries.filter((e) => e.status === "settled");
    const usd = settled.reduce((t, e) => t + (e.actualUsd ?? 0), 0);
    const tokensIn = settled.reduce((t, e) => t + (e.inputTokens ?? 0), 0);
    const tokensOut = settled.reduce((t, e) => t + (e.outputTokens ?? 0), 0);
    const spentAfter = await ledger.spentUsd();
    const evidence = {
      model: [...new Set(settled.map((e) => e.model))],
      calls: settled.length,
      releasedOrFailed: entries.length - settled.length,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      usd,
      ledgerBeforeUsd: spentBefore,
      ledgerAfterUsd: spentAfter,
      runId: f.runId,
    };
    writeFileSync(
      join(APP, ".data", "spend", "p10-live-inference-run.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(`P10 REAL INFERENCE EVIDENCE ${JSON.stringify(evidence)}`);

    expect(
      settled.length,
      `real provider calls settled on the ledger: ${JSON.stringify(evidence)}`,
    ).toBeGreaterThan(0);
    expect(usd).toBeLessThanOrEqual(TASK_CAP_USD);
    expect(spentAfter - spentBefore).toBeLessThanOrEqual(TASK_CAP_USD + 1e-9);

    const v = validateTrace(f.trace);
    expect(v.violations, why).toEqual([]);
    expect(f.trace.steps.map((x) => x.name)).toEqual([...STEP_NAMES]);
    for (const n of STEP_NAMES)
      expect(f.trace.steps.find((x) => x.name === n)!.status, why).toBe("completed");
    expect(f.trace.steps.find((x) => x.name === "compose")!.mode).toBe("live");
    // only the marker agents stay scripted
    expect(
      f.trace.steps
        .filter((x) => x.mode === "mock")
        .map((x) => x.name)
        .sort(),
    ).toEqual(["investigate"]);

    // the persisted panels were composed from live tool results: valid specs, live members only
    const canvas = (await s.owner.call("GET", `/v1/workspaces/${f.workspaceId}/canvas`)).json as {
      panels: Array<{ panelId: string; title?: string }>;
    };
    expect(canvas.panels.length).toBeGreaterThanOrEqual(1);
    for (const p of canvas.panels) expect(validatePanelSpec(p).ok).toBe(true);
    expect(loadLiveRegistry().metrics.length).toBeGreaterThan(5);
  },
  900_000,
);
