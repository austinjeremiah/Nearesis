/**
 * C08 — Accessible keyboard operation. PASS: chart, marker and panel can be navigated without a mouse.
 * Production build + Chromium driven only by keyboard events (no mouse calls after page load).
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

type H = {
  __nearesis: {
    doc: { revision: number; markers: Array<{ anchor: unknown; panelId: string }>; selections: unknown[] };
    lastSelection?: unknown;
  };
};
const PANEL1 = "00000000-0000-4000-8000-000000000001";

describe("C08 keyboard operation", () => {
  it("navigates panels, charts and creates a marker with the keyboard only", async () => {
    const { page, cspViolations } = await openPage(browser, "/w/fixture?scenario=baseline");
    await page.waitForTimeout(500);
    const log: string[] = [];
    const focused = () =>
      page.evaluate(
        () =>
          (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ??
          document.activeElement?.tagName ??
          "",
      );

    // 1. Tab to the first panel (skipping header buttons) and move it with Alt+ArrowDown.
    let guard = 0;
    while ((await focused()) !== `panel-${PANEL1}` && guard++ < 40) await page.keyboard.press("Tab");
    expect(await focused()).toBe(`panel-${PANEL1}`);
    log.push(`panel focused after ${guard} Tab presses`);
    const rev0 = await page.evaluate(() => (window as unknown as H).__nearesis.doc.revision);
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForFunction((r) => (window as unknown as H).__nearesis.doc.revision === r + 1, rev0);
    const moved = await page
      .locator(`[data-testid='panel-${PANEL1}']`)
      .evaluate((e) => (e as HTMLElement).style.gridColumn);
    log.push(`Alt+ArrowRight moved panel: gridColumn=${moved}`);

    // 2. Tab into the chart; arrows move the data cursor, Shift+arrows extend, Enter selects.
    guard = 0;
    while ((await focused()) !== "chart-keyboard" && guard++ < 20) await page.keyboard.press("Tab");
    expect(await focused()).toBe("chart-keyboard");
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
    const cursor1 = await page
      .locator(`[data-testid='panel-${PANEL1}'] [data-testid='cursor-live']`)
      .textContent();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
    const cursor2 = await page
      .locator(`[data-testid='panel-${PANEL1}'] [data-testid='cursor-live']`)
      .textContent();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.selections.length === 1);
    const selection = await page.evaluate(() => (window as unknown as H).__nearesis.lastSelection);
    log.push(`cursor announced: "${cursor1}" then "${cursor2}"`);

    // 3. Shift+Tab back to "mark selection" and press Enter: a marker from the selection.
    guard = 0;
    while ((await focused()) !== "mark-range" && guard++ < 10) await page.keyboard.press("Shift+Tab");
    expect(await focused()).toBe("mark-range");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.markers.length === 1);
    const marker = await page.evaluate(() => (window as unknown as H).__nearesis.doc.markers[0]);

    // 4. Undo the marker with the keyboard shortcut.
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.markers.length === 0);
    log.push("Ctrl+Z removed the marker");

    expect(cursor1).toMatch(/2026-10-20T00:00: \d+ count/);
    expect(cursor2).toMatch(/range from 2026-10-20/);
    expect(selection).toMatchObject({
      panelId: PANEL1,
      seriesIds: ["intents.swap_count"],
      units: { "intents.swap_count": "count" },
    });
    expect(marker).toMatchObject({
      panelId: PANEL1,
      anchor: { kind: "time_range", start: "2026-10-20T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" },
    });
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("[data-panel-kind]")].map((p) => ({
        label: document.getElementById(p.getAttribute("aria-labelledby") ?? "")?.textContent,
        tabbable: (p as HTMLElement).tabIndex >= 0,
      })),
    );
    expect(names.every((n) => n.label && n.tabbable)).toBe(true);
    expect(await cspViolations()).toEqual([]);
    await page.close();

    observe({
      testId: "C08",
      observed: `keyboard only: Tab reached panel; Alt+Arrow moved it (doc revision ${rev0}->${rev0 + 1}); Tab into chart, Arrow moved data cursor with live announcement, Shift+Arrow extended range, Enter created typed selection 2026-10-20..2026-10-26; Shift+Tab to 'mark selection' + Enter created time_range marker; Ctrl+Z undid it; all ${names.length} panels tabbable with accessible names`,
      fixtureHash: hashCanonical(loadScenario("baseline")),
      evidence: {
        log,
        selection,
        marker,
        panels: names,
        mode: "fixture backend (in-browser apply via canvas-schema), SYNTHETIC",
      },
    });
  }, 120_000);
});
