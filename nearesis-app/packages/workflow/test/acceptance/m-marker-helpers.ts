/** Shared fixtures for the marker acceptance tests that need the real API, Temporal and the scripted agent runtime (M10-M12). */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PanelSpec } from "@nearesis/contracts";
import { buildApp } from "../../../../apps/api/src/app.ts";
import { temporalEngine } from "../../../../apps/api/src/temporal-engine.ts";
import { connectClient } from "../../src/index.ts";
import { q, type Api, type Env } from "../helpers/harness.ts";

export const sha256 = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export interface Actor {
  name: string;
  userId: string;
  token: string;
  call(
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
}

/** Adds an org member and returns a caller bound to that member's own session against the given app. */
export async function addMember(
  env: Env,
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  role: "owner" | "admin" | "analyst" | "viewer",
): Promise<Actor> {
  const kenv = env.kernel!;
  const userId = randomUUID();
  const subject = `m.${name}.${randomBytes(3).toString("hex")}`;
  await kenv.kernelAdmin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
    userId,
    subject,
    name,
  ]);
  await kenv.kernelAdmin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3)", [
    kenv.orgId,
    userId,
    role,
  ]);
  const token = await kenv.kernel.devAuth!.login(subject);
  return actorFor(app, name, userId, token);
}
export function actorFor(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  userId: string,
  token: string,
): Actor {
  return {
    name,
    userId,
    token,
    async call(method, url, body) {
      const r = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as never }),
      });
      const text = r.body;
      return { status: r.statusCode, json: text ? (r.json() as Record<string, unknown>) : {} };
    },
  };
}

export async function command(a: Actor, ws: string, commandType: string, payload: Record<string, unknown>) {
  const v = ((await a.call("GET", `/v1/workspaces/${ws}`)).json as { version: number }).version;
  return a.call("POST", `/v1/workspaces/${ws}/commands`, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType,
    payload,
    expectedVersion: v,
  });
}

export const panelSpec = () =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Swap volume",
    queryRef: { hash: "d".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: {
      fields: ["day", "usd_volume"],
      units: { usd_volume: "USD" },
      timezone: "UTC",
      completeness: "complete",
    },
    encoding: { x: "day", y: ["usd_volume"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

export const INTERVAL = { start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" };
export const selectionFor = () => ({
  queryHash: "d".repeat(64),
  semanticVersion: "1.0.0",
  interval: INTERVAL,
  seriesIds: ["usd_volume"],
  axisUnits: { usd_volume: "USD" },
  sourceWatermark: INTERVAL.end,
});

export async function addPanel(a: Actor, ws: string) {
  const panel = panelSpec();
  const r = await command(a, ws, "canvas.apply_patch", {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: "addPanel", panel }],
  });
  if (r.status !== 200) throw new Error(`addPanel failed ${r.status} ${JSON.stringify(r.json)}`);
  return panel;
}

export async function createMarker(a: Actor, ws: string, panelId: string, question: string, activate = true) {
  const markerId = randomUUID();
  const r = await command(a, ws, "marker.create", {
    panelId,
    markerId,
    anchor: { kind: "time_range", ...INTERVAL },
    question,
    selection: selectionFor(),
  });
  if (r.status !== 200) throw new Error(`marker.create ${r.status} ${JSON.stringify(r.json)}`);
  if (activate) {
    const t = await command(a, ws, "marker.transition", { markerId, to: "ACTIVE" });
    if (t.status !== 200) throw new Error(`marker.transition ${t.status}`);
  }
  return markerId;
}

/** Ground-truth counters: agent spawns (runtime tasks), workflow starts (runs), ledger rows and cost, marker tasks. */
export async function counters(env: Env, ws: string) {
  const one = async (sql: string) => (await q<{ n: string }>(env, env.tenantId, sql, [ws]))[0]!.n;
  return {
    spawns: Number(await one("SELECT count(*)::text n FROM tasks WHERE workspace_id=$1")),
    runs: Number(await one("SELECT count(*)::text n FROM runs WHERE workspace_id=$1")),
    ledgerRows: Number(await one("SELECT count(*)::text n FROM budget_ledger WHERE workspace_id=$1")),
    ledgerUsd: Number(
      await one("SELECT coalesce(sum(usd),0)::text n FROM budget_ledger WHERE workspace_id=$1"),
    ),
    markerTasks: Number(
      (
        await env.kernel!.kernelAdmin.query(
          "SELECT count(*)::int n FROM marker_tasks WHERE workspace_id=$1",
          [ws],
        )
      ).rows[0].n,
    ),
  };
}

export async function temporalCount(taskQueue: string): Promise<number> {
  const c = await connectClient();
  let n = 0;
  for await (const _w of c.workflow.list({ query: `TaskQueue = "${taskQueue}"` })) n++;
  await c.connection.close();
  return n;
}

/** A second API over the same kernel whose engine is a REAL Temporal client pointed at an address nothing listens on. */
export async function unreachableApi(env: Env) {
  return buildApp({
    kernel: env.kernel!.kernel,
    engine: temporalEngine({ address: "127.0.0.1:1", taskQueue: env.taskQueue }),
    nodeEnv: "test",
  });
}
export type { Api };

import { ScriptedProvider, scenarioRules, type ScriptRule } from "@nearesis/agent-runtime";
import { buildKernelDeps, createWorker } from "../../src/index.ts";

/**
 * A real in-process Temporal worker with the kernel-backed runtime and a ScriptedProvider whose rule list is
 * `custom` followed by the stock scenario rules (first match wins). Same wiring as the harness's `startWorker`.
 */
export async function startScriptedWorker(
  env: Env,
  custom: ScriptRule[],
  o: { policy?: Parameters<typeof buildKernelDeps>[0]["policy"]; stepDelayMs?: number } = {},
) {
  const deps = buildKernelDeps({
    pool: env.db.app,
    appUrl: env.db.appUrl,
    kernel: env.kernel!.kernel,
    ...(o.policy ? { policy: o.policy } : {}),
    provider: new ScriptedProvider([...custom, ...scenarioRules({ stepDelayMs: o.stepDelayMs ?? 0 })]),
  });
  const { worker, connection } = await createWorker({
    deps,
    taskQueue: env.taskQueue,
    workflowBundlePath: env.bundlePath,
  });
  const running = worker.run();
  return {
    deps,
    async stop() {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}
