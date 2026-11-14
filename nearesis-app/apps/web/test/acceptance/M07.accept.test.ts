/**
 * M07 (web): a lens across charts. PASS: a lens with a date range filters every compatible linked panel to exactly that
 * range (chart window equals the lens range) and a panel whose axis cannot take a date range is left unfiltered and
 * labelled "not applied". Real kernel lens commands and resolution, production web build.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { LensResolution, PanelSpec } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { launch } from "./harness.ts";
import { apiClient, openMonitoring } from "./monitoring-harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const TIME_PANELS = PANELS.filter((p) => p.kind === "timeSeries");
const BAR = PANELS.find((p) => p.kind === "bar")!;
type W = {
  __nearesis: {
    charts: Record<
      string,
      { getOption: () => { dataZoom: Array<{ startValue?: number; endValue?: number }> } }
    >;
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
}, 120_000);

describe("M07 lens across charts", () => {
  it("applies one date range to every compatible panel and labels the incompatible one", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const api = await apiClient(env, "alice");
    const ctx = await loggedIn(browser, env, "alice");
    const page = await openMonitoring(browser, ctx, ws);
    await page.getByTestId("monitoring-view").waitFor();
    await page.getByTestId("tab-lenses").click();
    await page.getByTestId("lens-name").fill("October window");
    for (const p of [...TIME_PANELS, BAR]) await page.getByTestId(`lens-pick-${p.panelId}`).check();
    await page.getByTestId("lens-start").fill("2026-10-05T00:00");
    await page.getByTestId("lens-end").fill("2026-10-20T00:00");
    await page.getByTestId("lens-save").click();
    const lensRow = page.locator("[data-testid^='lens-row-']").first();
    await lensRow.waitFor({ timeout: 20_000 });
    const lensId = (await lensRow.getAttribute("data-testid"))!.replace("lens-row-", "");
    await lensRow.getByRole("button", { name: "Apply lens" }).click();
    await page.getByTestId("lens-resolution").waitFor();
    const resolution = await api.get<LensResolution>(`/v1/workspaces/${ws}/lenses/${lensId}/resolution`);

    await page.getByTestId("back-to-canvas").click();
    const start = Date.UTC(2026, 9, 5);
    const end = Date.UTC(2026, 9, 20);
    const timeIds = new Set(TIME_PANELS.map((p) => p.panelId));
    for (const id of timeIds)
      await page.waitForFunction(
        ([cid, st]) =>
          (window as unknown as W).__nearesis.charts[cid as string]?.getOption().dataZoom[0]?.startValue ===
          st,
        [id, start] as const,
        { timeout: 20_000 },
      );
    const windows: Record<string, { startValue?: number; endValue?: number } | undefined> = {};
    const notices: Record<string, string> = {};
    for (const r of resolution.panels) {
      windows[r.panelId] = await page.evaluate(
        (id) => (window as unknown as W).__nearesis.charts[id]?.getOption().dataZoom?.[0],
        r.panelId,
      );
      notices[r.panelId] = await page
        .locator(`[data-testid='panel-${r.panelId}'] [data-testid='lens-notice']`)
        .innerText();
    }
    await page.screenshot({ path: new URL("../../test-results/m07-lens.png", import.meta.url).pathname });
    await ctx.close();

    const compatible = resolution.panels.filter((r) => r.compatible);
    expect(compatible.map((r) => r.panelId).sort()).toEqual(expect.arrayContaining([...timeIds].sort()));
    for (const id of timeIds) {
      expect(windows[id]?.startValue).toBe(start);
      expect(windows[id]?.endValue).toBe(end);
      expect(notices[id]).toContain("applied");
      expect(notices[id]).not.toContain("not applied");
    }
    // The category-axis bar chart cannot be filtered by a date range: it stays unfiltered and says so, whatever the
    // backend's metadata check answered (finding recorded in the F1 handoff).
    expect(windows[BAR.panelId]?.startValue).toBeUndefined();
    expect(notices[BAR.panelId]).toContain("not applied");

    observe({
      testId: "M07",
      observed: `lens 2026-10-05..2026-10-20 over ${resolution.panels.length} panels: backend marked ${compatible.length} compatible; every time-axis chart window equals the lens range exactly; the category-axis bar panel is labelled not applied and left unfiltered`,
      fixtureHash: hashCanonical(PANELS),
      evidence: { resolution, windows, notices, backendCompatibleCount: compatible.length },
    });
  }, 300_000);
});
