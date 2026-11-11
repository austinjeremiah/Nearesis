/**
 * Harness for the thesis/capsule browser tests: disposable Postgres DB + real Kernel + Fastify API on
 * NEARESIS_WEB_API_PORT (default 4740), and the web app on NEARESIS_WEB_PORT (default 3620) with its own dist dir.
 * Uses `next dev` when NEARESIS_THESIS_DEV=1 (needed while other agents' files fail `next build` type checking),
 * otherwise `next build` + `next start`. Research capsules are built with the real capsule CLI into a per-run
 * NEARESIS_CAPSULE_DIR shared by the in-process API and the web server.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { spawnSync as run } from "node:child_process";
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
  files: { capsuleDir: string };
  /** Builds a real capsule (SYNTHETIC fixture snapshot + research bundle) into the capsule dir; returns its id. */
  buildCapsule: (id?: string) => string;
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
  const files = { capsuleDir: mkdtempSync(join(tmpdir(), "capsules-")) };
  // The in-process API reads the capsule root from the environment on every request.
  process.env.NEARESIS_CAPSULE_DIR = files.capsuleDir;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEARESIS_WEB_DIST: DIST,
    NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEARESIS_TEST_HOOKS: "1",
    NEARESIS_CAPSULE_DIR: files.capsuleDir,
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
    buildCapsule: (id = "cap-synthetic-2026-11-10") => {
      const appRoot = join(WEB_DIR, "..", "..");
      const r = run(
        "pnpm",
        [
          "--filter",
          "@nearesis/capsule",
          "-s",
          "capsule:build",
          "--snapshot",
          "packages/capsule/fixtures/snapshot-synthetic",
          "--out",
          join(files.capsuleDir, id),
          "--research-bundle",
          "packages/test-fixtures/research/signal-bundle",
          // Research re-execution is the research engine's own check (the API's capsule view skips it too); the run file
          // is still included and hash-checked against the manifest by the thesis loader.
          "--no-research",
        ],
        { cwd: appRoot, encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`capsule build failed: ${r.stderr.slice(-1000)}`);
      return id;
    },
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
