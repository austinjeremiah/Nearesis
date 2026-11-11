import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "playwright";
import { type ChildProcess, spawn } from "node:child_process";
import { buildApp } from "@nearesis/api";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "@nearesis/kernel/testing";
import type { PanelSpec } from "@nearesis/contracts";
import { chromium } from "playwright";
import { BASE, PORT, WEB_DIR } from "./harness.ts";
import type { KernelEnv } from "./kernel-harness.ts";

/** Bearer-token client for the kernel API (`apps/api` buildApp) used to arrange backend state the UI then shows. */
export async function apiClient(env: Pick<KernelEnv, "app" | "users">, user: string) {
  const r = await env.app.inject({
    method: "POST",
    url: "/v1/dev/login",
    payload: { oidcSubject: env.users[user]!.subject },
  });
  if (r.statusCode !== 200) throw new Error(`api login failed: ${r.statusCode}`);
  const headers = { authorization: `Bearer ${(r.json() as { token: string }).token}` };
  return {
    async command(workspaceId: string, commandType: string, payload: Record<string, unknown>) {
      const v = (
        await env.app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}`, headers })
      ).json<{ version: number }>().version;
      const res = await env.app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/commands`,
        headers,
        payload: { apiVersion: "v1", commandId: randomUUID(), commandType, payload, expectedVersion: v },
      });
      if (res.statusCode !== 200)
        throw new Error(`${commandType} -> ${res.statusCode} ${res.body.slice(0, 300)}`);
    },
    async post(url: string, payload: unknown) {
      return env.app.inject({ method: "POST", url, headers, payload: payload as object });
    },
    async get<T>(url: string): Promise<T> {
      return (await env.app.inject({ method: "GET", url, headers })).json<T>();
    },
  };
}

export async function openMonitoring(
  browser: Browser,
  ctx: BrowserContext,
  workspaceId: string,
  hash = "#monitoring",
) {
  void browser;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/w/${workspaceId}?backend=kernel${hash}`);
  await page.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
  );
  return page;
}

/**
 * Real-kernel environment for the monitoring browser tests (B3): disposable Postgres, real Kernel + `buildApp` on the
 * B3 API port, and `next dev` on the B3 web port (`next build` can fail on other agents' in-progress type errors).
 * Panel data is SYNTHETIC fixture data; persistence, commands, scheduler and events are the real kernel.
 */
export async function startRealEnv(panels: PanelSpec[]) {
  const apiPort = Number(process.env.NEARESIS_WEB_API_PORT ?? 4741);
  const db = await createTestDb();
  const org = await seedOrg(db.admin, "orgb3", { alice: "owner", bob: "analyst" });
  const kernel = testKernel(db);
  await kernel.boot();
  kernel.outbox.start();
  const app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
  await app.listen({ host: "127.0.0.1", port: apiPort });
  const s = await loginSession(kernel, org.users.alice!.subject);
  const ws = await createWs(kernel, s, "monitoring real-kernel");
  await runCmd(
    kernel,
    s,
    ws.workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      operations: panels.map((panel) => ({ op: "addPanel", panel })),
    },
    ws.version,
  );
  const server: ChildProcess = spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NEARESIS_WEB_DIST: process.env.NEARESIS_WEB_DIST ?? ".next-b3",
      NEARESIS_API_URL: `http://127.0.0.1:${apiPort}`,
      NEARESIS_TEST_HOOKS: "1",
    },
    stdio: "ignore",
    detached: true,
  });
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error("web dev server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ headless: true });
  return {
    db,
    kernel,
    app,
    users: org.users,
    workspaceId: ws.workspaceId,
    browser,
    async loggedIn(user: string) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const r = await ctx.request.post(`${BASE}/api/dev/login`, {
        data: { subject: org.users[user]!.subject },
      });
      if (r.status() !== 204) throw new Error(`login failed: ${r.status()}`);
      return ctx;
    },
    async close() {
      await browser.close();
      try {
        if (server.pid) process.kill(-server.pid, "SIGTERM");
      } catch {
        /* gone */
      }
      await app.close();
      kernel.outbox.stop?.();
      await db.drop();
    },
  };
}
