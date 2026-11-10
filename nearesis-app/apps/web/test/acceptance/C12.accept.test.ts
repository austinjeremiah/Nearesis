/**
 * C12 — Markers through zoom/resize/reload/refresh. PASS: IDs and stored anchors unchanged; overlay maps to anchor
 * within 1 data unit (1 day); refresh bumps dataRevision only; threshold crossings recomputed from new data.
 * Real kernel persistence + production web build; overlay position read from the rendered ECharts scene graph.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { MarkerSpec, PanelSpec } from "@nearesis/contracts";
import { canonicalJson, hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const P1 = PANELS[0]!;
const DAY = 86_400_000;
type H = {
  __nearesis: {
    ready: boolean;
    doc: { revision: number; dataRevision: number; markers: MarkerSpec[] };
    charts: Record<string, unknown>;
    crossings: Record<string, string[]>;
    backend: { advanceVintage: () => void };
    refreshPanel: (id: string) => void;
  };
};

let env: KernelEnv;
let browser: Browser;
beforeAll(async () => {
  env = await startKernelEnv();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await env?.close();
});

/** Finds the rendered marker range polygon (ECharts markArea) and inverts its pixel edges to data space. */
async function overlay(page: Page) {
  return page.evaluate((id) => {
    type El = {
      type?: string;
      shape?: { points?: number[][] };
      style?: { fill?: string; opacity?: number };
      getComputedTransform?: () => number[] | null;
    };
    const chart = (window as unknown as H).__nearesis.charts[id] as {
      getZr: () => { storage: { getDisplayList: (u: boolean) => El[] } };
      convertFromPixel: (f: unknown, p: [number, number]) => [number, number];
    };
    const marker = getComputedStyle(document.documentElement)
      .getPropertyValue("--marker")
      .trim()
      .toLowerCase();
    const polys = chart
      .getZr()
      .storage.getDisplayList(true)
      .filter((e) => e.type === "polygon" && String(e.style?.fill ?? "").toLowerCase() === marker);
    return polys.map((p) => {
      const t = p.getComputedTransform?.() ?? null;
      const xs = (p.shape?.points ?? []).map((pt) => pt[0]! * (t?.[0] ?? 1) + (t?.[4] ?? 0));
      const ys = (p.shape?.points ?? []).map((pt) => pt[1]!);
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      return [
        chart.convertFromPixel({ gridIndex: 0 }, [Math.min(...xs), y])[0],
        chart.convertFromPixel({ gridIndex: 0 }, [Math.max(...xs), y])[0],
      ];
    });
  }, P1.panelId);
}

