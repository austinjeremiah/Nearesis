/**
 * P11 harness: disposable Postgres DB + the real Kernel + Fastify API (restartable, to test SSE recovery) + the real web
 * app (`next build` + `next start`, or `next dev` when NEARESIS_P11_DEV=1) + Playwright Chromium.
 * Two orgs: org A (alice owner, carol viewer) and org B (bob owner). Ports/dist: 3622 / 4742 / .next-b4 by default.
 * Panel data is the SYNTHETIC fixture data route; persistence, auth, ACLs, revisions and events are the real kernel.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildApp } from "@nearesis/api";
import type { PanelSpec } from "@nearesis/contracts";
import type { Kernel } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  loginSession,
  runCmd,
  seedOrg,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";

export const WEB_DIR = new URL("../..", import.meta.url).pathname;
export const SHOTS = `${WEB_DIR}test-results/p11`;
export const WEB_PORT = Number(process.env.NEARESIS_WEB_PORT ?? 3622);
export const API_PORT = Number(process.env.NEARESIS_WEB_API_PORT ?? 4742);
export const BASE = `http://127.0.0.1:${WEB_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}`;
const DIST = process.env.NEARESIS_WEB_DIST ?? ".next-b4";
export const DEV = process.env.NEARESIS_P11_DEV === "1";

type App = Awaited<ReturnType<typeof buildApp>>;

export interface Env {
  db: TestDb;
  kernel: Kernel;
  browser: Browser;
  subjects: { alice: string; carol: string; bob: string };
  /** Workspace of org A (owner alice) and of org B (owner bob). */
  wsA: string;
  wsB: string;
  capsuleDir: string;
  /** Builds a real capsule (SYNTHETIC fixture snapshot + research bundle) with the capsule CLI; returns its id. */
  buildCapsule: (id?: string) => string;
  stopApi: () => Promise<void>;
  startApi: () => Promise<void>;
  close: () => Promise<void>;
}

export async function poll<T>(
  fn: () => Promise<T | false | null | undefined>,
  deadlineMs: number,
  what: string,
  everyMs = 150,
): Promise<T> {
  const end = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last).slice(0, 200)}` : ""}`);
}

export async function startEnv(): Promise<Env> {
  mkdirSync(SHOTS, { recursive: true });
  const db = await createTestDb();
  const orgA = await seedOrg(db.admin, "p11a", { alice: "owner", carol: "viewer" });
  const orgB = await seedOrg(db.admin, "p11b", { bob: "owner" });
  const kernel = testKernel(db);
  await kernel.boot();
  let app: App | null = null;
  const startApi = async () => {
    if (app) return;
    app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
    await app.listen({ host: "127.0.0.1", port: API_PORT });
  };
  const stopApi = async () => {
    const a = app;
    app = null;
    if (a) {
      // Open SSE connections would hold close() forever; closeAllConnections tears them down like a crash.
      (a.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await a.close();
    }
  };
  await startApi();
  const sA = await loginSession(kernel, orgA.users.alice!.subject);
  const sB = await loginSession(kernel, orgB.users.bob!.subject);
  const wsA = (await createWs(kernel, sA, "P11 workspace A")).workspaceId;
  const wsB = (await createWs(kernel, sB, "P11 workspace B")).workspaceId;
  const tmp = mkdtempSync(join(tmpdir(), "p11-"));
  const capsuleDir = join(tmp, "capsules");
  mkdirSync(capsuleDir, { recursive: true });
  // The in-process API reads the capsule root from the environment on every request.
  process.env.NEARESIS_CAPSULE_DIR = capsuleDir;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEARESIS_WEB_DIST: DIST,
    NEARESIS_API_URL: API,
    NEARESIS_TEST_HOOKS: "1",
    NEARESIS_CAPSULE_DIR: capsuleDir,
  };
  if (!DEV) {
    const b = spawnSync("pnpm", ["exec", "next", "build"], { cwd: WEB_DIR, env, encoding: "utf8" });
    if (b.status !== 0)
      throw new Error(
        `next build failed (set NEARESIS_P11_DEV=1 for next dev): ${b.stdout.slice(-1200)}${b.stderr.slice(-1200)}`,
      );
  }
  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", DEV ? "dev" : "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"],
    { cwd: WEB_DIR, env: DEV ? env : { ...env, NODE_ENV: "production" }, stdio: "ignore", detached: true },
  );
  await poll(
    async () => (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })).ok,
    180_000,
    "web server",
    300,
  );
  const browser = await chromium.launch({ headless: true });
  return {
    db,
    kernel,
    browser,
    subjects: {
      alice: orgA.users.alice!.subject,
      carol: orgA.users.carol!.subject,
      bob: orgB.users.bob!.subject,
    },
    wsA,
    wsB,
    capsuleDir,
    buildCapsule: (id = "cap-synthetic-p11") => {
      const r = spawnSync(
        "pnpm",
        [
          "--filter",
          "@nearesis/capsule",
          "-s",
          "capsule:build",
          "--snapshot",
          "packages/capsule/fixtures/snapshot-synthetic",
          "--out",
          join(capsuleDir, id),
          "--research-bundle",
          "packages/test-fixtures/research/signal-bundle",
        ],
        { cwd: join(WEB_DIR, "..", ".."), encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`capsule build failed: ${r.stderr.slice(-800)}`);
      return id;
    },
    stopApi,
    startApi,
    close: async () => {
      await browser.close();
      try {
        if (server.pid) process.kill(-server.pid, "SIGTERM");
      } catch {
        /* gone */
      }
      await stopApi();
      await db.drop();
    },
  };
}

