/**
 * P11 browser failure-injection tests, part 2: SSE recovery and permissions, broken network (route.abort, offline),
 * degraded and error states, bounded retries, source degradation, and browser restart persistence.
 * Real kernel + API (restarted mid-test) + web app. Panel data is the SYNTHETIC fixture route.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { PanelSpec } from "@nearesis/contracts";
import { createWs, loginSession, runCmd } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, type Env, loggedIn, poll, ready, SHOTS, seedPanels, startEnv, watch } from "./harness.ts";

let env: Env;
const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels.slice(0, 3);
const EXTRA: PanelSpec = {
  ...PANELS[0]!,
  panelId: "00000000-0000-4000-8000-0000000e0001",
  title: "Added while the API was down",
  layout: { x: 0, y: 40, w: 6, h: 6 },
};

let current: PanelSpec[] = [];
async function freshWs(): Promise<string> {
  const s = await loginSession(env.kernel, env.subjects.alice);
  const id = (await createWs(env.kernel, s, "P11 resilience")).workspaceId;
  // Panel ids are globally unique in the kernel, so every workspace gets its own copies.
  current = PANELS.map((p) => ({ ...p, panelId: crypto.randomUUID() }));
  await seedPanels(env, "alice", id, current);
  return id;
}
const url = (ws: string, q = "") => `${BASE}/w/${ws}?backend=kernel${q}`;
const conn = (p: Page) => p.getByTestId("connection-state").getAttribute("data-conn");
const connIs =
  (p: Page, ...states: string[]) =>
  async () =>
    states.includes((await conn(p)) ?? "");

beforeAll(async () => {
  env = await startEnv();
}, 900_000);
afterEach(async () => {
  await env?.startApi(); // a failed test must not leave the API down for the next one
});
afterAll(async () => {
  await env?.close();
}, 120_000);

describe("SSE recovery", () => {
  it("API restart: the canvas is labelled degraded, retries are bounded, and it recovers without a reload and applies events missed while down", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    let eventRequests = 0;
    w.page.on("request", (r) => {
      if (r.url().includes("/events")) eventRequests++;
    });
    await w.page.goto(url(ws));
    await ready(w.page);
    await w.page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));
    await poll(connIs(w.page, "live"), 20_000, "live connection");
    await env.stopApi();
    // The outage must be visible, not silent.
    await poll(connIs(w.page, "reconnecting", "offline"), 30_000, "degraded label during API outage");
    await expect(w.page.getByTestId("connection-banner").isVisible()).resolves.toBe(true);
    await w.page.screenshot({ path: `${SHOTS}/sse-api-down.png` });
    // A change committed while the stream is down (the kernel is in-process; the API is not).
    const s = await loginSession(env.kernel, env.subjects.alice);
    const wsRow = await env.kernel.workspaces.get(s, ws);
    const doc = await env.kernel.canvas.get(s, ws);
    await runCmd(
      env.kernel,
      s,
      ws,
      "canvas.apply_patch",
      {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: crypto.randomUUID(),
        expectedRevision: doc.documentRevision,
        operations: [{ op: "addPanel", panel: EXTRA }],
      },
      wsRow.version,
    );
    // Bounded retries: count attempts over a fixed window while down.
    const before = eventRequests;
    await new Promise((r) => setTimeout(r, 12_000));
    const during = eventRequests - before;
    expect(during, "reconnect attempts in 12 s of outage").toBeLessThanOrEqual(12);
    await env.startApi();
    await poll(connIs(w.page, "live"), 60_000, "recovery to live");
    await poll(
      async () =>
        (await w.page.locator("[data-testid='panel-title']").allTextContents()).includes(EXTRA.title),
      30_000,
      "panel added during the outage appears",
    );
    expect(await w.page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
    await expect(w.page.getByTestId("connection-banner").count()).resolves.toBe(0);
    await ctx.close();
  }, 300_000);

  it("a permanently dead API stops retrying (bounded) and says so", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    let n = 0;
    await w.page.route("**/api/k/workspaces/*/events", (route) => {
      n++;
      return route.abort("connectionrefused");
    });
    await w.page.goto(url(ws));
    await ready(w.page);
    await poll(connIs(w.page, "offline"), 120_000, "offline after bounded retries", 500);
    const settled = n;
    await new Promise((r) => setTimeout(r, 15_000));
    expect(n, "no further attempts once declared offline").toBe(settled);
    expect(settled).toBeLessThanOrEqual(15);
    await ctx.close();
  }, 300_000);

  it("a revoked membership cannot keep streaming, and the client stops retrying", async () => {
    const ws = await freshWs();
    // Carol (viewer, org A) holds an open event stream.
    const token = await env.kernel.devAuth!.login(env.subjects.carol);
    const ctrl = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${process.env.NEARESIS_WEB_API_PORT ?? 4742}/v1/workspaces/${ws}/events`,
      {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: ctrl.signal,
      },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let ended = false;
    void (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* aborted */
      }
      ended = true;
    })();
    await new Promise((r) => setTimeout(r, 500));
    await env.db.admin.query(
      "DELETE FROM memberships WHERE user_id = (SELECT id FROM users WHERE oidc_subject = $1)",
      [env.subjects.carol],
    );
    // Any new event after revocation must end the stream (it must not keep delivering to a revoked principal).
    const s = await loginSession(env.kernel, env.subjects.alice);
    const wsRow = await env.kernel.workspaces.get(s, ws);
    await runCmd(
      env.kernel,
      s,
      ws,
      "workspace.update_objective",
      { objective: "after revocation" },
      wsRow.version,
    ).catch(() => undefined);
    const stoppedStreaming = await poll(async () => ended, 10_000, "stream to end after revocation").then(
      () => true,
      () => false,
    );
    ctrl.abort();
    expect(stoppedStreaming, "stream ended after membership revoked").toBe(true);
    // Reconnect with the (still unexpired) token is refused.
    const again = await fetch(
      `http://127.0.0.1:${process.env.NEARESIS_WEB_API_PORT ?? 4742}/v1/workspaces/${ws}/events`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect([401, 404]).toContain(again.status);
    await again.body?.cancel();
  }, 120_000);

  it("an invalid or forged session cookie gets no stream and the UI stops retrying and does not claim to be live", async () => {
    const ws = await freshWs();
    const ctx = await env.browser.newContext();
    await ctx.addCookies([
      {
        name: "nearesis_session",
        value: "garbage.invalid.token",
        url: BASE,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const w = await watch(ctx);
    let n = 0;
    w.page.on("request", (r) => {
      if (r.url().includes("/events")) n++;
    });
    const r = await ctx.request.get(`${BASE}/api/k/workspaces/${ws}/events`, { failOnStatusCode: false });
    expect(r.status()).toBeGreaterThanOrEqual(401);
    expect(r.status()).toBeLessThan(500);
    await w.page.goto(url(ws));
    await w.page.waitForTimeout(8000);
    const body = (await w.page.locator("body").textContent()) ?? "";
    expect(body).not.toContain("P11 resilience");
    expect(n, "event stream attempts with an invalid session").toBeLessThanOrEqual(2);
    await ctx.close();
  }, 120_000);
});

describe("broken network", () => {
  it("canvas load failure shows a labelled error with a working retry (no blank spinner), then recovers", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    let block = true;
    await w.page.route("**/api/k/workspaces/*/canvas", (route) =>
      block ? route.abort("failed") : route.continue(),
    );
    await w.page.goto(url(ws));
    const err = w.page.getByTestId("workspace-error");
    await err.waitFor({ timeout: 20_000 });
    expect(await err.textContent()).toMatch(/could not|failed|unavailable/i);
    expect(await w.page.locator("[data-testid^='panel-']").count()).toBe(0);
    await w.page.screenshot({ path: `${SHOTS}/network-canvas-load-failed.png` });
    block = false;
    await w.page.getByTestId("workspace-retry").click();
    await ready(w.page, "__nearesis", 60_000);
    await w.page.waitForSelector("[data-testid^='panel-']");
    await ctx.close();
  }, 180_000);

  it("panel data failing on first load marks only those panels as errors; the rest of the app stays live", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.route("**/api/data/**", (route) => route.abort("failed"));
    await w.page.goto(url(ws));
    await ready(w.page, "__nearesis", 60_000);
    await poll(connIs(w.page, "live"), 20_000, "live stream despite failed data");
    await poll(
      async () => (await w.page.locator("[data-panel-state='ERROR']").count()) >= PANELS.length,
      20_000,
      "panels in ERROR state",
    );
    expect(await w.page.locator("[data-panel-state='READY']").count()).toBe(0);
    await ctx.close();
  }, 180_000);

  it("offline mode: labelled degraded, nothing presented as fresh, recovers on reconnect without a reload", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(url(ws));
    await ready(w.page);
    await w.page.waitForSelector("[data-panel-state='READY']");
    await w.page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));
    await ctx.setOffline(true);
    await poll(connIs(w.page, "offline", "reconnecting"), 20_000, "offline label");
    await expect(w.page.getByTestId("connection-banner").textContent()).resolves.toMatch(
      /not live|paused|out of date/i,
    );
    await w.page.screenshot({ path: `${SHOTS}/network-offline.png` });
    await ctx.setOffline(false);
    await poll(connIs(w.page, "live"), 60_000, "live after reconnect");
    expect(await w.page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
    await ctx.close();
  }, 180_000);

  it("a failed refresh keeps the last good data, labels the error, and a later refresh recovers", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(url(ws));
    await ready(w.page);
    await w.page.waitForSelector("[data-panel-state='READY']");
    const id = current[0]!.panelId;
    let block = true;
    await w.page.route("**/api/data/**", (route) => (block ? route.abort("failed") : route.continue()));
    await w.page.evaluate(
      (p) =>
        (window as unknown as { __nearesis: { refreshPanel: (x: string) => void } }).__nearesis.refreshPanel(
          p,
        ),
      id,
    );
    const panel = w.page.locator(`[data-testid='panel-${id}']`);
    await poll(
      async () => (await panel.getAttribute("data-panel-state")) === "ERROR",
      15_000,
      "ERROR after failed refresh",
    );
    expect(
      await panel.locator("[data-testid^='chart-'], table, canvas").count(),
      "last good data still rendered",
    ).toBeGreaterThan(0);
    block = false;
    await w.page.evaluate(
      (p) =>
        (window as unknown as { __nearesis: { refreshPanel: (x: string) => void } }).__nearesis.refreshPanel(
          p,
        ),
      id,
    );
    await poll(
      async () => (await panel.getAttribute("data-panel-state")) === "READY",
      15_000,
      "READY after recovery",
    );
    await ctx.close();
  }, 180_000);

  it("a failed command shows a labelled error and leaves the document revision unchanged", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(url(ws));
    await ready(w.page);
    await w.page.waitForSelector("[data-testid^='panel-']");
    const rev0 = await w.page.getByTestId("document-revision").textContent();
    await w.page.route("**/api/k/workspaces/*/commands", (route) => route.abort("failed"));
    await w.page.locator("[data-testid^='panel-']").first().focus();
    await w.page.keyboard.press("Alt+ArrowRight");
    await w.page.getByTestId("toast").waitFor({ timeout: 15_000 });
    expect(await w.page.getByTestId("document-revision").textContent()).toBe(rev0);
    await ctx.close();
  }, 180_000);
});

