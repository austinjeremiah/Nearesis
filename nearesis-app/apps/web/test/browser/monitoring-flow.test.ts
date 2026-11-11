/**
 * P06 monitoring frontend, complete user flow in a real browser against the production build.
 * Data layer: the TEST adapter (`?monitoring=test-adapter`), because the kernel monitoring routes were not published when
 * this was written; the page labels it. The UI code path under test is the production one (same components, same
 * `MonitoringApi` port). Kernel-backed M06/M07 acceptance is separate and reports BLOCKED_DEPENDENCY until M1 publishes.
 */
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launch, openPage, startWeb, stopWeb } from "../acceptance/harness.ts";

const WS = "00000000-0000-4000-8000-000000009002";
const P_CANDLE = "00000000-0000-4000-8000-000000000001";
const P_HEAT = "00000000-0000-4000-8000-000000000002";
const P_SWAPS = "00000000-0000-4000-8000-000000000003";
const SHOTS = new URL("../shots/", import.meta.url).pathname;

type Adapter = {
  advanceTask(markerId: string, s: string): void;
  fire(ruleId: string, mode: "live" | "replay", outcome: string, wm: string): void;
  failNextLoad: number | null;
  incompatible: Map<string, string>;
};
type W = { __nearesis: { monitoring: Adapter; charts: Record<string, Chart> } };
type Chart = {
  getOption: () => {
    series: Array<{
      markArea?: { data: Array<Array<{ xAxis?: number }>> };
      markLine?: { data: Array<{ xAxis?: number }> };
    }>;
    dataZoom: Array<{ startValue?: number; endValue?: number }>;
  };
  convertToPixel: (f: { xAxisIndex: number }, v: number) => number;
  dispatchAction: (a: object) => void;
  resize: () => void;
  getWidth: () => number;
};

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

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met before deadline");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const markerTimes = (page: Page, panelId: string) =>
  page.evaluate((id) => {
    const c = (window as unknown as W).__nearesis.charts[id]!;
    const s = c.getOption().series[0]!;
    return {
      ranges: (s.markArea?.data ?? [])
        .map((a) => a.map((e) => e.xAxis))
        .filter((a) => a[0] !== undefined && a.length === 2),
      points: (s.markLine?.data ?? []).map((l) => l.xAxis).filter((x) => x !== undefined),
    };
  }, panelId);

