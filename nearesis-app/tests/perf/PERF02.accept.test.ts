/**
 * PERF02: a 50-panel canvas. PASS: bounded memory, responsive input, no long main-thread block (ch.16; thresholds
 * frozen in reference.json). Real kernel + API (127.0.0.1:4750) and the production web build (127.0.0.1:3650, built into
 * a separate dist) driven by Playwright Chromium. Fifty panels are persisted through canvas.apply_patch and rendered
 * with data from the guarded semantic gateway. Measured: JS heap after GC, every long task during load and
 * interaction, and keydown-to-DOM acknowledgement latency of 60 optimistic panel moves.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import { APP_ROOT, DRYRUN, conditions, gate, reference, sha256Text, stats } from "./_reference.ts";

process.env.NEARESIS_WEB_PORT = String(3650);
process.env.NEARESIS_WEB_API_PORT = String(4750);
process.env.NEARESIS_WEB_DIST = ".next-perf";

const PANELS = 50;
export const FIXTURE_SPEC = {
  panels: PANELS,
  source: "apps/web fixtures baseline scenario panels cycled, distinct ids, 3x3 grid cells in 12 columns",
  interactions: "60 optimistic moves (Alt+ArrowDown then Alt+ArrowUp pairs) on rotating panels",
  viewport: { width: 1440, height: 900 },
  buildMode: "production (next build + next start, dist .next-perf)",
};

type KernelHarness = typeof import("../../apps/web/test/acceptance/kernel-harness.ts");
type Harness = typeof import("../../apps/web/test/acceptance/harness.ts");
let kh: KernelHarness;
let h: Harness;
let env: KernelHarnessEnv | null = null;
let browser: Browser | null = null;
let web: ChildProcess | null = null;
let webBlocked: string | null = null;
const g = gate(import.meta.url);
const WEB_DIR = resolve(APP_ROOT, "apps", "web");
const PORT = 3650;
const API_PORT = 4750;

interface KernelHarnessEnv {
  db: { drop(): Promise<void>; admin: unknown };
  kernel: unknown;
  app: { close(): Promise<void> };
  users: Record<string, { userId: string; subject: string }>;
  session: (name: string) => Promise<unknown>;
}

const webUp = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  h = await import("../../apps/web/test/acceptance/harness.ts");
  kh = await import("../../apps/web/test/acceptance/kernel-harness.ts");
  // Kernel + API on :4750 over a disposable database (same wiring as the web acceptance harness, own ports).
  const [{ buildApp }, kernelTesting] = await Promise.all([
    import("../../apps/api/src/index.ts"),
    import("../../packages/kernel/test/helpers/index.ts"),
  ]);
  const db = await kernelTesting.createTestDb();
  const org = await kernelTesting.seedOrg(db.admin, "perf02", { alice: "owner" });
  const kernel = kernelTesting.testKernel(db);
  await kernel.boot();
  kernel.outbox.start();
  const app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 50 });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  env = {
    db,
    kernel,
    app,
    users: org.users,
    session: (name: string) => kernelTesting.loginSession(kernel, org.users[name]!.subject),
  };
  // Web server: production build (dist .next-perf) unless PERF_WEB_MODE=dev (harness development only; never a verdict).
  if (await webUp()) throw new Error(`port ${PORT} is already serving; PERF02 needs its own server`);
  const dev = DRYRUN && process.env.PERF_WEB_MODE === "dev";
  if (!dev) {
    const built = existsSync(join(WEB_DIR, ".next-perf", "BUILD_ID"));
    if (!built || process.env.PERF_REBUILD === "1") {
      const b = spawnSync("pnpm", ["exec", "next", "build"], {
        cwd: WEB_DIR,
        encoding: "utf8",
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEARESIS_WEB_DIST: ".next-perf" },
      });
      if (b.status !== 0) {
        webBlocked = `next build failed (exit ${b.status}): ${(b.stdout + b.stderr)
          .split("\n")
          .filter((l) => /error/i.test(l))
          .slice(0, 3)
          .join(" | ")
          .slice(0, 400)}`;
        return;
      }
    }
  }
  web = spawn("pnpm", ["exec", "next", dev ? "dev" : "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NEARESIS_TEST_HOOKS: "1",
      NEARESIS_WEB_DIST: ".next-perf",
      NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}`,
      ...(dev ? {} : { NODE_ENV: "production" }),
    },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 120 && !(await webUp()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await webUp())) throw new Error("web server did not start");
  browser = await h.launch();
}, 900_000);
afterAll(async () => {
  await browser?.close();
  if (web?.pid) {
    try {
      process.kill(-web.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  await env?.app.close();
  await env?.db.drop();
}, 120_000);

async function heapAfterGc(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const m = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return m.metrics.find((x) => x.name === "JSHeapUsedSize")!.value;
}

it("PERF02: 50 panels render with bounded memory, responsive input and no long main-thread task", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF02", observed: "not executed", blocked: g.reason });
    return;
  }
  if (webBlocked) {
    observe({
      testId: "PERF02",
      observed: "not executed: the production web build could not be produced",
      blocked: webBlocked,
    });
    return;
  }
  const ref = reference();
  const th = ref.thresholds.PERF02!;
  const { loadScenario } = await import("../../apps/web/src/fixtures/scenarios.ts");
  const base = (loadScenario("baseline").document as { panels: Array<Record<string, unknown>> }).panels;
  const panels = Array.from({ length: PANELS }, (_, i) => {
    const p = base[i % base.length]!;
    const id = `00000000-0000-4000-8000-${(0x5000 + i).toString(16).padStart(12, "0")}`;
    return {
      ...p,
      panelId: id,
      title: `${String(p.title)} #${i}`,
      layout: { x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 },
    };
  });
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC) + JSON.stringify(panels));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF02 ${fixtureHash}\n`);
  if (g.ok) expect(ref.fixtures.PERF02).toBe(fixtureHash);

  const { workspaceId } = await kh.seedWorkspace(env as never, "alice", panels as never);
  const ctx = await kh.loggedIn(browser!, env as never, "alice");
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __longtasks: number[] };
    w.__longtasks = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__longtasks.push(e.duration))).observe({
      type: "longtask",
      buffered: true,
    });
  });
  const t0 = Date.now();
  await page.goto(`${h.BASE}/w/${workspaceId}?backend=kernel`);
  await page.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    null,
    { timeout: 60_000 },
  );
  await page.waitForFunction((n) => document.querySelectorAll("[data-panel-kind]").length >= n, PANELS, {
    timeout: 60_000,
  });
  // settle: data fetches and chart first frames finish (poll with a deadline, no fixed sleep)
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __settle?: { last: number; n: number } };
      const now = performance.now();
      const n = performance.getEntriesByType("resource").length;
      w.__settle ??= { last: now, n };
      if (n !== w.__settle.n) w.__settle = { last: now, n };
      return now - w.__settle.last > 1500;
    },
    null,
    { timeout: 120_000, polling: 250 },
  );
  const loadMs = Date.now() - t0;
  const states = await page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const e of document.querySelectorAll("[data-panel-kind]")) {
      const s = e.getAttribute("data-panel-state") ?? "none";
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  });
  const rendered = await page.evaluate(() => document.querySelectorAll("[data-panel-kind]").length);
  const heapLoaded = await heapAfterGc(page);

  // ---- 60 optimistic interactions, measured in-page: keydown dispatch -> grid style mutation
  const ids = panels.map((p) => p.panelId as string);
  const acks: number[] = [];
  let timeouts = 0;
  const rev = () =>
    page.evaluate(
      () => (window as unknown as { __nearesis: { doc: { revision: number } } }).__nearesis.doc.revision,
    );
  for (let i = 0; i < th.interactions!; i++) {
    const id = ids[Math.floor(i / 2) % ids.length]!;
    const key = i % 2 === 0 ? "ArrowDown" : "ArrowUp";
    const before = await rev();
    const ms = await page.evaluate(
      ([pid, k]) =>
        new Promise<number>((resolve) => {
          const el = document.querySelector(`[data-testid='panel-${pid}']`) as HTMLElement;
          const t = performance.now();
          const mo = new MutationObserver(() => {
            mo.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - t));
          });
          mo.observe(el, { attributes: true, attributeFilter: ["style"] });
          setTimeout(() => {
            mo.disconnect();
            resolve(-1);
          }, 3000);
          el.focus();
          el.dispatchEvent(
            new KeyboardEvent("keydown", { key: k, altKey: true, bubbles: true, cancelable: true }),
          );
        }),
      [id, key] as [string, string],
    );
    if (ms < 0) timeouts++;
    else acks.push(ms);
    // wait for the server-confirmed revision before the next move (optimistic ack is what is measured)
    await page
      .waitForFunction(
        (r) =>
          (window as unknown as { __nearesis: { doc: { revision: number } } }).__nearesis.doc.revision > r,
        before,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
  }
  const heapAfter = await heapAfterGc(page);
  const longTasks = await page.evaluate(() => [
    ...(window as unknown as { __longtasks: number[] }).__longtasks,
  ]);
  const mb = (n: number) => Math.round((n / 2 ** 20) * 10) / 10;
  const growthPct = Math.round(((heapAfter - heapLoaded) / heapLoaded) * 1000) / 10;
  const ack = stats(acks);
  const maxLong = Math.max(0, ...longTasks);

  expect(rendered).toBe(PANELS);
  expect(timeouts).toBe(0);
  expect(acks.length).toBe(th.interactions);
  if (DRYRUN) {
    process.stderr.write(
      `DRYRUN ` +
        JSON.stringify({
          rendered,
          states,
          loadMs,
          heap: [mb(heapLoaded), mb(heapAfter)],
          ack,
          longTasks: longTasks.length,
          maxLong,
        }),
    );
    return;
  }
  expect(mb(heapLoaded)).toBeLessThanOrEqual(th.maxHeapUsedMB!);
  expect(growthPct).toBeLessThanOrEqual(th.maxHeapGrowthDuringInteractionsPct!);
  expect(maxLong).toBeLessThanOrEqual(th.maxLongTaskMs!);
  expect(ack.p95).toBeLessThanOrEqual(th.inputAckP95Ms!);

  const buildId = readFileSync(`${h.WEB_DIR}.next-perf/BUILD_ID`, "utf8").trim();
  observe({
    testId: "PERF02",
    observed: `${rendered}/${PANELS} panels persisted through canvas.apply_patch and rendered (states ${JSON.stringify(states)}, load to settled ${loadMs} ms); JS heap after GC ${mb(heapLoaded)} MB (bound ${th.maxHeapUsedMB} MB), ${growthPct}% growth over ${acks.length} interactions (bound ${th.maxHeapGrowthDuringInteractionsPct}%); long tasks ${longTasks.length}, longest ${Math.round(maxLong)} ms (bound ${th.maxLongTaskMs} ms); optimistic input acknowledgement p50 ${ack.p50} ms, p95 ${ack.p95} ms, p99 ${ack.p99} ms (bound p95 ${th.inputAckP95Ms} ms), timeouts ${timeouts}`,
    fixtureHash,
    evidence: {
      environment: "reference",
      profile: g.ok ? g.fingerprint : null,
      referenceSha256: g.ok ? g.referenceSha256 : null,
      adrSha256: g.ok ? g.adrSha256 : null,
      conditions: conditions(),
      dataset: { id: "50-panel canvas (baseline scenario panels cycled)", sha256: fixtureHash },
      concurrency: "single browser page, sequential interactions",
      cacheState: "cold browser, warm server after seeding",
      browser: {
        chromium: browser!.version(),
        headless: true,
        viewport: FIXTURE_SPEC.viewport,
        build: "production",
        buildId,
      },
      heapMB: { afterLoad: mb(heapLoaded), afterInteractions: mb(heapAfter), growthPct },
      loadMs,
      panelStates: states,
      ackMs: ack,
      longTasksMs: {
        count: longTasks.length,
        max: Math.round(maxLong),
        all: longTasks.map((x) => Math.round(x)),
      },
    },
  });
}, 900_000);
