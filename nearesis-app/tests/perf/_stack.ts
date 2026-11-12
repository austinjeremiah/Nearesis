/**
 * Shared stack for the browser-facing PERF tests (PERF05, PERF06): disposable Postgres, the real kernel + API on a
 * private port, the production web build (dist `.next-perf`, built by PERF02 or on demand) on a private port, and a
 * Playwright Chromium. Never touches ports 3300/4110/4400 or any shared database.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { APP_ROOT } from "./_reference.ts";

const WEB_DIR = resolve(APP_ROOT, "apps", "web");

/* eslint-disable @typescript-eslint/no-explicit-any -- kernel handles are used structurally by the PERF tests */
type StackKernel = any;
type StackSession = any;
export interface Stack {
  db: {
    adminUrl: string;
    drop(): Promise<void>;
    admin: { query(t: string, p?: unknown[]): Promise<{ rows: Array<Record<string, any>> }> };
  };
  kernel: StackKernel;
  app: { close(): Promise<void> };
  users: Record<string, { userId: string; subject: string }>;
  session: (name: string) => Promise<StackSession>;
  browser: Browser;
  base: string;
  apiPort: number;
  webPort: number;
  buildId: string;
  restartWeb: () => Promise<void>;
  close: () => Promise<void>;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
export interface StackOptions {
  apiPort: number;
  webPort: number;
  org: string;
  members?: Record<string, "owner" | "admin" | "analyst" | "viewer">;
  kernelOver?: Record<string, unknown>;
}

const up = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};

export async function startStack(o: StackOptions): Promise<Stack | { blocked: string }> {
  // The web acceptance harness reads these at import time.
  process.env.NEARESIS_WEB_PORT = String(o.webPort);
  process.env.NEARESIS_WEB_API_PORT = String(o.apiPort);
  process.env.NEARESIS_WEB_DIST = ".next-perf";
  const [{ buildApp }, kt, h] = await Promise.all([
    import("../../apps/api/src/index.ts"),
    import("../../packages/kernel/test/helpers/index.ts"),
    import("../../apps/web/test/acceptance/harness.ts"),
  ]);
  const db = await kt.createTestDb();
  // The run-listing routes read the runtime schema; without it every workspace load would carry a 503.
  const { migrate: runtimeMigrate, makePool } = await import("../../packages/workflow/src/db.ts");
  const rtPool = makePool(db.adminUrl, 2);
  await runtimeMigrate(rtPool);
  await rtPool.end();
  const org = await kt.seedOrg(db.admin, o.org, o.members ?? { alice: "owner" });
  const kernel = kt.testKernel(db, (o.kernelOver ?? {}) as never);
  await kernel.boot();
  kernel.outbox.start();
  const app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
  await app.listen({ host: "127.0.0.1", port: o.apiPort });
  const dist = ".next-perf";
  if (await up(o.webPort)) throw new Error(`port ${o.webPort} is already serving`);
  if (!existsSync(join(WEB_DIR, dist, "BUILD_ID")) || process.env.PERF_REBUILD === "1") {
    const b = spawnSync("pnpm", ["exec", "next", "build"], {
      cwd: WEB_DIR,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEARESIS_WEB_DIST: dist },
    });
    if (b.status !== 0) {
      await app.close();
      await db.drop();
      return { blocked: `next build failed (exit ${b.status})` };
    }
  }
  let web: ChildProcess | null = null;
  const startWeb = async () => {
    web = spawn("pnpm", ["exec", "next", "start", "-p", String(o.webPort), "-H", "127.0.0.1"], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NEARESIS_TEST_HOOKS: "1",
        NEARESIS_WEB_DIST: dist,
        NEARESIS_API_URL: `http://127.0.0.1:${o.apiPort}`,
        NODE_ENV: "production",
      },
      stdio: "ignore",
      detached: true,
    });
    for (let i = 0; i < 120 && !(await up(o.webPort)); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await up(o.webPort))) throw new Error("web server did not start");
  };
  const stopWeb = async () => {
    if (web?.pid) {
      try {
        process.kill(-web.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    for (let i = 0; i < 40 && (await up(o.webPort)); i++) await new Promise((r) => setTimeout(r, 250));
    web = null;
  };
  let browser: Browser;
  try {
    await startWeb();
    browser = await h.launch();
  } catch (e) {
    await stopWeb();
    await app.close();
    await db.drop();
    throw e;
  }
  return {
    db,
    kernel,
    app,
    users: org.users,
    session: (n) => kt.loginSession(kernel, org.users[n]!.subject),
    browser,
    base: `http://127.0.0.1:${o.webPort}`,
    apiPort: o.apiPort,
    webPort: o.webPort,
    buildId: readFileSync(join(WEB_DIR, dist, "BUILD_ID"), "utf8").trim(),
    restartWeb: async () => {
      await stopWeb();
      await startWeb();
    },
    close: async () => {
      await browser.close();
      await stopWeb();
      kernel.outbox.stop?.();
      await app.close();
      await db.drop();
    },
  };
}
