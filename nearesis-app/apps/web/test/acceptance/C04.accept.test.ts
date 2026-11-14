/**
 * C04 — Reload page. PASS: layout/queries/markers same persisted revision.
 * Real kernel (Postgres, canvas.apply_patch, GET canvas) + production web build in Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { documentContentHash, hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

type DocHook = {
  revision: number;
  layouts: Record<string, unknown>;
  markers: unknown[];
  selections: unknown[];
  panels: string[];
};
const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const P1 = PANELS[0]!.panelId;

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

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __nearesis: { doc: DocHook } }).__nearesis.doc;
    return {
      revision: d.revision,
      layouts: d.layouts,
      markers: d.markers,
      selections: d.selections,
      panels: d.panels,
      dom: [...document.querySelectorAll("[data-panel-kind]")].map((e) => ({
        id: e.getAttribute("data-testid"),
        col: (e as HTMLElement).style.gridColumn,
        row: (e as HTMLElement).style.gridRow,
      })),
    };
  });

describe("C04 reload persistence", () => {
  it("restores layout, queries and markers at the same persisted revision", async () => {
    const { workspaceId } = await seedWorkspace(env, "alice", PANELS);
    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    const url = `${BASE}/w/${workspaceId}?backend=kernel`;
    await page.goto(url);
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );

    // Edits through the UI: move a panel, select a range, mark it.
    await page.locator(`[data-testid='panel-${P1}']`).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForFunction(
      () => (window as unknown as { __nearesis: { doc: DocHook } }).__nearesis.doc.revision === 2,
    );
    await page.locator(`[data-testid='panel-${P1}'] [data-testid='chart-keyboard']`).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (window as unknown as { __nearesis: { doc: DocHook } }).__nearesis.doc.selections.length === 1,
    );
    await page.locator(`[data-testid='panel-${P1}'] [data-testid='mark-range']`).click();
    await page.waitForFunction(
      () => (window as unknown as { __nearesis: { doc: DocHook } }).__nearesis.doc.markers.length === 1,
    );
    const before = await snapshot(page);

    await page.reload();
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );
    await page.waitForTimeout(300);
    const after = await snapshot(page);

    const s = await env.session("alice");
    const persisted = await env.kernel.canvas.get(s, workspaceId);
    expect(after).toEqual(before);
    expect(after.revision).toBe(persisted.documentRevision);
    expect(after.revision).toBe(4);
    expect(after.markers).toEqual(persisted.markers);
    expect(
      Object.fromEntries(
        persisted.panels.map((p) => [p.panelId, { layout: p.layout, queryHash: p.queryRef.hash }]),
      ),
    ).toEqual(after.layouts);
    expect((after.layouts[P1] as { layout: { x: number } }).layout.x).toBe(PANELS[0]!.layout.x + 1);
    await ctx.close();

    observe({
      testId: "C04",
      observed: `kernel-persisted canvas: after move + selection + marker (revision ${before.revision}), page reload shows identical revision, ${after.panels.length} panel layouts and query hashes, ${after.markers.length} marker and ${after.selections.length} selection; equals kernel GET canvas (content hash ${documentContentHash(persisted).slice(0, 12)})`,
      fixtureHash: hashCanonical(PANELS),
      evidence: {
        workspaceId,
        before,
        after,
        persistedRevision: persisted.documentRevision,
        contentHash: documentContentHash(persisted),
      },
    });
  }, 300_000);
});