describe("C12 marker anchoring", () => {
  it("keeps marker IDs, anchors and overlay positions through view changes, reload and data refresh", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    const open = async () => {
      await page.goto(`${BASE}/w/${ws}?backend=kernel`);
      await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
      await page.waitForTimeout(400);
    };
    await open();
    // Gesture 1: keyboard range 2026-10-20..2026-10-27, then "mark selection".
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='chart-keyboard']`).focus();
    for (let k = 0; k < 20; k++) await page.keyboard.press("ArrowRight");
    for (let k = 0; k < 7; k++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.revision === 2);
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='mark-range']`).click();
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.markers.length === 1);
    // Gesture 2: threshold marker gt 100.
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='threshold-input']`).fill("100");
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='add-threshold']`).click();
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.markers.length === 2);
    const s = await env.session("alice");
    const stored0 = (await env.kernel.canvas.get(s, ws)).markers;
    const ids0 = stored0.map((m) => m.markerId).sort();
    const range = stored0.find((m) => m.anchor.kind === "time_range")!;
    const anchor = range.anchor as { start: string; end: string };
    expect(anchor).toEqual({
      kind: "time_range",
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-10-27T00:00:00.000Z",
    });

    const checks: Array<{ step: string; dStartDays: number; dEndDays: number }> = [];
    const check = async (step: string) => {
      await page.waitForTimeout(400);
      const o = await overlay(page);
      expect(o.length, step).toBe(1);
      const [a, b] = o[0]!;
      const row = {
        step,
        dStartDays: Math.abs(a! - Date.parse(anchor.start)) / DAY,
        dEndDays: Math.abs(b! - Date.parse(anchor.end)) / DAY,
      };
      checks.push(row);
      expect(row.dStartDays, step).toBeLessThanOrEqual(1);
      expect(row.dEndDays, step).toBeLessThanOrEqual(1);
    };
    await check("initial");
    const box = (await page.locator(`[data-testid='chart-${P1.panelId}']`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await check("zoom in");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await check("pan");
    await page.mouse.wheel(0, 900);
    await check("zoom out");
    await page.locator(`[data-testid='panel-${P1.panelId}']`).focus();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.revision === 5);
    await check("panel resize");
    await page.setViewportSize({ width: 1100, height: 800 });
    await check("window resize");
    await page.setViewportSize({ width: 1440, height: 900 });
    await open();
    await check("reload");

    // Data refresh: a new vintage (3 new days, 1 revised value).
    const before = await page.evaluate(() => ({
      ...(window as unknown as H).__nearesis.doc,
      crossings: { ...(window as unknown as H).__nearesis.crossings },
    }));
    await page.evaluate((id) => {
      const h = (window as unknown as H).__nearesis;
      h.backend.advanceVintage();
      h.refreshPanel(id);
    }, P1.panelId);
    await page.waitForFunction(
      (d) => (window as unknown as H).__nearesis.doc.dataRevision === d + 1,
      before.dataRevision,
    );
    await check("data refresh");
    const after = await page.evaluate(() => ({
      ...(window as unknown as H).__nearesis.doc,
      crossings: { ...(window as unknown as H).__nearesis.crossings },
    }));
    const stored1 = (await env.kernel.canvas.get(s, ws)).markers;
    await ctx.close();

    // Independent crossing computation from the served vintages.
    const thr = stored0.find((m) => m.anchor.kind === "threshold")!;
    const expected = async (v: number) => {
      const d = (await (await fetch(`${BASE}/api/data/${P1.queryRef.hash}?vintage=${v}`)).json()) as {
        chart: { rows: Array<[string, number | null]> };
      };
      const out: string[] = [];
      let prev: boolean | null = null;
      for (const [t, y] of d.chart.rows) {
        if (y === null) {
          prev = null;
          continue;
        }
        const above = y > 100;
        if (above && prev === false) out.push(t);
        prev = above;
      }
      return out;
    };
    const exp1 = await expected(1);
    const exp2 = await expected(2);

    expect(stored1.map((m) => m.markerId).sort()).toEqual(ids0); // (a)
    expect(canonicalJson(stored1)).toBe(canonicalJson(stored0)); // (b) byte-equal anchors
    expect(after.revision).toBe(before.revision); // (d) documentRevision untouched by refresh
    expect(after.dataRevision).toBe(before.dataRevision + 1);
    expect(before.crossings[thr.markerId]).toEqual(exp1); // (e) crossings from data
    expect(after.crossings[thr.markerId]).toEqual(exp2);

    observe({
      testId: "C12",
      observed: `time_range marker [2026-10-20, 2026-10-27] and threshold marker (gt 100) created by UI gestures; through zoom in/out, pan, panel resize, window resize, reload and data refresh the rendered overlay inverted to data space within ${Math.max(...checks.flatMap((c) => [c.dStartDays, c.dEndDays])).toFixed(3)} day of the anchor (<=1); IDs and persisted anchors byte-equal; refresh changed dataRevision ${before.dataRevision}->${after.dataRevision} with documentRevision ${after.revision} unchanged; threshold crossings recomputed from new data (${exp1.length} -> ${exp2.length}) with the stored condition unchanged`,
      fixtureHash: hashCanonical(PANELS),
      evidence: {
        stored0,
        stored1,
        checks,
        revisions: {
          before: [before.revision, before.dataRevision],
          after: [after.revision, after.dataRevision],
        },
        crossings: { v1: exp1, v2: exp2, ui1: before.crossings, ui2: after.crossings },
      },
    });
  }, 300_000);
});