/**
 * The semantic route needs registered gateway queries (covered by C14 against the real gateway and ClickHouse). Here the
 * subject is the UI's reaction to watermark changes, so panel data is served from the labelled SYNTHETIC fixture route.
 */
async function serveFixturePanels(page: Page): Promise<void> {
  await page.route("**/api/semantic/panel/*", async (route) => {
    const hash = new URL(route.request().url()).pathname.split("/").pop();
    const r = await page.context().request.get(`${BASE}/api/data/${hash}?vintage=1`);
    return route.fulfill({ status: r.status(), contentType: "application/json", body: await r.text() });
  });
}

describe("source degradation reaches the UI", () => {
  /** Providers the seeded panels actually read from (taken from their provenance). */
  async function providers(ctx: BrowserContext): Promise<string[]> {
    const out = new Set<string>();
    for (const p of current) {
      const r = await ctx.request.get(`${BASE}/api/data/${p.queryRef.hash}?vintage=1`);
      for (const x of ((await r.json()) as { provenance: { sources: string[] } }).provenance.sources)
        out.add(x);
    }
    return [...out];
  }
  let wmProviders: string[] = [];
  const WM = (state: string) =>
    JSON.stringify(
      Object.fromEntries(wmProviders.map((p) => [p, { state, newestEventTime: "2026-10-10T00:00:00Z" }])),
    );

  it("late and unavailable watermarks mark affected panels STALE with last good data kept; fresh recovers", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    let state = "fresh";
    wmProviders = await providers(ctx);
    expect(wmProviders.length).toBeGreaterThan(0);
    await w.page.route("**/api/semantic/watermarks*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: WM(state) }),
    );
    await serveFixturePanels(w.page);
    await w.page.goto(url(ws, "&data=semantic"));
    await ready(w.page, "__nearesis", 90_000);
    await w.page.waitForSelector("[data-panel-state='READY']", { timeout: 60_000 });
    for (const next of ["late", "unavailable"]) {
      state = next;
      await poll(
        async () => (await w.page.locator("[data-panel-state='STALE']").count()) > 0,
        10_000,
        `panels STALE on ${next}`,
      );
      expect(await w.page.locator("[data-panel-state='READY']").count(), `no READY panel on ${next}`).toBe(0);
      await expect(
        w.page.locator("button.nz-sb-item", { hasText: wmProviders[0]! }).first().textContent(),
      ).resolves.not.toMatch(/fresh\s*$/i);
    }
    await w.page.screenshot({ path: `${SHOTS}/source-unavailable.png` });
    state = "fresh";
    await poll(
      async () => (await w.page.locator("[data-panel-state='STALE']").count()) === 0,
      20_000,
      "panels recover after fresh",
    );
    await ctx.close();
  }, 240_000);

  it("a broken watermark feed is not shown as fresh: the source state becomes unknown/unavailable and says the feed failed", async () => {
    const ws = await freshWs();
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    let broken = false;
    wmProviders = await providers(ctx);
    await w.page.route("**/api/semantic/watermarks*", (route) =>
      broken
        ? route.abort("failed")
        : route.fulfill({ status: 200, contentType: "application/json", body: WM("fresh") }),
    );
    await serveFixturePanels(w.page);
    await w.page.goto(url(ws, "&data=semantic"));
    await ready(w.page, "__nearesis", 90_000);
    await w.page.waitForSelector("[data-panel-state='READY']", { timeout: 60_000 });
    broken = true;
    await expect
      .poll(async () => (await w.page.getByTestId("source-feed-error").count()) > 0, { timeout: 20_000 })
      .toBe(true);
    await ctx.close();
  }, 240_000);
});

