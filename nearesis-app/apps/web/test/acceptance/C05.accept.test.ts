/**
 * C05 — Concurrent panel edits from two tabs. PASS: one consistent version; conflict surfaced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { documentContentHash, hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
type H = {
  __nearesis: {
    ready: boolean;
    doc: { revision: number; layouts: Record<string, { layout: { x: number; y: number } }> };
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

describe("C05 concurrent panel edits", () => {
  it("accepts one edit, surfaces the conflict to the stale tab and converges on one version", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const ctx = await loggedIn(browser, env, "alice");
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];
    for (const p of [a, b]) {
      await p.goto(`${BASE}/w/${ws}?backend=kernel`);
      await p.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    }
    const P1 = PANELS[0]!.panelId;
    const P2 = PANELS[1]!.panelId;
    // Tab A moves panel 1; tab B (still at revision 1) moves panel 2 concurrently.
    await a.locator(`[data-testid='panel-${P1}']`).focus();
    await b.locator(`[data-testid='panel-${P2}']`).focus();
    await Promise.all([a.keyboard.press("Alt+ArrowRight"), b.keyboard.press("Alt+ArrowDown")]);
    await a.waitForTimeout(800);
    await b.waitForTimeout(800);
    const toasts = await Promise.all(
      [a, b].map((p) =>
        p
          .locator("[data-testid='toast']")
          .textContent()
          .catch(() => null),
      ),
    );
    const conflicted = toasts.filter((t) => t && /^Conflict: .*STALE/.test(t)).length;
    const s = await env.session("alice");
    const server = await env.kernel.canvas.get(s, ws);
    // Both tabs show the server's single version after the conflict (loser reloads, winner already there).
    await a.waitForFunction(
      (r) => (window as unknown as H).__nearesis.doc.revision === r,
      server.documentRevision,
    );
    await b.waitForFunction(
      (r) => (window as unknown as H).__nearesis.doc.revision === r,
      server.documentRevision,
    );
    const views = await Promise.all(
      [a, b].map((p) => p.evaluate(() => (window as unknown as H).__nearesis.doc.layouts)),
    );
    const serverLayouts = Object.fromEntries(
      server.panels.map((p) => [p.panelId, { layout: p.layout, queryHash: p.queryRef.hash }]),
    );
    const moved = [
      server.panels.find((p) => p.panelId === P1)!.layout.x !== PANELS[0]!.layout.x,
      server.panels.find((p) => p.panelId === P2)!.layout.y !== PANELS[1]!.layout.y,
    ];
    const rejected = Number(
      (await env.db.admin.query("SELECT count(*) n FROM canvas_patches WHERE workspace_id=$1", [ws])).rows[0]
        .n,
    );
    await ctx.close();

    expect(server.documentRevision).toBe(2);
    expect(moved.filter(Boolean)).toHaveLength(1); // exactly one edit applied, no merge of both, no lost write
    expect(conflicted).toBe(1);
    expect(views[0]).toEqual(serverLayouts);
    expect(views[1]).toEqual(serverLayouts);
    expect(rejected).toBe(2); // seed + one accepted edit

    observe({
      testId: "C05",
      observed: `two tabs edited concurrently at revision 1: kernel accepted exactly one (revision 2, ${moved[0] ? "panel 1 move" : "panel 2 move"}), the other got 409 surfaced as "${toasts.find((t) => t)?.slice(0, 80)}"; both tabs converged on the server version (identical layouts, content ${documentContentHash(server).slice(0, 12)})`,
      fixtureHash: hashCanonical(PANELS),
      evidence: { toasts, serverRevision: server.documentRevision, moved, views, serverLayouts },
    });
  }, 300_000);
});
