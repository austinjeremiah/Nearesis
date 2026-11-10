import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, bundleWorkflowCode } from "@temporalio/worker";
import { createActivities, type ActivityDeps } from "./activities.ts";
import { TASK_QUEUE } from "./types.ts";

export const WORKFLOWS_PATH = fileURLToPath(new URL("./workflows.ts", import.meta.url));
export const DEFAULT_ADDRESS = "127.0.0.1:57233";

export interface WorkerOpts {
  deps: ActivityDeps;
  taskQueue?: string;
  address?: string;
  namespace?: string;
  identity?: string;
  /** Pre-bundled workflow code (see `bundleWorkflows`). Avoids a webpack run per worker process. */
  workflowBundlePath?: string;
  maxConcurrentActivityTaskExecutions?: number;
}

/** Bundles deterministic workflow code once (written to a file other worker processes can reuse). */
export async function bundleWorkflows(): Promise<string> {
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  return code;
}

export async function createWorker(
  opts: WorkerOpts,
): Promise<{ worker: Worker; connection: NativeConnection }> {
  const connection = await NativeConnection.connect({
    address: opts.address ?? process.env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS,
  });
  const worker = await Worker.create({
    connection,
    namespace: opts.namespace ?? "default",
    taskQueue: opts.taskQueue ?? TASK_QUEUE,
    ...(opts.identity ? { identity: opts.identity } : {}),
    activities: createActivities(opts.deps),
    ...(opts.workflowBundlePath
      ? { workflowBundle: { codePath: opts.workflowBundlePath } }
      : { workflowsPath: WORKFLOWS_PATH }),
    maxConcurrentActivityTaskExecutions: opts.maxConcurrentActivityTaskExecutions ?? 16,
  });
  return { worker, connection };
}
