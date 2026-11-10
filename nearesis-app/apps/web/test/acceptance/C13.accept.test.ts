/**
 * C13 — Range selection by mouse and by keyboard. PASS: selection has query hash/version/interval/series/points/units/
 * watermark/renderer; persists; 0 agent spawns. Real kernel persistence + production web build.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import { type PanelSpec, Selection } from "@nearesis/contracts";
import { canonicalJson, hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const SC = loadScenario("baseline");
const PANELS = (SC.document as { panels: PanelSpec[] }).panels;
const P1 = PANELS[0]!;
type H = {
  __nearesis: {
    ready: boolean;
    agentSpawnCount: number;
    doc: { revision: number; selections: unknown[] };
    lastSelection: unknown;
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

describe("C13 selection context", () => {
  it("captures the full data context by mouse and keyboard, persists it, spawns nothing", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel`);
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    await page.waitForTimeout(500);
    const agentEvents = async () =>
      Number(
        (
          await env.db.admin.query(
            "SELECT count(*) n FROM workspace_events WHERE workspace_id=$1 AND event_type IN ('agent.spawned','task.started')",
            [ws],
          )
        ).rows[0].n,
      );
    const spawns0 = await agentEvents();

    // Mouse: enable range selection, drag across the middle of the chart.
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='select-mode']`).click();
    const box = (await page.locator(`[data-testid='chart-${P1.panelId}']`).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => (window as unknown as H).__nearesis.doc.selections.length === 1);
    const mouseSel = Selection.parse(
      await page.evaluate(() => (window as unknown as H).__nearesis.lastSelection),
    );

    // Keyboard (C08 path): cursor + Shift range + Enter replaces the selection.
    const rev = await page.evaluate(() => (window as unknown as H).__nearesis.doc.revision);
    await page.locator(`[data-testid='panel-${P1.panelId}'] [data-testid='chart-keyboard']`).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction((r) => (window as unknown as H).__nearesis.doc.revision === r + 1, rev);
    const keySel = Selection.parse(
      await page.evaluate(() => (window as unknown as H).__nearesis.lastSelection),
    );

    const s = await env.session("alice");
    const stored = (await env.kernel.canvas.get(s, ws)).activeSelections;
    await page.reload();
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    const afterReload = await page.evaluate(() => (window as unknown as H).__nearesis.doc.selections);
    const uiSpawns = await page.evaluate(() => (window as unknown as H).__nearesis.agentSpawnCount);
    const spawns1 = await agentEvents();
    await ctx.close();

    const data = SC.data[P1.queryRef.hash]!;
    for (const sel of [mouseSel, keySel]) {
      expect(sel.panelId).toBe(P1.panelId);
      expect(sel.queryHash).toBe(P1.queryRef.hash);
      expect(sel.semanticVersion).toBe(P1.queryRef.semanticVersion);
      expect(sel.seriesIds).toEqual(P1.encoding.y);
      expect(sel.units).toEqual({ "intents.swap_count": "count" });
      expect(sel.sourceWatermark).toBe(data.chart.sourceWatermark);
      expect(sel.rendererVersion).toMatch(/^echarts-6\.1\.0\/adapter-1\+schema-/);
      expect(Date.parse(sel.interval.start)).toBeLessThan(Date.parse(sel.interval.end));
      expect(sel.dataPointIds.length).toBeGreaterThan(0);
      expect(sel.dataPointIds.every((id) => id.startsWith("intents.swap_count@2026-"))).toBe(true);
    }
    expect(keySel.interval).toEqual({ start: "2026-10-03T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" });
    expect(keySel.dataPointIds).toHaveLength(6);
    expect(stored).toHaveLength(1);
    expect(canonicalJson(stored[0])).toBe(canonicalJson(keySel));
    expect(canonicalJson(afterReload)).toBe(canonicalJson(stored));
    expect(uiSpawns).toBe(0);
    expect(spawns1 - spawns0).toBe(0);

    observe({
      testId: "C13",
      observed: `mouse brush selection (${mouseSel.interval.start.slice(0, 10)}..${mouseSel.interval.end.slice(0, 10)}, ${mouseSel.dataPointIds.length} points) and keyboard selection (2026-10-03..2026-10-08, 6 points) both carry queryHash, semanticVersion, UTC interval, seriesIds, dataPointIds, units, sourceWatermark and rendererVersion equal to the panel's query/envelope; persisted by the kernel and byte-equal after reload; 0 agent spawns (UI counter and journal)`,
      fixtureHash: hashCanonical(PANELS),
      evidence: {
        mouseSel,
        keySel,
        stored,
        afterReload,
        agentSpawnsUi: uiSpawns,
        agentEventsDelta: spawns1 - spawns0,
      },
    });
  }, 300_000);
});
