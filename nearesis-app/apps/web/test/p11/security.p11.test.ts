/**
 * P11 browser negative tests, part 1: hostile strings are inert, every page has zero content CSP violations,
 * anonymous users are blocked, and a member of another org cannot read org A's workspace through any page or BFF route.
 * Real kernel + API + web app. Not an acceptance ID: reported as browser-test results.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PanelSpec } from "@nearesis/contracts";
import { createWs, loginSession } from "@nearesis/kernel/testing";
import { HOSTILE, loadScenario } from "../../src/fixtures/scenarios.ts";
import {
  apiFor,
  BASE,
  type Env,
  loggedIn,
  ready,
  SHOTS,
  seedPanels,
  startEnv,
  hostilize,
  watch,
} from "./harness.ts";

let env: Env;
let hostileWs = "";
const GRAPH_PANEL: PanelSpec = {
  ...(loadScenario("baseline").document as { panels: PanelSpec[] }).panels[0]!,
  panelId: "00000000-0000-4000-8000-0000000f0001",
  kind: "evidenceGraph",
  title: HOSTILE[3]!,
  layout: { x: 0, y: 12, w: 12, h: 8 },
  dataBinding: { fields: ["graph"], units: {}, timezone: "UTC", completeness: "complete" },
  encoding: { interpolateGaps: false },
};
const KINDS = ["hypothesis", "observation", "claim", "source", "marker"] as const;

beforeAll(async () => {
  env = await startEnv();
  const hostilePanels = (loadScenario("hostile").document as { panels: PanelSpec[] }).panels;
  await seedPanels(env, "alice", env.wsA, [...hostilePanels, GRAPH_PANEL]);
  const a = await apiFor(env, "alice", env.wsA);
  for (const [i, h] of HOSTILE.entries()) await a.node(KINDS[i % KINDS.length]!, h.slice(0, 500));
  // A workspace whose objective (shown in the sidebar and settings) is hostile.
  const s = await loginSession(env.kernel, env.subjects.alice);
  hostileWs = (await createWs(env.kernel, s, HOSTILE[1]!)).workspaceId;
  env.buildCapsule();
}, 900_000);
afterAll(async () => {
  await env?.close();
}, 120_000);

const PAGES = (ws: string) => [
  { name: "workspace", path: `/w/${ws}`, flag: "__nearesis" },
  { name: "thesis", path: `/w/${ws}/thesis?source=fixture`, flag: "__thesis" },
  { name: "capsule", path: `/w/${ws}/capsule?id=cap-synthetic-p11`, flag: "__capsule" },
  { name: "evidence", path: `/w/${ws}/evidence`, flag: "__evidence" },
  { name: "history", path: `/w/${ws}/history`, flag: "__history" },
  { name: "settings", path: `/w/${ws}#settings`, flag: "__nearesis" },
  { name: "report", path: `/w/${ws}#report/00000000-0000-4000-8000-000000000099`, flag: "__nearesis" },
];

describe("XSS: hostile strings stay literal text", () => {
  it("canvas: panel titles, units, table cells, markdown notes, tooltips, evidence-graph labels, sidebar workspace names", async () => {
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(`${BASE}/w/${env.wsA}`);
    await ready(w.page);
    await w.page.waitForSelector("[data-testid^='panel-']");
    await w.page.waitForTimeout(1500);
    for (const el of await w.page.locator("[data-testid^='chart-']").all()) {
      const box = await el.boundingBox();
      if (!box) continue;
      for (let i = 1; i < 15; i++) {
        await w.page.mouse.move(box.x + (box.width * i) / 15, box.y + box.height / 2);
        await w.page.waitForTimeout(15);
      }
    }
    const dom = await w.page.evaluate((payloads) => {
      const text = document.body.textContent ?? "";
      const titles = [...document.querySelectorAll("[data-testid='panel-title']")].map((e) => e.textContent);
      return {
        titles,
        markdown: document.querySelector(".markdown")?.textContent ?? "",
        onAttrs: [...document.querySelectorAll("*")].flatMap((e) =>
          [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${e.tagName}.${a.name}`),
        ),
        jsHrefs: [...document.querySelectorAll("[href],[src]")]
          .map((e) => e.getAttribute("href") ?? e.getAttribute("src") ?? "")
          .filter((h) => /^\s*javascript:/i.test(h)),
        injectedElements: document.querySelectorAll(
          "main script:not([nonce]), .markdown iframe, .markdown img, .markdown svg, .markdown a[href^='javascript']",
        ).length,
        graphPanelText: text.includes(payloads[3]!),
      };
    }, HOSTILE);
    expect(await w.xss()).toBeUndefined();
    expect(w.errors).toEqual([]);
    expect(await w.csp()).toEqual([]);
    expect(dom.titles).toEqual(expect.arrayContaining([HOSTILE[0], HOSTILE[1], HOSTILE[3]]));
    expect(HOSTILE.every((h) => dom.markdown.includes(h.replace(/[‪-‮]/g, "")))).toBe(true);
    expect(dom.onAttrs).toEqual([]);
    expect(dom.jsHrefs).toEqual([]);
    expect(dom.injectedElements).toBe(0);
    // The evidence-graph panel title is literal text too.
    expect(dom.graphPanelText).toBe(true);
    await w.page.screenshot({ path: `${SHOTS}/xss-canvas.png` });
    await ctx.close();
  }, 240_000);

  it("evidence graph panel: hostile node labels render as literal text, nothing executes", async () => {
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(`${BASE}/w/${env.wsA}`);
    await ready(w.page);
    await w.page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    const labels = await w.page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node")].map((n) => n.textContent ?? ""),
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((l) => l.includes(HOSTILE[0]!) || l.includes("<script>"))).toBe(true);
    expect(
      await w.page
        .locator(".react-flow__node script, .react-flow__node img, .react-flow__node svg[onload]")
        .count(),
    ).toBe(0);
    expect(await w.xss()).toBeUndefined();
    expect(await w.csp()).toEqual([]);
    await ctx.close();
  }, 240_000);

  it("evidence explorer, thesis and capsule pages: hostile node labels, claim and result text stay literal", async () => {
    const ctx = await loggedIn(env, "alice");
    for (const p of PAGES(env.wsA).filter((x) => ["evidence", "thesis", "capsule"].includes(x.name))) {
      const w = await watch(ctx);
      // Real record from the real BFF, with every human-readable field replaced by a hostile payload.
      const mutate = async (route: import("playwright").Route) => {
        const real = await route.fetch();
        if (!real.ok()) return route.fulfill({ response: real });
        return route.fulfill({
          response: real,
          json: hostilize(await real.json(), HOSTILE),
        });
      };
      if (p.name === "thesis") await w.page.route("**/thesis/artifacts*", mutate);
      if (p.name === "capsule") await w.page.route("**/api/k/capsules/cap-*", mutate);
      await w.page.goto(`${BASE}${p.path}`);
      await ready(w.page, p.flag);
      await w.page.waitForTimeout(1200);
      const r = await w.page.evaluate(() => ({
        text: document.body.textContent ?? "",
        on: [...document.querySelectorAll("*")].flatMap((e) =>
          [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name),
        ),
        js: [...document.querySelectorAll("[href],[src]")]
          .map((e) => e.getAttribute("href") ?? e.getAttribute("src") ?? "")
          .filter((h) => /^\s*javascript:/i.test(h)),
        stray: [
          ...document.querySelectorAll(
            "body script:not([nonce]):not([src]):not([data-nextjs-dev-overlay]), iframe",
          ),
        ].map((e) => e.outerHTML.slice(0, 200)),
      }));
      expect(r.on, `${p.name} on* attributes`).toEqual([]);
      expect(r.js, `${p.name} javascript: urls`).toEqual([]);
      expect(r.stray, `${p.name} stray script/iframe`).toEqual([]);
      expect(await w.xss(), `${p.name} xss`).toBeUndefined();
      expect(w.errors, `${p.name} page errors`).toEqual([]);
      // Thesis results come from a published research run; when none is available the page (correctly) shows none.
      const thesisAvailable =
        p.name === "thesis" &&
        (await w.page.evaluate(
          () =>
            (window as unknown as { __thesis: { artifacts: { status: string } } }).__thesis.artifacts.status,
        )) === "available";
      if (p.name === "capsule" || thesisAvailable)
        expect(r.text, `${p.name} shows hostile text literally`).toContain("<script>");
      await w.page.close();
    }
    await ctx.close();
  }, 300_000);

  it("settings page and workspace switcher: a hostile workspace name is literal text", async () => {
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(`${BASE}/w/${hostileWs}#settings`);
    await ready(w.page);
    await w.page.getByTestId("settings-page").waitFor();
    const shown = await w.page
      .getByText(HOSTILE[1]!, { exact: false })
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    expect(shown, "workspace name shown as literal text").toBe(true);
    expect(await w.page.locator("img[src='x']").count()).toBe(0);
    expect(await w.xss()).toBeUndefined();
    expect(await w.csp()).toEqual([]);
    await ctx.close();
  }, 240_000);

  it("toast and error messages built from server text are literal (injected hostile 422 and network error bodies)", async () => {
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.route("**/api/k/workspaces/*/commands", async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ reasonCode: HOSTILE[0], message: HOSTILE[1] }),
      });
    });
    await w.page.goto(`${BASE}/w/${env.wsA}`);
    await ready(w.page);
    await w.page.waitForSelector("[data-testid^='panel-']");
    // Any edit command goes through apply(): use the keyboard move on the first panel.
    const first = w.page.locator("[data-testid^='panel-']").first();
    await first.focus();
    await w.page.keyboard.press("Alt+ArrowRight");
    const toast = w.page.getByTestId("toast");
    await toast.waitFor({ timeout: 15_000 });
    const t = (await toast.textContent()) ?? "";
    expect(t).toContain("<script>");
    expect(await toast.locator("script, img").count()).toBe(0);
    expect(await w.xss()).toBeUndefined();
    expect(await w.csp()).toEqual([]);
    await ctx.close();
  }, 240_000);
});

