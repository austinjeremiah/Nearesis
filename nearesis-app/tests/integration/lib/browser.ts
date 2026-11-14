/**
 * Browser half of the G10 acceptance tests: the production build of apps/web (`next build` + `next start`, own dist
 * dir) in front of the API of the stack `openStack()` started, driven by Chromium through Playwright. The API of the
 * stack is bound to a loopback port so the web server reaches the very same kernel and database the flow ran on.
 * Nothing here replaces a component under test.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "../../../apps/web/node_modules/playwright/index.d.ts";
import { APP_ROOT } from "./research.ts";
import type { Stack } from "./stack.ts";

export type { Browser, BrowserContext, Page };

const WEB_DIR = join(APP_ROOT, "apps", "web");
const WEB_PORT = Number(process.env.NEARESIS_EBB_WEB_PORT ?? 3621);
const API_PORT = Number(process.env.NEARESIS_EBB_API_PORT ?? 4741);
const DIST = ".next-ebb";
export const BASE = `http://127.0.0.1:${WEB_PORT}`;

export interface BrowserSession {
  base: string;
  browser: Browser;
  /** A fresh context with the owner's session cookie (one dev login, shared; the API rate-limits dev login). */
  context(): Promise<BrowserContext>;
  /** Opens a page in a fresh context and waits for `window[flag].ready === true` (e.g. `__nearesis`, `__history`). */
  open(path: string, flag?: string): Promise<{ page: Page; context: BrowserContext; errors: string[] }>;
  close(): Promise<void>;
}

