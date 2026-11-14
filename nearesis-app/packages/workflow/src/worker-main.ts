/**
 * PRODUCTION worker: `pnpm --filter @nearesis/workflow worker` (sets NEARESIS_PRODUCTION_WORKER=1).
 * Boots the real kernel (production plugin trust: NEARESIS_PLUGIN_TRUSTED_KEYS from the root .env; plugins are the
 * installations persisted in the database, installed with `pnpm --filter @nearesis/kernel plugin:install`), builds
 * `buildKernelDeps` with the model chosen by INFERENCE_PROVIDER (openrouter = live, spend on the shared USD 5 ledger),
 * connects to Temporal on queue `nearesis-investigations` (override TASK_QUEUE) and shuts down on SIGTERM/SIGINT.
 * Env: DATABASE_APP_URL (default dev app role), KERNEL_PLUGIN_ROOT (default <app>/plugins/near-thesis),
 * TEMPORAL_ADDRESS (default 127.0.0.1:57233).
 *
 * Worker process entry used by acceptance tests (spawned with child_process; SIGKILL = crash).
 * Config is passed through env: TASK_QUEUE, DATABASE_APP_URL, POLICY_JSON, STEP_DELAY_MS, WORKFLOW_BUNDLE_PATH, WORKER_ID.
 * Secrets are never read here.
 */
import { fileURLToPath } from "node:url";
import { loadEnvVar } from "@nearesis/inference";
import { DEFAULT_APP_URL, makePool } from "./db.ts";
import { buildDevDeps } from "./testing/dev-deps.ts";
import { bootKernel, buildKernelDeps } from "./kernel-deps.ts";
import {
  CostGovernor,
  kernelSpendGateFactory,
  paidEgressOpFromEnv,
  PgAudit,
  ScriptedProvider,
  kernelAlertSink,
  scenarioRules,
} from "@nearesis/agent-runtime";
import { createWorker } from "./worker.ts";
import { externalModelSpend } from "./inference-spend.ts";

const production = process.env.NEARESIS_PRODUCTION_WORKER === "1";
const appUrl = process.env.DATABASE_APP_URL ?? (production ? DEFAULT_APP_URL : undefined)!;
const pool = makePool(appUrl, 12);
const policy = process.env.POLICY_JSON ? JSON.parse(process.env.POLICY_JSON) : {};
const stepDelayMs = Number(process.env.STEP_DELAY_MS ?? "0");
// KERNEL_PLUGIN_ROOT + KERNEL_TRUSTED_KEYS_JSON select the real kernel gateway (production plugin trust); the model is
// the scripted scenario provider unless a live provider is configured by the host.
const costHolder: { cost?: CostGovernor } = {}; // set below once the kernel exists; read lazily per plugin call
const costOn = process.env.NEARESIS_COST_CONTROL === "1";
const prodKernel = production
  ? await bootKernel({
      ...(costOn
        ? { spendGate: kernelSpendGateFactory(() => costHolder.cost), paidEgressOp: paidEgressOpFromEnv() }
        : {}),
      appUrl,
      pluginRoot:
        process.env.KERNEL_PLUGIN_ROOT ??
        fileURLToPath(new URL("../../../plugins/near-thesis", import.meta.url)),
      trustedKeys: JSON.parse(loadEnvVar("NEARESIS_PLUGIN_TRUSTED_KEYS") ?? "{}"),
    })
  : undefined;
// Cost control (migration 005 must be applied): NEARESIS_COST_CONTROL=1 meters every model call and enforces the
// workspace spend policy BEFORE the call. Off by default so a worker started against an unmigrated database still runs.
const cost =
  production && prodKernel && process.env.NEARESIS_COST_CONTROL === "1"
    ? new CostGovernor({
        pool,
        audit: new PgAudit(pool),
        sink: kernelAlertSink(prodKernel),
        externalModelSpend: externalModelSpend(),
      })
    : undefined;
costHolder.cost = cost;
const deps = production
  ? buildKernelDeps({
      pool,
      appUrl,
      policy,
      kernel: prodKernel!,
      ...(cost ? { cost } : {}),
    })
  : process.env.KERNEL_PLUGIN_ROOT
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
  taskQueue: process.env.TASK_QUEUE ?? "nearesis-investigations",
  identity: process.env.WORKER_ID ?? `worker-${process.pid}`,
  ...(process.env.WORKFLOW_BUNDLE_PATH ? { workflowBundlePath: process.env.WORKFLOW_BUNDLE_PATH } : {}),
});
console.log(`READY ${process.env.WORKER_ID ?? process.pid}`);
const stop = () => worker.shutdown();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await worker.run();
await pool.end();
