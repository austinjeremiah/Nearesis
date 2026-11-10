/**
 * Worker process entry used by acceptance tests (spawned with child_process; SIGKILL = crash).
 * Config is passed through env: TASK_QUEUE, DATABASE_APP_URL, POLICY_JSON, STEP_DELAY_MS, WORKFLOW_BUNDLE_PATH, WORKER_ID.
 * Secrets are never read here.
 */
import { makePool } from "./db.ts";
import { buildDevDeps } from "./testing/dev-deps.ts";
import { createWorker } from "./worker.ts";

const appUrl = process.env.DATABASE_APP_URL!;
const pool = makePool(appUrl, 12);
const deps = buildDevDeps({
  pool,
  appUrl,
  policy: process.env.POLICY_JSON ? JSON.parse(process.env.POLICY_JSON) : {},
  stepDelayMs: Number(process.env.STEP_DELAY_MS ?? "0"),
});
const { worker } = await createWorker({
  deps,
  taskQueue: process.env.TASK_QUEUE!,
  identity: process.env.WORKER_ID ?? `worker-${process.pid}`,
  ...(process.env.WORKFLOW_BUNDLE_PATH ? { workflowBundlePath: process.env.WORKFLOW_BUNDLE_PATH } : {}),
});
console.log(`READY ${process.env.WORKER_ID ?? process.pid}`);
const stop = () => worker.shutdown();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await worker.run();
await pool.end();
