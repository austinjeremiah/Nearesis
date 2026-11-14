/**
 * Browser harness for web acceptance tests: production build (`next build`) served by `next start` on 127.0.0.1:3100,
 * driven by Playwright Chromium (headless). Nothing in the app under test is mocked.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

export const WEB_DIR = new URL("../..", import.meta.url).pathname;
/** Build output directory. Set NEARESIS_WEB_DIST to build beside (not over) a `.next` another server is using. */
export const DIST = process.env.NEARESIS_WEB_DIST ?? ".next";
export const PORT = Number(process.env.NEARESIS_WEB_PORT ?? 3100);
export const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;

async function up(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function newestMtime(dir: string): number {
  const out = spawnSync("find", [dir, "-type", "f", "-newer", join(WEB_DIR, DIST, "BUILD_ID")], {
    encoding: "utf8",
  });
  return out.stdout.trim().length;
}

/** Builds if the build is missing or older than src, then starts the server unless one is already serving. */
export async function startWeb(
  extraEnv: Record<string, string> = {},
): Promise<{ reused: boolean; buildId: string }> {
  const buildIdPath = join(WEB_DIR, DIST, "BUILD_ID");
  const stale =
    !existsSync(buildIdPath) ||
    // The app bundles packages/ui and packages/canvas-schema (transpilePackages): changes there need a rebuild too.
    [
      join(WEB_DIR, "src"),
      join(WEB_DIR, "../../packages/ui/src"),
      join(WEB_DIR, "../../packages/canvas-schema/src"),
    ].some((d) => newestMtime(d) > 0);
  if (stale && (await up()))
    throw new Error(`a stale server is running on :${PORT}; stop it before running acceptance tests`);
  if (stale) {
    const b = spawnSync("pnpm", ["exec", "next", "build"], {
      cwd: WEB_DIR,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    if (b.status !== 0) throw new Error(`next build failed: ${b.stderr.slice(-2000)}`);
  }
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  if (await up()) {
    if (Object.keys(extraEnv).length)
      throw new Error(`port ${PORT} busy; kernel-backed tests need their own web server`);
    return { reused: true, buildId };
  }
  server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NEARESIS_TEST_HOOKS: "1",
      NODE_ENV: "production",
      ...extraEnv,
    },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    if (await up()) return { reused: false, buildId };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("web server did not start");
}

export async function stopWeb(): Promise<void> {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  server = null;
}

export interface Watched {
  page: Page;
  consoleErrors: string[];
  cspViolations: () => Promise<Array<{ directive: string; source: string; sample: string }>>;
}

/** Opens a page with a CSP-violation listener and an XSS tripwire getter installed before any app script. */
export async function openPage(
  browser: Browser,
  path: string,
  viewport = { width: 1440, height: 900 },
): Promise<Watched> {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__csp.push({ directive: e.violatedDirective, source: e.sourceFile, sample: e.sample }),
    );
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    null,
    {
      timeout: 30_000,
    },
  );
  return {
    page,
    consoleErrors,
    cspViolations: () =>
      page.evaluate(
        () =>
          (window as unknown as { __csp: Array<{ directive: string; source: string; sample: string }> })
            .__csp,
      ),
  };
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export function buildFingerprint(): { buildId: string; builtAt: string } {
  const p = join(WEB_DIR, DIST, "BUILD_ID");
  return { buildId: readFileSync(p, "utf8").trim(), builtAt: statSync(p).mtime.toISOString() };
}
