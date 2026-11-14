import { afterAll, beforeAll, expect, it } from "vitest";
import { makeEnv, q, runInvestigation, startWorker, type Env } from "./helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

it("basic scenario completes against the real Temporal server", async () => {
  const w = await startWorker(env);
  try {
    const run = await runInvestigation(env, "basic");
    const res = await run.result();
    const events = await q(
      env,
      env.tenantId,
      "SELECT from_state, to_state, detail FROM run_events WHERE run_id=$1 AND kind='transition' ORDER BY seq",
      [run.runId],
    );
    console.log(JSON.stringify({ res, events }));
    expect(res.state).toBe("COMPLETE");
  } finally {
    await w.stop();
  }
}, 180_000);
