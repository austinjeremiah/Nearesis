/**
 * C07 — Zero rows. PASS: empty-state panel and limitations, no fake points.
 * Production build + Chromium; a query window whose result has 0 rows (SYNTHETIC "empty" scenario).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import { hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { launch, openPage, startWeb, stopWeb } from "./harness.ts";

let browser: Browser;
beforeAll(async () => {
  await startWeb();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
}, 120_000);

describe("C07 zero rows", () => {
  it("shows an empty state with limitations and plots nothing", async () => {
    const w = await openPage(browser, "/w/fixture?scenario=empty");
    await w.page.waitForTimeout(500);
    const r = await w.page.evaluate(() => {
      const h = (
        window as unknown as { __nearesis: { charts: Record<string, unknown>; instantiated: string[] } }
      ).__nearesis;
      const panel = document.querySelector("[data-panel-kind='timeSeries']");
      return {
        state: panel?.getAttribute("data-panel-state"),
        emptyText: panel?.querySelector("[data-testid='empty-state']")?.textContent ?? null,
        canvases: panel?.querySelectorAll("canvas").length ?? -1,
        chartInstances: Object.keys(h.charts).length,
        instantiated: h.instantiated,
        units: panel?.querySelector("[data-testid='units']")?.textContent,
        freshness: panel?.querySelector("[data-testid='freshness']")?.textContent,
        watermark: panel?.querySelector("[data-testid='watermark']")?.textContent,
        textAlt: panel?.querySelector("[data-testid='text-alternative']")?.textContent,
      };
    });
    expect(r.state).toBe("READY");
    expect(r.emptyText).toMatch(/No rows for this query window/);
    expect(r.emptyText).toMatch(/not a zero series/);
    expect(r.emptyText).toMatch(/Coverage: complete; gaps: 0; source watermark/);
    expect(r.canvases).toBe(0);
    expect(r.chartInstances).toBe(0);
    expect(r.instantiated).not.toContain("timeSeries");
    expect(r.units).toMatch(/swap_count=count/);
    expect(await w.cspViolations()).toEqual([]);
    await w.page.close();
    observe({
      testId: "C07",
      observed:
        "0-row result: panel READY with labelled empty state ('No rows for this query window … an empty result is not a zero series', coverage, gaps and watermark shown); 0 chart instances, 0 canvases, chart component not instantiated (no fake points); units and freshness still shown",
      fixtureHash: hashCanonical(loadScenario("empty")),
      evidence: r,
    });
  }, 120_000);
});
