/**
 * Worker process entry used by acceptance tests (spawned with child_process; SIGKILL = crash).
 * Config is passed through env: TASK_QUEUE, DATABASE_APP_URL, POLICY_JSON, STEP_DELAY_MS, WORKFLOW_BUNDLE_PATH, WORKER_ID.
 * Secrets are never read here.
 */
import { makePool } from "./db.ts";
import { buildDevDeps } from "./testing/dev-deps.ts";
import { bootKernel, buildKernelDeps } from "./kernel-deps.ts";
import { ScriptedProvider, scenarioRules } from "@nearesis/agent-runtime";
import { createWorker } from "./worker.ts";

const appUrl = process.env.DATABASE_APP_URL!;
const pool = makePool(appUrl, 12);
const policy = process.env.POLICY_JSON ? JSON.parse(process.env.POLICY_JSON) : {};
const stepDelayMs = Number(process.env.STEP_DELAY_MS ?? "0");
// KERNEL_PLUGIN_ROOT + KERNEL_TRUSTED_KEYS_JSON select the real kernel gateway (production plugin trust); the model is
// the scripted scenario provider unless a live provider is configured by the host.
const deps = process.env.KERNEL_PLUGIN_ROOT
  ? buildKernelDeps({
      pool,
      appUrl,
      policy,
      kernel: await bootKernel({
        appUrl,
        pluginRoot: process.env.KERNEL_PLUGIN_ROOT,
        trustedKeys: JSON.parse(process.env.KERNEL_TRUSTED_KEYS_JSON ?? "{}"),
      }),
      provider: new ScriptedProvider(scenarioRules({ stepDelayMs })),
    })
  : buildDevDeps({ pool, appUrl, policy, stepDelayMs });
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
