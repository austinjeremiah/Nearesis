/**
 * C11 — 4-op patch with one invalid op; repeated preview. PASS: nothing applied on invalid op; preview pure and stable;
 * valid patch one revision atomically. Real kernel (HTTP API via the web BFF) + Postgres row counters.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { APIRequestContext, Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const SRC = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const fresh = (n: number, base: PanelSpec): PanelSpec => ({
  ...base,
  panelId: `00000000-0000-4000-8000-0000000c11${n.toString().padStart(2, "0")}`,
  layout: { ...base.layout, y: 20 + n * 6 },
});
const VALID = [0, 1, 2, 3].map((i) => fresh(i, SRC[i]!));
const BAD = VALID.map((p, i) =>
  i === 2 ? { ...p, encoding: { ...p.encoding, y: ["intents.not_in_result"] } } : p,
);
const patch = (panels: PanelSpec[], expectedRevision: number) => ({
  schemaVersion: 1,
  type: "workspace.patch",
  operationId: crypto.randomUUID(),
  expectedRevision,
  operations: panels.map((panel) => ({ op: "addPanel", panel })),
});

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

async function counts(ws: string) {
  const q = async (sql: string) => Number((await env.db.admin.query(sql, [ws])).rows[0].n);
  return {
    revision: Number(
      (await env.db.admin.query("SELECT revision FROM canvas_documents WHERE workspace_id=$1", [ws])).rows[0]
        ?.revision ?? 0,
    ),
    panelSpecs: await q("SELECT count(*) n FROM panel_specs WHERE workspace_id=$1"),
    events: await q("SELECT count(*) n FROM workspace_events WHERE workspace_id=$1"),
    outbox: await q("SELECT count(*) n FROM outbox WHERE workspace_id=$1"),
    patches: await q("SELECT count(*) n FROM canvas_patches WHERE workspace_id=$1"),
    wsVersion: Number(
      (await env.db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0].version,
    ),
  };
}

async function command(req: APIRequestContext, ws: string, payload: unknown) {
  const v = (await (await req.get(`${BASE}/api/k/workspaces/${ws}`)).json()) as { version: number };
  const r = await req.post(`${BASE}/api/k/workspaces/${ws}/commands`, {
    headers: { "if-match": String(v.version) },
    data: {
      apiVersion: "v1",
      commandId: crypto.randomUUID(),
      commandType: "canvas.apply_patch",
      payload,
      expectedVersion: v.version,
    },
  });
  return { status: r.status(), body: (await r.json()) as Record<string, unknown> };
}

describe("C11 atomic multi-panel patch and pure preview", () => {
  it("rejects the whole bad patch, previews purely, applies the valid patch in one revision", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", [SRC[0]!]);
    const ctx = await loggedIn(browser, env, "alice");
    const req = ctx.request;
    const c0 = await counts(ws);

    // (a) preview the valid patch 3 times: identical hash, nothing written
    const validPatch = patch(VALID, c0.revision);
    const previews = [];
    for (let i = 0; i < 3; i++) {
      const r = await req.post(`${BASE}/api/k/workspaces/${ws}/canvas/preview`, { data: validPatch });
      expect(r.status()).toBe(200);
      previews.push(((await r.json()) as { previewHash: string }).previewHash);
    }
    const c1 = await counts(ws);
    expect(new Set(previews).size).toBe(1);
    expect(c1).toEqual(c0);

    // (b) the bad patch: 422 identifying operation 3 (index 2); 0 rows written
    const badPreview = await req.post(`${BASE}/api/k/workspaces/${ws}/canvas/preview`, {
      data: patch(BAD, c0.revision),
    });
    const badPreviewBody = (await badPreview.json()) as { operations: Array<{ index: number; ok: boolean }> };
    const bad = await command(req, ws, patch(BAD, c0.revision));
    const c2 = await counts(ws);
    expect(badPreview.status()).toBe(422);
    expect(badPreviewBody.operations.filter((o) => !o.ok).map((o) => o.index)).toEqual([2]);
    expect(bad.status).toBe(422);
    expect(bad.body.reasonCode).toBe("PATCH_REJECTED");
    const details = bad.body.details as Array<{ path: string }>;
    expect(details.length).toBeGreaterThan(0);
    expect(details.every((d) => d.path.startsWith("patch.operations.2"))).toBe(true);
    expect(c2).toEqual(c0);

    // (c) the valid patch: exactly 4 panels, one revision increment, 1 event, matching outbox row
    const ok = await command(req, ws, validPatch);
    const c3 = await counts(ws);
    expect(ok.status).toBe(200);
    expect(c3.revision).toBe(c0.revision + 1);
    expect(c3.panelSpecs - c0.panelSpecs).toBe(4);
    expect(c3.events - c0.events).toBe(1);
    expect(c3.outbox - c0.outbox).toBe(1);
    expect(c3.patches - c0.patches).toBe(1);
    const ev = (
      await env.db.admin.query(
        "SELECT event_type AS type FROM workspace_events WHERE workspace_id=$1 ORDER BY seq DESC LIMIT 1",
        [ws],
      )
    ).rows[0];
    expect(ev.type).toBe("canvas.patched");
    await ctx.close();

    observe({
      testId: "C11",
      observed: `3 previews -> 1 identical hash (${previews[0]!.slice(0, 12)}), revision/events/outbox/panels unchanged; bad 4-op patch -> preview 422 and apply 422 PATCH_REJECTED with all ${details.length} issue(s) on operation index 2, 0 rows written (revision ${c2.revision}); valid 4-op patch -> revision ${c0.revision}->${c3.revision}, +4 panel specs, +1 canvas.patched event, +1 outbox row, +1 patch log row`,
      fixtureHash: hashCanonical({ VALID, BAD }),
      evidence: {
        previews,
        before: c0,
        afterPreviews: c1,
        afterBad: c2,
        afterValid: c3,
        badDetails: details,
        badPreview: badPreviewBody,
      },
    });
  }, 300_000);
});
