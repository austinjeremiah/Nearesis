/**
 * Reported UI defects (final_prompt section 10), browser level against the production build:
 * workspace switcher click, settings page, report page, and heatmap / candlestick panels that must not render as lines.
 * Fixture mode (SYNTHETIC) for chart semantics; the report page is checked against stubbed BFF responses
 * (test-only, at the network layer) because a finished run needs the Temporal runtime; see the F1 handoff.
 */
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { BASE, launch, openPage, startWeb, stopWeb } from "../acceptance/harness.ts";

type Charts = Record<
  string,
  { getOption: () => { series: Array<{ type: string; data: unknown[] }> }; getWidth: () => number }
>;
const SHOTS = new URL("../shots/", import.meta.url).pathname;

let browser: Browser;
beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  await startWeb();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
}, 60_000);

describe("UI defects", () => {
  it("renders candlestick and heatmap panels with their own series types, nulls kept as unknown", async () => {
    const { page, consoleErrors } = await openPage(
      browser,
      "/w/00000000-0000-4000-8000-000000009002?scenario=visuals",
    );
    await page.waitForFunction(
      () =>
        Object.keys((window as unknown as { __nearesis: { charts: object } }).__nearesis.charts).length === 3,
    );
    const types = await page.evaluate(() => {
      const c = (window as unknown as { __nearesis: { charts: Charts } }).__nearesis.charts;
      return Object.fromEntries(
        Object.entries(c).map(([id, ch]) => {
          const s = ch.getOption().series[0]!;
          return [
            id,
            {
              type: s.type,
              n: s.data.length,
              nulls: s.data.filter((d) => (d as unknown[]).includes(null)).length,
            },
          ];
        }),
      );
    });
    const byType = Object.values(types)
      .map((t) => t.type)
      .sort();
    expect(byType).toEqual(["candlestick", "heatmap", "line"]);
    const candle = Object.values(types).find((t) => t.type === "candlestick")!;
    const heat = Object.values(types).find((t) => t.type === "heatmap")!;
    expect(candle.n).toBe(30);
    expect(heat.n).toBe(28);
    expect(heat.nulls).toBe(1); // the unknown cell is not turned into 0
    // The signed-out session probe answers 401 by design; anything else is a real error.
    expect(consoleErrors.filter((e) => !e.includes("401"))).toEqual([]);
    await page.screenshot({ path: `${SHOTS}heatmap-candlestick.png`, fullPage: false });
    await page.close();
  }, 120_000);

  it("workspace switcher opens a menu, lists workspaces and closes on Escape", async () => {
    const { page } = await openPage(browser, "/w/00000000-0000-4000-8000-000000009002?scenario=visuals");
    const btn = page.getByTestId("workspace-switch");
    expect(await btn.getAttribute("aria-expanded")).toBe("false");
    await btn.click();
    await page.getByTestId("workspace-menu").waitFor();
    expect(await btn.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("[data-testid^='workspace-option-']").count()).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-menu").waitFor({ state: "detached" });
    await page.close();
  }, 60_000);

  it("settings page opens from the sidebar, survives reload and returns to the canvas", async () => {
    const { page } = await openPage(browser, "/w/00000000-0000-4000-8000-000000009002?scenario=visuals");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByTestId("settings-page").waitFor();
    expect(await page.getByTestId("settings-source").innerText()).toContain("SYNTHETIC");
    const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByTestId("settings-theme").click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(theme0);
    await page.screenshot({ path: `${SHOTS}settings.png` });
    await page.reload();
    await page.getByTestId("settings-page").waitFor();
    expect(page.url()).toContain("#settings");
    await page.getByTestId("back-to-canvas").click();
    await page.locator("[data-testid^='panel-']").first().waitFor();
    await page.close();
  }, 60_000);

  it("report page renders a finished run from backend data only", async () => {
    const wsId = "00000000-0000-4000-8000-000000009002";
    const runId = "00000000-0000-4000-8000-0000000000aa";
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/api/k/workspaces/*/runs", (r) =>
      r.fulfill({
        json: {
          workspaceId: wsId,
          runs: [
            {
              runId,
              questionSummary: "Is swap activity rising?",
              state: "COMPLETE",
              terminal: true,
              startedAt: "2026-11-10T10:00:00.000Z",
              updatedAt: "2026-11-10T10:05:00.000Z",
            },
          ],
        },
      }),
    );
    await page.route(`**/api/k/runs/${runId}`, (r) =>
      r.fulfill({
        json: {
          runId,
          workspaceId: wsId,
          state: "COMPLETE",
          terminal: true,
          version: 3,
          failure: null,
          result: null,
          rootTask: null,
          children: [],
          evidenceLinks: [],
        },
      }),
    );
    await page.goto(`${BASE}/w/${wsId}?backend=kernel&scenario=visuals#report/${runId}`);
    await page.getByTestId("report-page").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("report-page").innerText()).toContain("Is swap activity rising?");
    await page.getByTestId("report-status").waitFor();
    expect(await page.getByTestId("report-status").innerText()).toContain("Complete");
    await page.close();
  }, 60_000);
});
