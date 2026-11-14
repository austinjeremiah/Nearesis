/**
 * Kernel-backed environment for canvas acceptance tests: a disposable Postgres database (Engine A's test helpers),
 * the real Kernel + Fastify API (apps/api buildApp) on 127.0.0.1:4199, and the production web build pointed at it.
 * Panel data is SYNTHETIC fixture data (labelled); persistence, commands, revisions and events are the real kernel.
 */
import type { Browser, BrowserContext } from "playwright";
import type { CanvasDocument, PanelSpec } from "@nearesis/contracts";
import { buildApp } from "@nearesis/api";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  loginSession,
  runCmd,
  seedOrg,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";
import { BASE, startWeb, stopWeb } from "./harness.ts";

export const API_PORT = Number(process.env.NEARESIS_WEB_API_PORT ?? 4199);

export interface KernelEnv {
  db: TestDb;
  kernel: Kernel;
  app: Awaited<ReturnType<typeof buildApp>>;
  users: Record<string, { userId: string; subject: string }>;
  session: (name: string) => Promise<Session>;
  close: () => Promise<void>;
}

export async function startKernelEnv(
  members: Record<string, "owner" | "admin" | "analyst" | "viewer"> = { alice: "owner", bob: "analyst" },
  kernelOver: Parameters<typeof testKernel>[1] = {},
): Promise<KernelEnv> {
  const db = await createTestDb();
  const org = await seedOrg(db.admin, "orgb", members);
  const kernel = testKernel(db, kernelOver);
  await kernel.boot();
  kernel.outbox.start();
  const app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  await startWeb({ NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}` });
  return {
    db,
    kernel,
    app,
    users: org.users,
    session: (name) => loginSession(kernel, org.users[name]!.subject),
    close: async () => {
      await stopWeb();
      await app.close();
      kernel.outbox.stop?.();
      await db.drop();
    },
  };
}

/** Creates a workspace and seeds its canvas with the given panels through the real canvas.apply_patch command. */
export async function seedWorkspace(
  env: KernelEnv,
  owner: string,
  panels: PanelSpec[],
): Promise<{ workspaceId: string; doc: CanvasDocument }> {
  const s = await env.session(owner);
  const ws = await createWs(env.kernel, s, "canvas acceptance");
  if (panels.length) {
    await runCmd(
      env.kernel,
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
  }
  return { workspaceId: ws.workspaceId, doc: await env.kernel.canvas.get(s, ws.workspaceId) };
}

/** A browser context logged in as `user` (HttpOnly session cookie set by the web BFF). */
export async function loggedIn(browser: Browser, env: KernelEnv, user: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const r = await ctx.request.post(`${BASE}/api/dev/login`, { data: { subject: env.users[user]!.subject } });
  if (r.status() !== 204) throw new Error(`login failed: ${r.status()}`);
  return ctx;
}