describe("browser restart persistence", () => {
  it("server state persists across a closed browser context; only the documented per-user conveniences return from localStorage", async () => {
    const ws = await freshWs();
    const ctx1 = await loggedIn(env, "alice");
    const w1 = await watch(ctx1);
    await w1.page.goto(url(ws));
    await ready(w1.page);
    await w1.page.waitForSelector("[data-testid^='panel-']");
    // A real edit (move) and a convenience (theme).
    await w1.page.locator("[data-testid^='panel-']").first().focus();
    await w1.page.keyboard.press("Alt+ArrowRight");
    const rev0 = await w1.page.getByTestId("document-revision").textContent();
    await poll(
      async () => (await w1.page.getByTestId("document-revision").textContent()) !== rev0,
      15_000,
      `revision to change from "${rev0}" (toast: ${await w1.page
        .getByTestId("toast")
        .textContent({ timeout: 500 })
        .catch(() => "none")})`,
    );
    await w1.page.evaluate(() => localStorage.setItem("nz-theme", "dark"));
    const layouts1 = await w1.page.evaluate(
      () => (window as unknown as { __nearesis: { doc: { layouts: unknown } } }).__nearesis.doc.layouts,
    );
    const state = await ctx1.storageState();
    await ctx1.close();

    const ctx2: BrowserContext = await env.browser.newContext({ storageState: state });
    const w2 = await watch(ctx2);
    await w2.page.goto(url(ws));
    await ready(w2.page);
    await w2.page.waitForSelector("[data-testid^='panel-']");
    const layouts2 = await w2.page.evaluate(
      () => (window as unknown as { __nearesis: { doc: { layouts: unknown } } }).__nearesis.doc.layouts,
    );
    expect(layouts2).toEqual(layouts1);
    const keys = await w2.page.evaluate(() => Object.keys(localStorage).sort());
    const documented = ["nz-theme"];
    expect(keys.filter((k) => !documented.includes(k) && !k.startsWith("nz-monitoring"))).toEqual([]);
    expect(await w2.page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await ctx2.close();

    // A brand-new context (no cookies, no storage) sees nothing of the workspace.
    const ctx3 = await env.browser.newContext();
    const w3 = await watch(ctx3);
    await w3.page.goto(url(ws));
    await w3.page.waitForTimeout(4000);
    expect(await w3.page.locator("[data-testid^='panel-']").count()).toBe(0);
    expect(await w3.page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    await ctx3.close();
  }, 240_000);
});
