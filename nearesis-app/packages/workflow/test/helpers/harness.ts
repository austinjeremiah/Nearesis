import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@temporalio/client";
import type { Worker } from "@temporalio/worker";
import { ScriptedProvider, scenarioRules, setupCheckpointer, type Policy } from "@nearesis/agent-runtime";
import { APP_ROOT, makeKernelEnv, type KernelEnv } from "../../../agent-runtime/src/testing/kernel-env.ts";
import {
  buildKernelDeps,
  createRuntimeProvider,
  liveModelFromEnv,
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
  /** present when the environment runs the real kernel gateway, leases and plugins */
  kernel?: KernelEnv;
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

export async function makeEnv(opts: { kernel?: boolean } = {}): Promise<Env> {
  const db = await createTestDatabase();
  await setupCheckpointer(db.adminUrl);
  const client = await connectClient();
  const bundlePath = await getBundlePath();
  const kernel = opts.kernel ? await makeKernelEnv({ rtdb: db }) : undefined;
  const tenantId = kernel?.orgId ?? randomUUID();
  const workspaceId = kernel?.workspaceId ?? randomUUID();
  return {
    db,
    client,
    taskQueue: `a3-${randomUUID()}`,
    bundlePath,
    tenantId,
    workspaceId,
    ...(kernel ? { kernel } : {}),
    async stop() {
      await client.connection.close();
      if (kernel) await kernel.stop();
      else await db.drop();
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
  o: { policy?: Partial<Policy>; stepDelayMs?: number; taskQueue?: string; live?: boolean } = {},
) {
  const deps = env.kernel
    ? buildKernelDeps({
        pool: env.db.app,
        appUrl: env.db.appUrl,
        kernel: env.kernel.kernel,
        ...(o.policy ? { policy: o.policy } : {}),
        ...(o.live
          ? { provider: createRuntimeProvider(), liveComposer: true, model: liveModelFromEnv() }
          : { provider: new ScriptedProvider(scenarioRules({ stepDelayMs: o.stepDelayMs ?? 0 })) }),
      })
    : buildDevDeps({
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
  const proc = spawn(process.execPath, ["--import", "tsx", main], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      TASK_QUEUE: env.taskQueue,
      DATABASE_APP_URL: env.db.appUrl,
      WORKER_ID: id,
      WORKFLOW_BUNDLE_PATH: env.bundlePath,
      STEP_DELAY_MS: String(o.stepDelayMs ?? 0),
      POLICY_JSON: JSON.stringify(o.policy ?? {}),
      ...(env.kernel
        ? {
            KERNEL_PLUGIN_ROOT: APP_ROOT,
            KERNEL_TRUSTED_KEYS_JSON: JSON.stringify(env.kernel.trustedKeys),
          }
        : {}),
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
      ...(env.kernel ? { requestedBy: { userId: env.kernel.userId, role: "owner" as const } } : {}),
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

import { buildApp } from "../../../../apps/api/src/app.ts";
import { temporalEngine } from "../../../../apps/api/src/temporal-engine.ts";
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;

export interface Api {
  app: FastifyInstance;
  call(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** The real investigation API (apps/api buildApp) over the test kernel and a Temporal-backed engine on the env's task queue. */
export async function startApi(env: Env): Promise<Api> {
  const kenv = env.kernel!;
  const app = await buildApp({
    kernel: kenv.kernel,
    engine: temporalEngine({ taskQueue: env.taskQueue }),
    nodeEnv: "test",
  });
  const token = await kenv.kernel.devAuth!.login(kenv.subject);
  return {
    app,
    async call(method, url, body, headers = {}) {
      const r = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(body === undefined ? {} : { payload: body as never }),
      });
      return { status: r.statusCode, json: r.json() as Record<string, unknown> };
    },
    async close() {
      await app.close();
    },
  };
}

/** Starts a run through POST /v1/workspaces/:id/questions (scenario fixture selected by a tag in the question text). */
export async function runViaApi(
  env: Env,
  api: Api,
  scenario: string,
  o: { question?: string; budget?: { tokens: number; toolCalls: number; usd: number } } = {},
) {
  const r = await api.call(
    "POST",
    `/v1/workspaces/${env.workspaceId}/questions`,
    {
      question: `[scenario=${scenario}] ${o.question ?? "what drove swap activity?"}`,
      snapshotPolicy: "pinned",
      budget: o.budget ?? { tokens: 200_000, toolCalls: 24, usd: 20 },
    },
    { "idempotency-key": `idem-${randomUUID()}` },
  );
  if (r.status !== 202) throw new Error(`question rejected: ${r.status} ${JSON.stringify(r.json)}`);
  const { runId, workflowId } = r.json as { runId: string; workflowId: string };
  const handle = env.client.workflow.getHandle(workflowId);
  return {
    runId,
    workflowId,
    handle,
    tenantId: env.tenantId,
    workspaceId: env.workspaceId,
    result: () => handle.result() as Promise<InvestigationResult>,
    view: async () => (await api.call("GET", `/v1/runs/${runId}`)).json,
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

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync as wf } from "node:fs";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";

export const HISTORY_DIR = fileURLToPath(new URL("../fixtures/histories", import.meta.url));

/** Exports the parent history and every child history of a run for the A13 replay test. */
export async function exportHistories(env: Env, workflowId: string, prefix: string): Promise<string[]> {
  // Only a deliberate export run (NEARESIS_EXPORT_HISTORIES=1) refreshes the committed fixtures; normal evidence runs leave the tree clean.
  if (process.env.NEARESIS_EXPORT_HISTORIES !== "1") return [];
  mkdirSync(HISTORY_DIR, { recursive: true });
  const ids = [workflowId];
  for await (const wf2 of env.client.workflow.list({
    query: `WorkflowId STARTS_WITH "child-" AND TaskQueue = "${env.taskQueue}"`,
  }))
    ids.push(wf2.workflowId);
  const written: string[] = [];
  for (const id of ids) {
    const h = await env.client.workflow.getHandle(id).fetchHistory();
    const name = `${prefix}__${id.startsWith("child-") ? id.slice(0, 14) : "parent"}__${id.slice(0, 80)}.json`;
    wf(`${HISTORY_DIR}/${name}`, historyToJSON(h));
    written.push(name);
  }
  return written;
}
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
