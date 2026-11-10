import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@temporalio/client";
import type { Worker } from "@temporalio/worker";
import { setupCheckpointer, type Policy } from "@nearesis/agent-runtime";
import {
  bundleWorkflows,
  buildDevDeps,
  connectClient,
  createTestDatabase,
  createWorker,
  startInvestigation,
  withTenant,
  type TestDatabase,
  type InvestigationResult,
} from "../../src/index.ts";

export interface Env {
  db: TestDatabase;
  client: Client;
  taskQueue: string;
  bundlePath: string;
  tenantId: string;
  workspaceId: string;
  stop(): Promise<void>;
}

let bundleCache: string | null = null;
/** One webpack bundle per test process; worker subprocesses reuse the written file. */
export async function getBundlePath(): Promise<string> {
  if (bundleCache) return bundleCache;
  const dir = mkdtempSync(join(tmpdir(), "a3-bundle-"));
  const p = join(dir, "workflow-bundle.js");
  writeFileSync(p, await bundleWorkflows());
  bundleCache = p;
  return p;
}

export async function makeEnv(): Promise<Env> {
  const db = await createTestDatabase();
  await setupCheckpointer(db.adminUrl);
  const client = await connectClient();
  const bundlePath = await getBundlePath();
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  return {
    db,
    client,
    taskQueue: `a3-${randomUUID()}`,
    bundlePath,
    tenantId,
    workspaceId,
    async stop() {
      await client.connection.close();
      await db.drop();
    },
  };
}

export async function seedBudget(
  env: Pick<Env, "db">,
  tenantId: string,
  workspaceId: string,
  budgetId = randomUUID(),
  totals = { tokens: 1_000_000, toolCalls: 10_000, usd: 100 },
): Promise<string> {
  await withTenant(env.db.app, tenantId, (c) =>
    c.query(
      "INSERT INTO budgets (id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,$4,$5,$6)",
      [budgetId, tenantId, workspaceId, totals.tokens, totals.toolCalls, totals.usd],
    ),
  );
  return budgetId;
}

/** In-process worker (shares the test's pool). */
export async function startWorker(
  env: Env,
  o: { policy?: Partial<Policy>; stepDelayMs?: number; taskQueue?: string } = {},
) {
  const deps = buildDevDeps({
    pool: env.db.app,
    appUrl: env.db.appUrl,
    ...(o.policy ? { policy: o.policy } : {}),
    ...(o.stepDelayMs !== undefined ? { stepDelayMs: o.stepDelayMs } : {}),
  });
  const { worker, connection } = await createWorker({
    deps,
    taskQueue: o.taskQueue ?? env.taskQueue,
    workflowBundlePath: env.bundlePath,
  });
  const running = worker.run();
  return {
    worker: worker as Worker,
    deps,
    async stop() {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}

export interface WorkerProc {
  proc: ChildProcess;
  id: string;
  kill(): Promise<void>;
  stop(): Promise<void>;
  killedAt?: string;
}
/** Real worker process; SIGKILL simulates a crash. */
export async function spawnWorkerProcess(
  env: Env,
  id: string,
  o: { policy?: Partial<Policy>; stepDelayMs?: number } = {},
): Promise<WorkerProc> {
  const main = fileURLToPath(new URL("../../src/worker-main.ts", import.meta.url));
  const proc = spawn("node_modules/.bin/tsx", [main], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      TASK_QUEUE: env.taskQueue,
      DATABASE_APP_URL: env.db.appUrl,
      WORKER_ID: id,
      WORKFLOW_BUNDLE_PATH: env.bundlePath,
      STEP_DELAY_MS: String(o.stepDelayMs ?? 0),
      POLICY_JSON: JSON.stringify(o.policy ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`worker ${id} not ready: ${out.slice(-500)}`)), 60_000);
    proc.stdout!.on("data", (b) => {
      out += String(b);
      if (out.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr!.on("data", (b) => (out += String(b)));
    proc.on("exit", (code) => {
      if (!out.includes("READY")) reject(new Error(`worker ${id} exited ${code}: ${out.slice(-500)}`));
    });
  });
  await ready;
  const exited = new Promise<void>((r) => proc.on("exit", () => r()));
  const wp: WorkerProc = {
    proc,
    id,
    async kill() {
      wp.killedAt = new Date().toISOString();
      proc.kill("SIGKILL");
      await exited;
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
    },
  };
  return wp;
}

export async function runInvestigation(
  env: Env,
  scenario: string,
  o: {
    budgetId?: string;
    investigationId?: string;
    question?: string;
    workspaceId?: string;
    tenantId?: string;
  } = {},
) {
  const tenantId = o.tenantId ?? env.tenantId;
  const workspaceId = o.workspaceId ?? env.workspaceId;
  const budgetId = o.budgetId ?? (await seedBudget(env, tenantId, workspaceId));
  const started = await startInvestigation(
    env.client,
    {
      tenantId,
      workspaceId,
      investigationId: o.investigationId ?? randomUUID(),
      questionId: randomUUID(),
      snapshotRef: "snapshot-p02-baseline",
      budgetId,
      scenario,
      question: o.question ?? "what drove swap activity?",
    },
    { taskQueue: env.taskQueue },
  );
  const handle = env.client.workflow.getHandle(started.workflowId);
  return {
    ...started,
    handle,
    tenantId,
    workspaceId,
    budgetId,
    result: () => handle.result() as Promise<InvestigationResult>,
  };
}

export async function q<T = Record<string, unknown>>(
  env: Env,
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withTenant(env.db.app, tenantId, async (c) => (await c.query(sql, params)).rows as T[]);
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
  everyMs = 200,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
