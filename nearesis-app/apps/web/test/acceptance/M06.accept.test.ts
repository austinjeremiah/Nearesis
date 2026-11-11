/**
 * M06 (web half, jointly with the backend half in apps/api): a historical replay event is shown with a visible REPLAY
 * badge and never as live. Real kernel, real scheduler path via the replay API, production web build.
 * PASS: the replayed trigger row and its notification carry REPLAY; 0 LIVE badges anywhere on the page; the backend rows
 * say mode=replay.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { launch } from "./harness.ts";
import { apiClient, openMonitoring } from "./monitoring-harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
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

describe("M06 replay badge", () => {
  it("shows REPLAY on the replayed trigger and notification and claims nothing live", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const api = await apiClient(env, "alice");
    const panel = PANELS[0]!;
    const markerId = randomUUID();
    const ruleId = randomUUID();
    const sourceId = `explorer.swaps.${randomUUID().slice(0, 8)}`;
    await api.command(ws, "marker.create", {
      panelId: panel.panelId,
      markerId,
      anchor: { kind: "time_point", at: "2026-10-03T00:00:00.000Z" },
    });
    await api.command(ws, "monitor.rule_create", {
      ruleId,
      name: "Swap count spike",
      markerId,
      sourceId,
      action: "notify",
      condition: { kind: "compare", metricId: "intents.swap_count", op: "gt", value: 100 },
    });
    const historical = "2026-10-03T00:00:00.000Z";
    const rep = await api.post(`/v1/workspaces/${ws}/monitors/replay`, {
      sourceId,
      events: [{ watermark: historical, values: { "intents.swap_count": 400 } }],
    });
    expect(rep.statusCode).toBe(200);

    const ctx = await loggedIn(browser, env, "alice");
    const page = await openMonitoring(browser, ctx, ws);
    await page.getByTestId("monitoring-view").waitFor();
    expect(await page.getByTestId("test-adapter-banner").count()).toBe(0); // production data path
    await page.getByTestId("tab-triggers").click();
    const row = page.locator("[data-testid^='trigger-row-'][data-mode='replay']");
    await row.first().waitFor({ timeout: 20_000 });
    const badge = await row.first().getByTestId("mode-badge-replay").innerText();
    const liveBadgesTriggers = await page.getByTestId("mode-badge-live").count();
    await page.getByTestId("tab-notifications").click();
    await page.locator("[data-testid^='notification-']").first().waitFor();
    const notifBadge = await page
      .locator("[data-testid^='notification-'] [data-testid='mode-badge-replay']")
      .first()
      .innerText();
    const liveBadgesAll = await page.getByTestId("mode-badge-live").count();
    const shotPath = new URL("../../test-results/m06-replay-badge.png", import.meta.url).pathname;
    await page.screenshot({ path: shotPath });

    const triggers = (
      await api.get<{ triggers: Array<{ mode: string; outcome: string; watermark: string }> }>(
        `/v1/workspaces/${ws}/monitors/triggers`,
      )
    ).triggers;
    await ctx.close();
    expect(badge).toBe("REPLAY");
    expect(notifBadge).toBe("REPLAY");
    expect(liveBadgesTriggers).toBe(0);
    expect(liveBadgesAll).toBe(0);
    expect(triggers).toEqual([
      expect.objectContaining({ mode: "replay", outcome: "fired", watermark: historical }),
    ]);

    observe({
      testId: "M06",
      observed: `replayed event at ${historical} produced 1 backend trigger (mode=replay, fired) and 1 notification; the page showed a REPLAY badge on the trigger row and on the notification and 0 LIVE badges (triggers tab and notifications tab)`,
      fixtureHash: hashCanonical(PANELS),
      evidence: {
        badge,
        notifBadge,
        liveBadgesTriggers,
        liveBadgesAll,
        triggers,
        screenshot: "apps/web/test-results/m06-replay-badge.png (untracked)",
      },
    });
  }, 300_000);
});
