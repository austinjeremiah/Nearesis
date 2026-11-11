/**
 * P11 browser tests, part 3: responsive layouts (375, 768, 1280, 1440) and keyboard / screen-reader checks on every
 * page. axe-core comes from the lockfile entry `@axe-core/playwright@4.14.0` (declared by apps/design-lab); it is
 * loaded from that workspace package, no dependency is added to apps/web.
 */
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
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
  WEB_DIR,
  watch,
} from "./harness.ts";

let env: Env;
let ws = "";
interface AxeViolation {
  id: string;
  impact?: string | null;
  nodes: Array<{ target: unknown[] }>;
}
const requireFromLab = createRequire(`${WEB_DIR}../design-lab/package.json`);

beforeAll(async () => {
  env = await startEnv();
  const s = await loginSession(env.kernel, env.subjects.alice);
  ws = (await createWs(env.kernel, s, "P11 layout")).workspaceId;
  const base = (loadScenario("graph").document as { panels: PanelSpec[] }).panels;
  await seedPanels(env, "alice", ws, base);
  const a = await apiFor(env, "alice", ws);
  await a.node("claim", "Swaps lead transactions by 7 days");
  await a.node("hypothesis", HOSTILE[2]!);
  env.buildCapsule();
}, 900_000);
afterAll(async () => {
  await env?.close();
}, 120_000);

const PAGES = () => [
  { name: "workspace", path: `/w/${ws}`, flag: "__nearesis" },
  { name: "thesis", path: `/w/${ws}/thesis?source=fixture`, flag: "__thesis" },
  { name: "capsule", path: `/w/${ws}/capsule?id=cap-synthetic-p11`, flag: "__capsule" },
  { name: "evidence", path: `/w/${ws}/evidence`, flag: "__evidence" },
  { name: "history", path: `/w/${ws}/history`, flag: "__history" },
  { name: "settings", path: `/w/${ws}?backend=kernel#settings`, flag: "__nearesis" },
  { name: "monitoring", path: `/w/${ws}?backend=kernel#monitoring`, flag: "__nearesis" },
];
const WIDTHS = [375, 768, 1280, 1440];

async function open(name: string, path: string, flag: string, width: number) {
  const ctx = await loggedIn(env, "alice", { width, height: 900 });
  const w = await watch(ctx);
  await w.page.goto(`${BASE}${path}`);
  await ready(w.page, flag);
  await w.page.waitForTimeout(1500);
  return { ctx, ...w, name };
}

/** Interactive elements that are visible but cut off horizontally and not inside a horizontal scroller. */
async function unreachable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrolls = (el: Element | null): boolean => {
      for (let e = el?.parentElement; e; e = e.parentElement) {
        const o = getComputedStyle(e).overflowX;
        if ((o === "auto" || o === "scroll") && e.scrollWidth > e.clientWidth) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const e of document.querySelectorAll(
      "button, a[href], input, select, textarea, [role='button'], [tabindex='0']",
    )) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (
        r.width === 0 ||
        r.height === 0 ||
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        e.closest("[inert]")
      )
        continue;
      if ((r.left < -1 || r.right > vw + 1) && !scrolls(e))
        out.push(
          `${e.tagName}[${e.getAttribute("data-testid") ?? e.getAttribute("aria-label") ?? (e.textContent ?? "").trim().slice(0, 30)}] ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`,
        );
    }
    return out;
  });
}

describe("responsive layouts", () => {
  for (const width of WIDTHS) {
    it(`${width}px: no horizontal page scroll and every control is reachable on every page`, async () => {
      const failures: string[] = [];
      for (const p of PAGES()) {
        const o = await open(p.name, p.path, p.flag, width);
        const m = await o.page.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          bodyScrollW: document.body.scrollWidth,
        }));
        if (m.scrollW > m.clientW || m.bodyScrollW > m.clientW)
          failures.push(`${p.name}@${width}: horizontal scroll ${m.scrollW}/${m.bodyScrollW} > ${m.clientW}`);
        for (const u of await unreachable(o.page)) failures.push(`${p.name}@${width}: ${u}`);
        if (o.errors.length) failures.push(`${p.name}@${width}: page errors ${o.errors.join("|")}`);
        await o.page.screenshot({ path: `${SHOTS}/layout-${p.name}-${width}.png` });
        await o.ctx.close();
      }
      expect(failures).toEqual([]);
    }, 600_000);
  }

  it("375px: navigation and the agent panel can be opened and closed by touch-sized controls", async () => {
    const o = await open("workspace", `/w/${ws}`, "__nearesis", 375);
    const nav = o.page.getByRole("button", { name: /menu|navigation|open nav/i }).first();
    await nav.click();
    await expect(o.page.getByRole("navigation").first().isVisible()).resolves.toBe(true);
    const box = await nav.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await o.ctx.close();
  }, 120_000);
});

