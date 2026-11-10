/**
 * C06 — Undo/redo. PASS: reversible patch and event history preserved.
 * UI edits (move, resize, selection, range marker, threshold marker) through the real kernel; undo all, redo all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { CanvasDocument, PanelSpec } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const P1 = PANELS[0]!.panelId;
type H = { __nearesis: { ready: boolean; doc: { revision: number } } };

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

const content = (d: CanvasDocument) =>
  hashCanonical({ panels: d.panels, markers: d.markers, sel: d.activeSelections ?? [] });
const waitRev = (page: Page, r: number) =>
  page.waitForFunction((x) => (window as unknown as H).__nearesis.doc.revision === x, r);

describe("C06 undo/redo", () => {
  it("undoes and redoes every edit exactly through recorded inverse patches, keeping the full event history", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const s = await env.session("alice");
    const original = await env.kernel.canvas.get(s, ws);
    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel`);
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    let rev = original.documentRevision;

    const panel = page.locator(`[data-testid='panel-${P1}']`);
    await panel.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await waitRev(page, ++rev);
    await panel.focus();
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await waitRev(page, ++rev);
    await page.locator(`[data-testid='panel-${P1}'] [data-testid='chart-keyboard']`).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await waitRev(page, ++rev);
    await page.locator(`[data-testid='panel-${P1}'] [data-testid='mark-range']`).click();
    await waitRev(page, ++rev);
    await page.locator(`[data-testid='panel-${P1}'] [data-testid='add-threshold']`).click();
    await waitRev(page, ++rev);
    const edited = await env.kernel.canvas.get(s, ws);
    expect(edited.markers).toHaveLength(2);
    const edits = rev - original.documentRevision;

    for (let i = 0; i < edits; i++) {
      await page.locator("[data-testid='undo']").click();
      await waitRev(page, ++rev);
    }
    const undone = await env.kernel.canvas.get(s, ws);
    for (let i = 0; i < edits; i++) {
      await page.locator("[data-testid='redo']").click();
      await waitRev(page, ++rev);
    }
    const redone = await env.kernel.canvas.get(s, ws);
    const events = (
      await env.db.admin.query(
        "SELECT seq, event_type FROM workspace_events WHERE workspace_id=$1 ORDER BY seq",
        [ws],
      )
    ).rows as Array<{ seq: number; event_type: string }>;
    const patches = Number(
      (await env.db.admin.query("SELECT count(*) n FROM canvas_patches WHERE workspace_id=$1", [ws])).rows[0]
        .n,
    );
    await ctx.close();

    expect(content(undone)).toBe(content(original));
    expect(content(redone)).toBe(content(edited));
    expect(redone.documentRevision).toBe(original.documentRevision + 3 * edits);
    const canvasEvents = events.filter((e) => e.event_type === "canvas.patched");
    expect(canvasEvents).toHaveLength(1 + 3 * edits); // seed + edits + undos + redos: history only grows
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(patches).toBe(1 + 3 * edits);

    observe({
      testId: "C06",
      observed: `${edits} UI edits (move, resize, selection, range marker, threshold marker) then ${edits} undos restored content hash ${content(original).slice(0, 12)} exactly; ${edits} redos restored ${content(edited).slice(0, 12)} exactly; revision ${original.documentRevision}->${redone.documentRevision}; event journal grew to ${events.length} contiguous events (${canvasEvents.length} canvas.patched) and ${patches} patch-log rows; nothing deleted`,
      fixtureHash: hashCanonical(PANELS),
      evidence: {
        original: content(original),
        edited: content(edited),
        undone: content(undone),
        redone: content(redone),
        events: events.map((e) => `${e.seq}:${e.event_type}`),
        patches,
      },
    });
  }, 300_000);
});
