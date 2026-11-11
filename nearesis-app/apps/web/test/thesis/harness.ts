/**
 * Harness for the thesis/capsule browser tests: disposable Postgres DB + real Kernel + Fastify API on
 * NEARESIS_WEB_API_PORT (default 4740), and the web app on NEARESIS_WEB_PORT (default 3620) with its own dist dir.
 * Uses `next dev` when NEARESIS_THESIS_DEV=1 (needed while other agents' files fail `next build` type checking),
 * otherwise `next build` + `next start`. Injected research/capsule files are test-only and labelled SYNTHETIC.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildApp } from "@nearesis/api";
import type { Kernel } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  loginSession,
  seedOrg,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";

export const WEB_DIR = new URL("../..", import.meta.url).pathname;
export const WEB_PORT = Number(process.env.NEARESIS_WEB_PORT ?? 3620);
export const API_PORT = Number(process.env.NEARESIS_WEB_API_PORT ?? 4740);
export const BASE = `http://127.0.0.1:${WEB_PORT}`;
const DIST = ".next-engine-b";

export interface Env {
  db: TestDb;
  kernel: Kernel;
  workspaceId: string;
  subject: string;
  files: { artifacts: string; capsule: string };
  browser: Browser;
  close: () => Promise<void>;
}

async function poll(fn: () => Promise<boolean>, deadlineMs: number, what: string): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startEnv(): Promise<Env> {
  const db = await createTestDb();
  const org = await seedOrg(db.admin, "thesis", { alice: "owner" });
  const kernel = testKernel(db);
  await kernel.boot();
  const app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  const s = await loginSession(kernel, org.users.alice!.subject);
  const ws = await createWs(kernel, s, "NEAR Intents vs price as a leading indicator of adoption");
  const tmp = mkdtempSync(join(tmpdir(), "thesis-"));
  const files = { artifacts: join(tmp, "artifacts.json"), capsule: join(tmp, "capsule.json") };
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEARESIS_WEB_DIST: DIST,
    NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEARESIS_TEST_HOOKS: "1",
    NEARESIS_TEST_RESEARCH_ARTIFACTS: files.artifacts,
    NEARESIS_TEST_CAPSULE: files.capsule,
  };
  const dev = process.env.NEARESIS_THESIS_DEV === "1";
  if (!dev) {
    const b = spawnSync("pnpm", ["exec", "next", "build"], { cwd: WEB_DIR, env, encoding: "utf8" });
    if (b.status !== 0)
      throw new Error(
        `next build failed (set NEARESIS_THESIS_DEV=1 to use next dev): ${b.stdout.slice(-1500)}${b.stderr.slice(-1500)}`,
      );
  }
  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", dev ? "dev" : "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"],
    {
      cwd: WEB_DIR,
      env: dev ? env : { ...env, NODE_ENV: "production" },
      stdio: "ignore",
      detached: true,
    },
  );
  await poll(
    async () => (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })).ok,
    180_000,
    "web server",
  );
  const browser = await chromium.launch({ headless: true });
  return {
    db,
    kernel,
    workspaceId: ws.workspaceId,
    subject: org.users.alice!.subject,
    files,
    browser,
    close: async () => {
      await browser.close();
      try {
        if (server.pid) process.kill(-server.pid, "SIGTERM");
      } catch {
        /* gone */
      }
      await app.close();
      await db.drop();
    },
  };
}

export async function loggedIn(env: Env): Promise<BrowserContext> {
  const ctx = await env.browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const r = await ctx.request.post(`${BASE}/api/dev/login`, { data: { subject: env.subject } });
  if (r.status() >= 300) throw new Error(`login failed: ${r.status()}`);
  return ctx;
}

/** Opens a page with a CSP-violation listener, waits (with a deadline) for the page's ready flag. */
export async function open(
  ctx: BrowserContext,
  path: string,
  readyFlag: string,
): Promise<{ page: Page; csp: () => Promise<unknown[]>; errors: string[] }> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__csp.push({ directive: e.violatedDirective, source: e.sourceFile }),
    );
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForFunction(
    (f) => (window as unknown as Record<string, { ready?: boolean } | undefined>)[f]?.ready === true,
    readyFlag,
    { timeout: 180_000 },
  );
  return { page, csp: () => page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp), errors };
}