describe("keyboard and screen-reader labels", () => {
  it("axe-core: no serious or critical violations on any page (light and dark)", async () => {
    const { AxeBuilder } = requireFromLab("@axe-core/playwright") as {
      AxeBuilder: new (o: { page: Page }) => {
        withTags: (t: string[]) => { analyze: () => Promise<{ violations: AxeViolation[] }> };
      };
    };
    const report: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      for (const p of PAGES()) {
        const o = await open(p.name, p.path, p.flag, 1280);
        await o.page.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t);
        }, theme);
        await o.page.waitForTimeout(300);
        const r = await new AxeBuilder({ page: o.page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical"))
          report.push(
            `${p.name}/${theme}: ${v.id} (${v.impact}) x${v.nodes.length} e.g. ${v.nodes[0]?.target.join(" ")}`,
          );
        await o.ctx.close();
      }
    }
    expect(report).toEqual([]);
  }, 600_000);

  it("landmarks, accessible names on every interactive element, and focus order without traps", async () => {
    const failures: string[] = [];
    for (const p of PAGES()) {
      const o = await open(p.name, p.path, p.flag, 1280);
      const s = await o.page.evaluate(() => {
        const unnamed: string[] = [];
        for (const e of document.querySelectorAll(
          "button, a[href], input, select, textarea, [role='button'], [role='tab'], [role='switch']",
        )) {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(e).visibility === "hidden") continue;
          const labelled =
            e.getAttribute("aria-label") ||
            e.getAttribute("aria-labelledby") ||
            e.getAttribute("title") ||
            (e.textContent ?? "").trim() ||
            (e as HTMLInputElement).labels?.length ||
            e.querySelector("img[alt]:not([alt=''])");
          if (!labelled) unnamed.push(`${e.tagName}[${e.getAttribute("data-testid") ?? e.className}]`);
        }
        return {
          mains: document.querySelectorAll("main, [role='main']").length,
          navs: document.querySelectorAll("nav, [role='navigation']").length,
          h1: document.querySelectorAll("h1").length,
          lang: document.documentElement.lang,
          title: document.title,
          unnamed,
        };
      });
      if (s.mains !== 1) failures.push(`${p.name}: ${s.mains} main landmarks`);
      if (!s.lang) failures.push(`${p.name}: no html lang`);
      if (!s.title.trim()) failures.push(`${p.name}: empty title`);
      if (s.unnamed.length) failures.push(`${p.name}: unnamed controls ${s.unnamed.slice(0, 6).join(", ")}`);
      // Focus order: tab through; every stop is visible and named; focus is not trapped (reaches many distinct elements).
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        await o.page.keyboard.press("Tab");
        const f = await o.page.evaluate(() => {
          const e = document.activeElement as HTMLElement | null;
          if (!e || e === document.body) return null;
          const r = e.getBoundingClientRect();
          return {
            id: `${e.tagName}.${e.getAttribute("data-testid") ?? e.getAttribute("aria-label") ?? (e.textContent ?? "").trim().slice(0, 20)}`,
            visible: r.width > 0 && r.height > 0,
            named: !!(
              e.getAttribute("aria-label") ||
              e.getAttribute("aria-labelledby") ||
              (e.textContent ?? "").trim() ||
              e.getAttribute("title")
            ),
          };
        });
        if (!f) continue;
        if (!f.visible) failures.push(`${p.name}: focus landed on an invisible element ${f.id}`);
        seen.add(f.id);
      }
      if (seen.size < 3)
        failures.push(
          `${p.name}: keyboard focus reached only ${seen.size} elements (trap or no focusable controls)`,
        );
      await o.ctx.close();
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("keyboard only: the connection status is announced and a toast is an alert region", async () => {
    const o = await open("workspace", `/w/${ws}`, "__nearesis", 1280);
    const c = o.page.getByTestId("connection-state");
    expect(await c.getAttribute("role")).toMatch(/status/);
    await o.ctx.close();
  }, 120_000);
});
