/**
 * C09 — Malformed/unknown panel spec corpus (fx.canvas.malformed, 12 specs). PASS: all rejected 422 with revision
 * unchanged (preview and apply); a corrupted stored panel is isolated as an error panel while the others render; no
 * unregistered component is instantiated. Real kernel + production web build in Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { hashCanonical, REGISTERED_PANEL_KINDS } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const SRC = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const base = {
  ...SRC[0]!,
  panelId: "00000000-0000-4000-8000-0000000c0901",
  layout: { x: 0, y: 30, w: 6, h: 6 },
};
const MALFORMED: Array<{ name: string; spec: unknown }> = [
  { name: "unregistered kind sankey3d", spec: { ...base, kind: "sankey3d" } },
  { name: "renderer customReact", spec: { ...base, renderer: "customReact" } },
  { name: "missing queryRef", spec: (({ queryRef: _q, ...r }) => r)(base) },
  {
    name: "missing dataBinding.units",
    spec: { ...base, dataBinding: (({ units: _u, ...r }) => r)(base.dataBinding) },
  },
  { name: "schemaVersion 99", spec: { ...base, schemaVersion: 99 } },
  {
    name: "encoding field not in query result",
    spec: { ...base, encoding: { ...base.encoding, y: ["intents.fabricated_field"] } },
  },
  { name: "wrong types", spec: { ...base, title: 42, layout: { x: "0", y: 0, w: 6, h: 6 } } },
  {
    name: "extra unknown properties",
    spec: { ...base, extra: { a: 1 }, encoding: { ...base.encoding, color: "red" } },
  },
  { name: "1 MB title", spec: { ...base, title: "x".repeat(1_048_576) } },
  { name: "negative layout size", spec: { ...base, layout: { x: 0, y: 0, w: -6, h: 6 } } },
  { name: "duplicate panelId", spec: { ...base, panelId: SRC[0]!.panelId } },
  { name: "provenanceRequired false", spec: { ...base, provenanceRequired: false } },
];

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

describe("C09 malformed and unknown panel specs", () => {
  it("rejects every spec with 422, isolates a corrupted stored panel, instantiates only registered kinds", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", SRC);
    const ctx = await loggedIn(browser, env, "alice");
    const req = ctx.request;
    const rev = async () =>
      Number(
        (await env.db.admin.query("SELECT revision FROM canvas_documents WHERE workspace_id=$1", [ws]))
          .rows[0].revision,
      );
    const rev0 = await rev();
    const table: Array<{
      name: string;
      preview: number;
      apply: number;
      errorPaths: string[];
      revisionAfter: number;
    }> = [];
    for (const c of MALFORMED) {
      const p = {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: crypto.randomUUID(),
        expectedRevision: rev0,
        operations: [{ op: "addPanel", panel: c.spec }],
      };
      const pv = await req.post(`${BASE}/api/k/workspaces/${ws}/canvas/preview`, { data: p });
      const v = (await (await req.get(`${BASE}/api/k/workspaces/${ws}`)).json()) as { version: number };
      const ap = await req.post(`${BASE}/api/k/workspaces/${ws}/commands`, {
        headers: { "if-match": String(v.version) },
        data: {
          apiVersion: "v1",
          commandId: crypto.randomUUID(),
          commandType: "canvas.apply_patch",
          payload: p,
          expectedVersion: v.version,
        },
      });
      const body = (await ap.json()) as { details?: Array<{ path: string }> };
      table.push({
        name: c.name,
        preview: pv.status(),
        apply: ap.status(),
        errorPaths: (body.details ?? []).map((d) => d.path).slice(0, 3),
        revisionAfter: await rev(),
      });
    }
    const failures = table.filter(
      (r) => r.preview !== 422 || r.apply !== 422 || r.errorPaths.length === 0 || r.revisionAfter !== rev0,
    );
    expect(failures).toEqual([]);

    // (b) simulate storage corruption of one panel, then load the canvas in the browser.
    const victim = SRC[1]!.panelId;
    const col = (
      await env.db.admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='panel_specs' AND data_type IN ('jsonb','json')",
      )
    ).rows.map((r) => r.column_name as string);
    const specCol = col.includes("spec") ? "spec" : col[0]!;
    const upd = await env.db.admin.query(
      `UPDATE panel_specs SET ${specCol} = jsonb_set(jsonb_set(${specCol}::jsonb, '{kind}', '"sankey3d"'), '{renderer}', '"customReact"') WHERE workspace_id=$1 AND ${specCol}->>'panelId' = $2`,
      [ws, victim],
    );
    expect(upd.rowCount).toBe(1);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel`);
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );
    await page.waitForTimeout(800);
    const ui = await page.evaluate(() => ({
      invalid: [...document.querySelectorAll("[data-testid^='invalid-panel-']")].map((e) =>
        e.textContent?.slice(0, 200),
      ),
      rendered: [...document.querySelectorAll("[data-panel-kind]")].map(
        (e) => `${e.getAttribute("data-panel-kind")}:${e.getAttribute("data-panel-state")}`,
      ),
      instantiated: (window as unknown as { __nearesis: { instantiated: string[] } }).__nearesis.instantiated,
    }));
    await page.screenshot({
      path: new URL("../../test-results/C09-corrupted.png", import.meta.url).pathname,
    });
    expect(ui.invalid).toHaveLength(1);
    expect(ui.invalid[0]).toMatch(/Invalid panel spec/);
    expect(ui.rendered).toHaveLength(3);
    expect(ui.rendered.every((r) => r.endsWith(":READY"))).toBe(true);
    // (c) only registered kinds instantiated
    const kinds = ui.instantiated.map((k) => k.replace(/^graph:/, ""));
    expect(
      kinds.every(
        (k) =>
          (REGISTERED_PANEL_KINDS as readonly string[]).includes(k) ||
          ["hypothesis", "observation", "query", "model", "source", "marker", "agent"].includes(k),
      ),
    ).toBe(true);
    expect(kinds).not.toContain("sankey3d");
    await ctx.close();

    observe({
      testId: "C09",
      observed: `${table.length}/${table.length} malformed specs rejected 422 by preview and by kernel apply with error paths; document revision stayed ${rev0}; a corrupted stored panel (kind sankey3d + renderer customReact) loads as 1 labelled error panel while the other 3 panels render READY; instantiation log ${JSON.stringify(ui.instantiated)} contains only registered kinds`,
      fixtureHash: hashCanonical(MALFORMED.map((m) => m.name)),
      evidence: { table, ui, storedColumn: specCol },
    });
  }, 300_000);
});