/** Next's own devtools bundle (dev mode only) is not page content. */
export const contentCsp = (v: unknown[]) =>
  DEV ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools")) : v;

export async function loggedIn(
  env: Env,
  who: "alice" | "carol" | "bob",
  opts: { width?: number; height?: number } = {},
): Promise<BrowserContext> {
  const ctx = await env.browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    deviceScaleFactor: 1,
  });
  const r = await ctx.request.post(`${BASE}/api/dev/login`, { data: { subject: env.subjects[who] } });
  if (r.status() >= 300) throw new Error(`login failed: ${r.status()}`);
  return ctx;
}

export interface Watched {
  page: Page;
  csp: () => Promise<unknown[]>;
  errors: string[];
  xss: () => Promise<unknown>;
}

/** New page with a CSP-violation listener, an XSS tripwire (`window.__xss`) and page-error capture. */
export async function watch(ctx: BrowserContext): Promise<Watched> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("dialog", (d) => {
    errors.push(`dialog:${d.message()}`);
    void d.dismiss();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__csp.push({ directive: e.violatedDirective, source: e.sourceFile, blocked: e.blockedURI }),
    );
  });
  return {
    page,
    errors,
    csp: async () => contentCsp(await page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp)),
    xss: () => page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
  };
}

export async function ready(page: Page, flag = "__nearesis", timeout = 180_000): Promise<void> {
  await page.waitForFunction(
    (f) => (window as unknown as Record<string, { ready?: boolean } | undefined>)[f]?.ready === true,
    flag,
    { timeout },
  );
}

/** Applies panels to a workspace through the real canvas.apply_patch command. */
export async function seedPanels(
  env: Env,
  who: "alice" | "bob",
  workspaceId: string,
  panels: PanelSpec[],
): Promise<void> {
  const s = await loginSession(env.kernel, env.subjects[who]);
  const ws = await env.kernel.workspaces.get(s, workspaceId);
  const doc = await env.kernel.canvas.get(s, workspaceId);
  await runCmd(
    env.kernel,
    s,
    workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: doc.documentRevision,
      operations: panels.map((panel) => ({ op: "addPanel", panel })),
    },
    ws.version,
  );
}

/** Kernel HTTP API helper for the given user (bearer token), used to seed graph nodes etc. */
export async function apiFor(env: Env, who: "alice" | "bob" | "carol", workspaceId: string) {
  const token = await env.kernel.devAuth!.login(env.subjects[who]);
  const base = `${API}/v1/workspaces/${workspaceId}`;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const version = async () =>
    ((await (await fetch(base, { headers: h })).json()) as { version: number }).version;
  return {
    token,
    async node(kind: string, label: string, extra: Record<string, unknown> = {}): Promise<string> {
      const r = await fetch(`${base}/graph/nodes`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ expectedVersion: await version(), kind, label, ...extra }),
      });
      const j = (await r.json()) as { result?: { nodeId: string } };
      if (!r.ok)
        throw new Error(`node ${label.slice(0, 30)}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
      return j.result!.nodeId;
    },
  };
}

const HOSTILE_KEYS = new Set([
  "text",
  "label",
  "title",
  "detail",
  "statement",
  "summary",
  "criterion",
  "name",
]);
/** Replaces every human-readable string field of a JSON record with a hostile payload (hashes and ids untouched). */
export function hostilize(v: unknown, payloads: string[], n = { i: 0 }): unknown {
  if (Array.isArray(v)) return v.map((x) => hostilize(x, payloads, n));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        typeof x === "string" && HOSTILE_KEYS.has(k)
          ? payloads[n.i++ % payloads.length]
          : hostilize(x, payloads, n),
      ]),
    );
  return v;
}