describe("CSP: zero content violations on every page", () => {
  it("workspace, thesis, capsule, evidence, history, settings and report", async () => {
    const ctx = await loggedIn(env, "alice");
    const table: Array<{ page: string; violations: unknown[]; errors: string[]; header: string | null }> = [];
    for (const p of PAGES(env.wsA)) {
      const w = await watch(ctx);
      const resp = await w.page.goto(`${BASE}${p.path}`);
      await ready(w.page, p.flag);
      await w.page.waitForTimeout(1500);
      table.push({
        page: p.name,
        violations: await w.csp(),
        errors: w.errors,
        header: (await resp?.headerValue("content-security-policy")) ?? null,
      });
      await w.page.close();
    }
    for (const r of table) {
      expect(r.violations, `${r.page} CSP violations`).toEqual([]);
      expect(r.errors, `${r.page} page errors`).toEqual([]);
      expect(r.header, `${r.page} has a CSP header`).toMatch(/script-src 'self' 'nonce-[^']+'/);
      expect(r.header).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    }
    await ctx.close();
  }, 300_000);
});

describe("protected navigation", () => {
  it("anonymous users get no workspace data from any page or BFF route", async () => {
    const anon = await env.browser.newContext();
    const paths = [
      `/api/k/workspaces/${env.wsA}`,
      `/api/k/workspaces/${env.wsA}/canvas`,
      `/api/k/workspaces/${env.wsA}/graph`,
      `/api/k/workspaces/${env.wsA}/events`,
      `/api/k/workspaces/${env.wsA}/runs`,
      `/api/k/workspaces`,
      `/api/session`,
      `/w/${env.wsA}/thesis/artifacts`,
      `/api/k/capsules`,
      `/api/k/capsules/cap-synthetic-p11`,
      `/api/k/workspaces/${env.wsA}/timeline`,
      `/api/k/workspaces/${env.wsA}/snapshots`,
      `/api/semantic/panel/${"0".repeat(64)}?workspace=${env.wsA}`,
      `/api/semantic/watermarks?workspace=${env.wsA}`,
    ];
    const got: Array<{ p: string; status: number; leak: boolean }> = [];
    for (const p of paths) {
      const r = await anon.request.get(`${BASE}${p}`, { failOnStatusCode: false, maxRedirects: 0 });
      const body = await r.text();
      got.push({
        p,
        status: r.status(),
        leak: body.includes("P11 workspace A") || body.includes("<script>") || body.includes("panels"),
      });
    }
    expect(got.filter((g) => g.status < 400 || g.leak)).toEqual([]);
    // The pages themselves must not render org A's content for an anonymous visitor.
    const w = await watch(anon);
    for (const p of PAGES(env.wsA)) {
      await w.page.goto(`${BASE}${p.path}`);
      await w.page.waitForTimeout(2500);
      const body = (await w.page.locator("body").textContent()) ?? "";
      expect(body, `${p.name}: anonymous page shows no workspace content`).not.toContain("P11 workspace A");
      expect(body, `${p.name}: anonymous page shows no hostile seed`).not.toContain("<script>window");
    }
    await anon.close();
  }, 300_000);

  it("user B (another org) gets the same 404 as for a nonexistent workspace, with no data, on every page and BFF route", async () => {
    const ctx = await loggedIn(env, "bob");
    const missing = "00000000-0000-4000-8000-00000000dead";
    const routes = (ws: string) => [
      `/api/k/workspaces/${ws}`,
      `/api/k/workspaces/${ws}/canvas`,
      `/api/k/workspaces/${ws}/graph`,
      `/api/k/workspaces/${ws}/runs`,
      `/api/k/workspaces/${ws}/sources`,
      `/api/k/workspaces/${ws}/markers`,
      `/api/k/workspaces/${ws}/notifications`,
      `/api/k/workspaces/${ws}/timeline`,
      `/api/k/workspaces/${ws}/snapshots`,
      `/api/k/workspaces/${ws}/branches`,
      `/api/k/workspaces/${ws}/graph/rechecks`,
      `/w/${ws}/thesis/artifacts`,
      `/w/${ws}/thesis/data`,
      `/api/semantic/watermarks?workspace=${ws}`,
      `/api/semantic/panel/${"a".repeat(64)}?workspace=${ws}`,
    ];
    const foreign = routes(env.wsA);
    const absent = routes(missing);
    const rows: Array<{
      route: string;
      status: number;
      sameAsMissing: boolean;
      leak: boolean;
      f?: string;
      m?: string;
    }> = [];
    for (let i = 0; i < foreign.length; i++) {
      const f = await ctx.request.get(`${BASE}${foreign[i]}`, { failOnStatusCode: false, maxRedirects: 0 });
      const m = await ctx.request.get(`${BASE}${absent[i]}`, { failOnStatusCode: false, maxRedirects: 0 });
      const norm = (t: string) => t.replace(/"traceId":"[^"]*"/, "");
      const fb = norm(await f.text());
      const mb = norm(await m.text());
      rows.push({
        route: foreign[i]!,
        status: f.status(),
        sameAsMissing:
          f.status() === m.status() && fb.replaceAll(env.wsA, "X") === mb.replaceAll(missing, "X"),
        leak: /P11 workspace A|HOSTILE|<script>|window\.__xss|"panels":\[\{/.test(fb),
        f: fb.slice(0, 160),
        m: mb.slice(0, 160),
      });
    }
    // Event stream and writes.
    const sse = await ctx.request.get(`${BASE}/api/k/workspaces/${env.wsA}/events`, {
      failOnStatusCode: false,
    });
    rows.push({ route: "events", status: sse.status(), sameAsMissing: sse.status() === 404, leak: false });
    const post = (ws: string) =>
      ctx.request.post(`${BASE}/api/k/workspaces/${ws}/commands`, {
        failOnStatusCode: false,
        headers: { "if-match": "1" },
        data: {
          apiVersion: "v1",
          commandId: "00000000-0000-4000-8000-0000000000c1",
          commandType: "canvas.apply_patch",
          payload: {},
          expectedVersion: 1,
        },
      });
    const cf = await post(env.wsA);
    const cm = await post(missing);
    const norm2 = (t: string) => t.replace(/"traceId":"[^"]*"/, "");
    rows.push({
      route: "commands (write to foreign workspace)",
      status: cf.status(),
      sameAsMissing: cf.status() === cm.status() && norm2(await cf.text()) === norm2(await cm.text()),
      leak: false,
      f: String(cf.status()),
      m: String(cm.status()),
    });
    // Reads must be the same 404 as a nonexistent workspace; the write must be indistinguishable from the nonexistent case.
    const bad = rows.filter((r) =>
      r.route.startsWith("commands")
        ? !r.sameAsMissing || r.status < 400 || r.status >= 500
        : r.status !== 404 || !r.sameAsMissing || r.leak,
    );
    expect(bad).toEqual([]);
    // Pages: user B opening A's URLs sees no org A data.
    const w = await watch(ctx);
    for (const p of PAGES(env.wsA)) {
      await w.page.goto(`${BASE}${p.path}`);
      await w.page.waitForTimeout(3000);
      const body = (await w.page.locator("body").textContent()) ?? "";
      expect(body, `${p.name}: user B page leaks org A data`).not.toMatch(
        /P11 workspace A|<script>window|Swaps lead/,
      );
      expect(await w.page.locator("[data-testid^='panel-']").count(), `${p.name}: no panels for B`).toBe(0);
    }
    await ctx.close();
  }, 300_000);

  it("forged workspace ids are rejected without reaching the kernel", async () => {
    const ctx = await loggedIn(env, "alice");
    const forged = [
      "../../v1/workspaces",
      "%2e%2e%2f%2e%2e%2fv1%2fworkspaces",
      "not-a-uuid",
      `${env.wsA}/../${env.wsB}`,
      `${env.wsA}%00`,
      "00000000-0000-4000-8000-00000000zzzz",
      `${env.wsA};DROP TABLE workspaces`,
      "A".repeat(2000),
      env.wsB,
    ];
    const rows: Array<{ id: string; status: number; leak: boolean }> = [];
    for (const id of forged) {
      for (const tpl of [
        (x: string) => `/api/k/workspaces/${x}/canvas`,
        (x: string) => `/api/k/workspaces/${x}/graph`,
        (x: string) => `/api/k/workspaces/${x}/timeline`,
        (x: string) => `/w/${x}/thesis/artifacts`,
        (x: string) => `/api/semantic/watermarks?workspace=${x}`,
      ]) {
        const r = await ctx.request.get(`${BASE}${tpl(id)}`, { failOnStatusCode: false, maxRedirects: 0 });
        const b = await r.text();
        rows.push({ id: id.slice(0, 40), status: r.status(), leak: /P11 workspace [AB]|"panels"/.test(b) });
      }
    }
    expect(rows.filter((r) => r.status < 400 || r.status >= 500 || r.leak)).toEqual([]);
    await ctx.close();
  }, 240_000);
});