describe("P06 monitoring flow", () => {
  it("gestures create markers that stay on data coordinates through zoom, resize and refresh", async () => {
    const { page } = await openPage(browser, `/w/${WS}?scenario=visuals&monitoring=test-adapter`);
    const panel = page.locator(`[data-testid='panel-${P_SWAPS}']`);
    // Range by keyboard: cursor + Shift range + Enter, then "monitor selection".
    await panel.locator("[data-testid='chart-keyboard']").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await until(
      async () =>
        (await page.evaluate(
          () =>
            (window as unknown as { __nearesis: { doc: { selections: unknown[] } } }).__nearesis.doc
              .selections.length,
        )) === 1,
    );
    await panel.getByTestId("monitor-selection").click();
    await panel.getByTestId("open-monitoring").waitFor();
    // Point by keyboard: cursor then P.
    await panel.locator("[data-testid='chart-keyboard']").focus();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("p");
    await until(async () =>
      (await panel.getByTestId("open-monitoring").innerText()).startsWith("2 monitor markers"),
    );

    const before = await markerTimes(page, P_SWAPS);
    // markArea also holds the shaded provider gap; the selection is the keyboard range 2026-10-03..10-08.
    expect(before.ranges).toContainEqual([Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 8)]);
    expect(before.points).toEqual([Date.UTC(2026, 9, 10)]);
    const px0 = await page.evaluate(
      (id) =>
        (window as unknown as W).__nearesis.charts[id]!.convertToPixel(
          { xAxisIndex: 0 },
          Date.UTC(2026, 9, 10),
        ),
      P_SWAPS,
    );

    // Zoom in on data space: the pixel position of the same instant moves, the marker's data coordinate does not.
    await page.evaluate(
      (id) =>
        (window as unknown as W).__nearesis.charts[id]!.dispatchAction({
          type: "dataZoom",
          startValue: Date.UTC(2026, 9, 8),
          endValue: Date.UTC(2026, 9, 20),
        }),
      P_SWAPS,
    );
    const px1 = await until(async () => {
      const v = await page.evaluate(
        (id) =>
          (window as unknown as W).__nearesis.charts[id]!.convertToPixel(
            { xAxisIndex: 0 },
            Date.UTC(2026, 9, 10),
          ),
        P_SWAPS,
      );
      return v !== px0 ? v : false;
    });
    expect(px1).not.toBe(px0);
    expect(await markerTimes(page, P_SWAPS)).toEqual(before);

    // Resize the viewport, then refresh the panel data: markers and the user's zoom survive.
    await page.setViewportSize({ width: 1100, height: 800 });
    await until(
      async () =>
        (await page.evaluate((id) => (window as unknown as W).__nearesis.charts[id]!.getWidth(), P_SWAPS)) <
        600,
    );
    expect(await markerTimes(page, P_SWAPS)).toEqual(before);
    await page.evaluate(
      (id) =>
        (window as unknown as { __nearesis: { refreshPanel: (i: string) => void } }).__nearesis.refreshPanel(
          id,
        ),
      P_SWAPS,
    );
    await until(async () => (await page.getByTestId("data-revision").innerText()).includes("2"));
    expect(await markerTimes(page, P_SWAPS)).toEqual(before);
    const zoom = await page.evaluate(
      (id) => (window as unknown as W).__nearesis.charts[id]!.getOption().dataZoom[0],
      P_SWAPS,
    );
    expect(zoom?.startValue).toBe(Date.UTC(2026, 9, 8));
    await page.close();
  }, 120_000);

  it("runs the whole monitoring workflow: inspect, assign, task status, rule, triggers, lens, notifications", async () => {
    const { page } = await openPage(browser, `/w/${WS}?scenario=visuals&monitoring=test-adapter`);
    const panel = page.locator(`[data-testid='panel-${P_SWAPS}']`);
    // A point marker through the click gesture.
    await panel.getByTestId("point-mode").click();
    const box = (await panel.locator(`[data-testid='chart-${P_SWAPS}']`).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await panel.getByTestId("open-monitoring").waitFor();

    await page.getByRole("button", { name: /^Monitoring/ }).click();
    await page.getByTestId("monitoring-view").waitFor();
    expect(await page.getByTestId("test-adapter-banner").innerText()).toContain("TEST ADAPTER");
    const row = page.locator("[data-testid^='marker-row-']").first();
    await row.click();
    const insp = page.getByTestId("marker-inspector");
    expect(await insp.innerText()).toContain("Point at 2026-");
    expect(await page.getByTestId("marker-query-hash").innerText()).toMatch(/^[0-9a-f]{64}$/);
    // A marker is created as DRAFT (the backend never starts an agent from an unsaved selection); activate it first.
    expect(await insp.getByTestId("marker-status").getAttribute("data-status")).toBe("DRAFT");
    expect(await page.getByTestId("assign-agent").count()).toBe(0);
    await page.getByTestId("transition-ACTIVE").click();
    await until(
      async () => (await page.getByTestId("marker-status").first().getAttribute("data-status")) === "ACTIVE",
    );

    // Assign an agent: backend moves it to INVESTIGATING and shows the task as PENDING (no invented progress).
    await insp.getByTestId("assign-agent").click();
    await until(
      async () =>
        (await page.getByTestId("marker-status").first().getAttribute("data-status")) === "INVESTIGATING",
    );
    expect(await page.getByTestId("task-status").getAttribute("data-status")).toBe("PENDING");
    const markerId = (await insp.getAttribute("data-marker-id"))!;
    await page.evaluate(
      (id) => (window as unknown as W).__nearesis.monitoring.advanceTask(id, "COMPLETE"),
      markerId,
    );
    await until(
      async () => (await page.getByTestId("task-status").getAttribute("data-status")) === "COMPLETE",
      8000,
    );
    await until(
      async () =>
        (await page.getByTestId("marker-status").first().getAttribute("data-status")) === "REVIEW_REQUIRED",
    );
    // Resolving needs a note; MONITORING does not.
    expect(await page.getByTestId("transition-RESOLVED").isDisabled()).toBe(true);
    await page
      .getByTestId("resolution-input")
      .fill("Explained by the 2026-10-27 private settlement transition.");
    await page.getByTestId("transition-RESOLVED").click();
    await until(
      async () =>
        (await page.getByTestId("marker-status").first().getAttribute("data-status")) === "RESOLVED",
    );
    expect(await page.locator("[data-testid^='transition-']").count()).toBe(0);
    await page.screenshot({ path: `${SHOTS}monitoring-marker-inspector.png` });

    // Rule editor: create (disabled), set frequency and cooldown, enable, edit.
    await page.getByTestId("tab-rules").click();
    await page.getByTestId("new-rule").click();
    await page.getByTestId("rule-name").fill("Swap count spike");
    await page.getByTestId("rule-source").fill("explorer.swaps");
    await page.getByTestId("rule-metric").fill("intents.swap_count");
    await page.getByTestId("rule-value").fill("200");
    await page.getByTestId("rule-frequency-value").fill("15");
    await page.getByTestId("rule-frequency-unit").selectOption("m");
    await page.getByTestId("rule-cooldown-value").fill("6");
    await page.getByTestId("rule-cooldown-unit").selectOption("h");
    expect(await page.getByTestId("rule-summary").innerText()).toContain("every 15 min");
    expect(await page.getByTestId("rule-summary").innerText()).toContain("cooldown 6 h");
    await page.getByTestId("rule-save").click();
    const ruleRow = page.locator("[data-testid^='rule-row-']").first();
    await ruleRow.waitFor();
    expect(await ruleRow.getAttribute("data-enabled")).toBe("false");
    await ruleRow.getByRole("switch").click();
    await until(async () => (await ruleRow.getAttribute("data-enabled")) === "true");
    const ruleId = (await ruleRow.getAttribute("data-testid"))!.replace("rule-row-", "");

    // Trigger history: a live firing and a replayed one. The replay row must say REPLAY and never LIVE.
    await page.evaluate(
      ([id]) => {
        const a = (window as unknown as W).__nearesis.monitoring;
        a.fire(id!, "live", "fired", "2026-11-10T12:00:00.000Z");
        a.fire(id!, "replay", "fired", "2026-10-27T12:00:00.000Z");
        a.fire(id!, "live", "cooldown", "2026-11-10T13:00:00.000Z");
      },
      [ruleId],
    );
    await page.getByTestId("tab-triggers").click();
    await until(async () => (await page.locator("[data-testid^='trigger-row-']").count()) === 3);
    const replayRow = page.locator("[data-testid^='trigger-row-'][data-mode='replay']");
    expect(await replayRow.count()).toBe(1);
    expect(await replayRow.getByTestId("mode-badge-replay").innerText()).toBe("REPLAY");
    expect(await replayRow.getByTestId("mode-badge-live").count()).toBe(0);
    expect(await page.locator("[data-testid^='trigger-row-'][data-mode='live']").count()).toBe(2);

    // Notifications: unread count, mode badge, mark read.
    await until(async () => (await page.getByTestId("unread-count").innerText()) === "2", 8000);
    await page.getByTestId("tab-notifications").click();
    expect(await page.locator("[data-testid^='notification-'][data-read='false']").count()).toBe(2);
    expect(await page.getByTestId("mode-badge-replay").count()).toBe(1);
    await page.locator("[data-testid^='notification-read-']").first().click();
    await until(async () => (await page.getByTestId("unread-count").innerText()) === "1");

    // Lens across charts: compatible panels filtered, incompatible one labelled with the reason.
    await page.evaluate(
      (id) =>
        (window as unknown as W).__nearesis.monitoring.incompatible.set(
          id,
          "categorical axis has no time range",
        ),
      P_HEAT,
    );
    await page.getByTestId("tab-lenses").click();
    await page.getByTestId("lens-name").fill("October window");
    for (const id of [P_CANDLE, P_HEAT, P_SWAPS]) await page.getByTestId(`lens-pick-${id}`).check();
    await page.getByTestId("lens-start").fill("2026-10-05T00:00");
    await page.getByTestId("lens-end").fill("2026-10-20T00:00");
    await page.getByTestId("lens-save").click();
    const lensRow = page.locator("[data-testid^='lens-row-']").first();
    await lensRow.waitFor();
    await lensRow.getByRole("button", { name: "Apply lens" }).click();
    await until(async () => (await page.getByTestId("lens-resolution").count()) === 1);
    expect(await page.getByTestId(`lens-panel-${P_HEAT}`).getAttribute("data-compatible")).toBe("false");
    await page.getByTestId("back-to-canvas").click();
    await page.locator(`[data-testid='panel-${P_SWAPS}']`).waitFor();
    for (const id of [P_CANDLE, P_SWAPS]) {
      const z = await until(async () => {
        const v = await page.evaluate(
          (cid) => (window as unknown as W).__nearesis.charts[cid]?.getOption().dataZoom[0],
          id,
        );
        return v?.startValue === Date.UTC(2026, 9, 5) ? v : false;
      });
      expect(z.endValue).toBe(Date.UTC(2026, 9, 20));
      expect(
        await page.locator(`[data-testid='panel-${id}'] [data-testid='lens-notice']`).innerText(),
      ).toContain("applied");
    }
    expect(
      await page.locator(`[data-testid='panel-${P_HEAT}'] [data-testid='lens-notice']`).innerText(),
    ).toContain("not applied");
    await page.screenshot({ path: `${SHOTS}monitoring-lens-canvas.png` });
    await page.close();
  }, 180_000);

  it("shows degraded-backend and degraded-source states, supports the keyboard and persists UI state across reload", async () => {
    const { page } = await openPage(browser, `/w/${WS}?scenario=visuals&monitoring=test-adapter#monitoring`);
    await page.getByTestId("monitoring-view").waitFor();
    // Keyboard: focus the selected tab, arrows move between tabs (roving tabindex).
    await page.getByTestId("tab-markers").focus();
    await page.keyboard.press("ArrowRight");
    await until(async () => (await page.getByTestId("tab-rules").getAttribute("aria-selected")) === "true");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tab-rules");
    await page.keyboard.press("End"); // the last tab (Delegation since the delegation-scope view was added)
    await until(
      async () => (await page.getByTestId("tab-delegation").getAttribute("aria-selected")) === "true",
    );
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // triggers
    await until(
      async () => (await page.getByTestId("tab-triggers").getAttribute("aria-selected")) === "true",
    );

    // Backend failure: banner appears, nothing is invented, and it clears when the backend answers again.
    await page.evaluate(() => ((window as unknown as W).__nearesis.monitoring.failNextLoad = 503));
    await page.getByTestId("monitoring-degraded").waitFor({ timeout: 8000 });
    expect(await page.getByTestId("monitoring-sync").innerText()).toContain("Backend unavailable");
    await page.getByTestId("monitoring-degraded").waitFor({ state: "detached", timeout: 8000 });

    // Persistence: tab survives reload.
    await page.reload();
    await page.getByTestId("monitoring-view").waitFor();
    expect(await page.getByTestId("tab-triggers").getAttribute("aria-selected")).toBe("true");
    // Fixture mode without the adapter flag has no monitoring backend and says so.
    const p2 = await openPage(browser, `/w/${WS}?scenario=visuals#monitoring`);
    await p2.page
      .getByTestId("monitoring-view")
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    expect(await p2.page.getByRole("button", { name: /^Monitoring/ }).count()).toBe(0);
    await page.close();
    await p2.page.close();
  }, 120_000);
});