async function poll(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startBrowser(s: Stack): Promise<BrowserSession> {
  await s.api.app.listen({ host: "127.0.0.1", port: API_PORT });
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEARESIS_WEB_DIST: DIST,
    NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}`,
    NEARESIS_TEST_HOOKS: "1",
  };
  const b = spawnSync("pnpm", ["exec", "next", "build"], { cwd: WEB_DIR, env, encoding: "utf8" });
  if (b.status !== 0)
    throw new Error(`next build of apps/web failed: ${b.stdout.slice(-1500)}${b.stderr.slice(-1500)}`);
  const server: ChildProcess = spawn(
    "pnpm",
    ["exec", "next", "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"],
    { cwd: WEB_DIR, env: { ...env, NODE_ENV: "production" }, stdio: "ignore", detached: true },
  );
  const stopServer = () => {
    try {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  try {
    await poll(
      async () => (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })).ok,
      180_000,
      "the web server",
    );
    const { chromium } = createRequire(join(WEB_DIR, "package.json"))("playwright") as {
      chromium: { launch(o: { headless: boolean }): Promise<Browser> };
    };
    const browser = await chromium.launch({ headless: true });
    let state: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
    const context = async (): Promise<BrowserContext> => {
      if (state) return browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state });
      const first = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const r = await first.request.post(`${BASE}/api/dev/login`, {
        data: { subject: s.env.kernel!.subject },
      });
      if (r.status() >= 300) throw new Error(`dev login failed: ${r.status()}`);
      state = await first.storageState();
      return first;
    };
    return {
      base: BASE,
      browser,
      context,
      async open(path, flag) {
        const ctx = await context();
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
        await page.goto(`${BASE}${path}`);
        if (flag)
          await page.waitForFunction(
            (f) => (window as unknown as Record<string, { ready?: boolean } | undefined>)[f]?.ready === true,
            flag,
            { timeout: 120_000 },
          );
        return { page, context: ctx, errors };
      },
      async close() {
        await browser.close().catch(() => undefined);
        stopServer();
      },
    };
  } catch (e) {
    stopServer();
    throw e;
  }
}

/** The slice of the ECharts instance (exposed by the page as `__nearesis.charts`) this harvest reads. */
interface EChart {
  getZr(): {
    storage: { getDisplayList(update: boolean): Array<{ style?: { text?: unknown }; ignore?: boolean }> };
  };
  getDom(): HTMLElement;
  getModel(): {
    getComponent(
      n: string,
    ):
      | { coordinateSystem?: { getRect?: () => { x: number; y: number; width: number; height: number } } }
      | undefined;
  };
  getOption(): { series?: Array<{ data?: unknown[] }> };
  convertToPixel(f: { xAxisIndex: number }, v: unknown): number;
}

export interface PanelDump {
  panelId: string;
  queryHash: string;
  /** The ChartData and provenance the page itself fetched for this panel (same-origin, same session). */
  data: {
    chart: {
      columns: Array<{ name: string; unit: string | null }>;
      rows: Array<Array<string | number | null>>;
    };
    provenance?: Record<string, unknown>;
    [k: string]: unknown;
  };
}
export interface HoverItem {
  /** Where the text was read: the ECharts tooltip, a title/aria attribute, or a UI tooltip element. */
  kind: "chart-tooltip" | "title" | "aria-label" | "aria-description" | "ui-tooltip";
  panelId: string;
  text: string;
}
export interface HoverHarvest {
  panels: PanelDump[];
  items: HoverItem[];
  screenshot: string;
  errors: string[];
}

/**
 * Renders the workspace canvas in Chromium and harvests every hover text of every panel: it moves the mouse over each
 * data position of each chart (the ECharts tooltip is canvas richText, so it is read from the chart's own scene graph,
 * as the difference to the scene before the hover), and reads the title, aria-label and aria-description of every
 * element inside each panel plus any `role=tooltip` element a hover over a labelled control opens.
 */
export async function harvestCanvasHover(
  web: BrowserSession,
  workspaceId: string,
  screenshot: string,
): Promise<HoverHarvest> {
  const { page, context, errors } = await web.open(`/w/${workspaceId}`, "__nearesis");
  try {
    await page.waitForFunction(
      () =>
        Object.keys((window as unknown as { __nearesis: { charts: object } }).__nearesis.charts).length > 0,
      undefined,
      { timeout: 120_000 },
    );
    await page.waitForTimeout(1500);
    const ids = await page.evaluate(() =>
      Object.keys((window as unknown as { __nearesis: { charts: object } }).__nearesis.charts),
    );
    const items: HoverItem[] = [];
    const panels: PanelDump[] = await page.evaluate(
      async ([wsId, charted]) => {
        const cv = (await (await fetch(`/api/k/workspaces/${wsId}/canvas`)).json()) as {
          panels: Array<{ panelId: string; queryRef: { hash: string } }>;
        };
        const out = [];
        for (const p of cv.panels.filter((x) => charted!.includes(x.panelId))) {
          const r = await fetch(`/api/semantic/panel/${p.queryRef.hash}?workspace=${wsId}`);
          out.push({ panelId: p.panelId, queryHash: p.queryRef.hash, data: await r.json() });
        }
        return out;
      },
      [workspaceId, ids] as [string, string[]],
    );
    for (const { panelId } of panels) {
      // hover sweep: chart-tooltip text appears as new text nodes in the chart's scene graph
      const sceneTexts = (): Promise<string[]> =>
        page.evaluate((id) => {
          const c = (window as unknown as { __nearesis: { charts: Record<string, EChart> } }).__nearesis
            .charts[id];
          const list: Array<{ style?: { text?: unknown }; ignore?: boolean }> = c
            .getZr()
            .storage.getDisplayList(true);
          return list
            .filter((e) => e.style?.text !== undefined && !e.ignore)
            .map((e) => String(e.style!.text));
        }, panelId);
      const geometry = await page.evaluate((id) => {
        const c = (window as unknown as { __nearesis: { charts: Record<string, EChart> } }).__nearesis.charts[
          id
        ];
        const r = c.getDom().getBoundingClientRect();
        const grid = c.getModel().getComponent("grid")?.coordinateSystem?.getRect?.();
        const opt = c.getOption();
        const xs: number[] = [];
        const data: unknown[] = (opt.series?.[0]?.data as unknown[]) ?? [];
        for (const d of data) {
          const v = Array.isArray(d) ? d[0] : d;
          try {
            const px = c.convertToPixel({ xAxisIndex: 0 }, v);
            if (typeof px === "number" && Number.isFinite(px)) xs.push(px);
          } catch {
            /* category axis etc.: the sweep below covers it */
          }
        }
        return { left: r.left, top: r.top, w: r.width, h: r.height, grid: grid ?? null, xs };
      }, panelId);
      const base = await sceneTexts();
      const baseCount = new Map<string, number>();
      for (const t of base) baseCount.set(t, (baseCount.get(t) ?? 0) + 1);
      const y = geometry.grid
        ? geometry.top + geometry.grid.y + geometry.grid.height / 2
        : geometry.top + geometry.h / 2;
      const sweep = geometry.xs.length
        ? geometry.xs
        : Array.from({ length: 48 }, (_v, i) =>
            geometry.grid
              ? geometry.grid.x + (geometry.grid.width * (i + 0.5)) / 48
              : (geometry.w * (i + 0.5)) / 48,
          );
      const seen = new Set<string>();
      for (const x of sweep) {
        await page.mouse.move(geometry.left + x, y);
        await page.waitForTimeout(120);
        const left = new Map(baseCount);
        const added: string[] = [];
        for (const t of await sceneTexts()) {
          const n = left.get(t) ?? 0;
          if (n > 0) left.set(t, n - 1);
          else added.push(t);
        }
        const text = added
          .map((t) => t.trim())
          .filter(Boolean)
          .join("\n");
        if (text && !seen.has(text)) {
          seen.add(text);
          items.push({ kind: "chart-tooltip", panelId, text });
        }
      }
      await page.mouse.move(2, 2);
      // attributes and UI tooltips inside the panel
      const attrs = await page.evaluate((id) => {
        const root = document.querySelector(`[data-testid='panel-${id}']`);
        const out: Array<{ kind: string; text: string }> = [];
        if (!root) return out;
        for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
          for (const [a, kind] of [
            ["title", "title"],
            ["aria-label", "aria-label"],
            ["aria-description", "aria-description"],
          ] as const) {
            const v = el.getAttribute(a);
            if (v) out.push({ kind, text: v });
          }
        }
        return out;
      }, panelId);
      for (const a of attrs) items.push({ kind: a.kind as HoverItem["kind"], panelId, text: a.text });
      const labelled = page.locator(
        `[data-testid='panel-${panelId}'] [aria-label], [data-testid='panel-${panelId}'] [title]`,
      );
      const n = await labelled.count();
      for (let i = 0; i < n; i++) {
        const el = labelled.nth(i);
        if (!(await el.isVisible())) continue;
        await el.hover({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(150);
        for (const t of await page.locator("[role='tooltip']").allInnerTexts())
          if (t.trim()) items.push({ kind: "ui-tooltip", panelId, text: t.trim() });
      }
      await page.mouse.move(2, 2);
    }
    await page.screenshot({ path: screenshot, fullPage: true });
    return { panels, items, screenshot, errors };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export interface FocusInfo {
  tag: string;
  testId: string | null;
  text: string;
  /** Text of the nearest list item around the focused element, for controls that only differ by their row. */
  rowText: string;
  href: string | null;
}

export const focusInfo = (page: Page): Promise<FocusInfo> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? "",
      testId: el?.getAttribute("data-testid") ?? null,
      text: (el?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 300),
      rowText: (el?.closest("li, tr")?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 300),
      href: el?.getAttribute("href") ?? null,
    };
  });

/**
 * Moves the focus with the Tab key only (no pointer) until `match` accepts the focused element; returns the number of
 * key presses it took. Throws when the element is not reachable within `max` presses.
 */
export async function tabTo(page: Page, match: (f: FocusInfo) => boolean, max = 400): Promise<number> {
  for (let n = 0; n <= max; n++) {
    if (match(await focusInfo(page))) return n;
    await page.keyboard.press("Tab");
  }
  throw new Error(`not reachable by keyboard within ${max} Tab presses`);
}
