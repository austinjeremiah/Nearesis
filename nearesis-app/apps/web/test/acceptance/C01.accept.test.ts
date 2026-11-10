/**
 * C01 — Natural-language 4-panel task. PASS: a blank workspace receives "investigate NEAR Intents activity after the
 * private-settlement change" and yields four typed valid panels with query provenance, persisted by the kernel and
 * visible in the browser. Real path end to end: live OpenRouter model plans (typed plan only) -> near-thesis composer
 * -> semantic.discover@1 / canvas.preview@1 through the kernel ToolGateway (production plugin trust, leases) -> real
 * guarded gateway / Cube / ClickHouse -> kernel canvas.apply_patch via the agent runtime's KernelCanvasExecutor ->
 * production web build. The model is never mocked; without NEARESIS_ACCEPT_LIVE=1 the test records BLOCKED.
 * The directive's milestone demo (edit, save, reload, verify) is part of this evidence.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import { CanvasDocument, SemanticQuery } from "@nearesis/contracts";
import { createPg, loadQuery } from "@nearesis/analytics";
import { createProvider, openRouterOptionsFromEnv } from "@nearesis/inference";
import { KernelCanvasExecutor } from "@nearesis/agent-runtime";
import { buildManifest, composeCanvas, PLUGIN_ROOT, type ComposeResult } from "@nearesis/near-thesis";
import { hashCanonical, validatePanelSpec } from "@nearesis/canvas-schema";
import {
  createWs,
  execReq,
  giveLease,
  grant,
  pluginUp,
  TEST_KEY,
  TEST_PUBLISHER,
} from "@nearesis/kernel/testing";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, startKernelEnv } from "./kernel-harness.ts";

const PROMPT = "investigate NEAR Intents activity after the private-settlement change";
const MAX_ATTEMPTS = 3;
const live = process.env.NEARESIS_ACCEPT_LIVE === "1";

type H = {
  __nearesis: {
    ready: boolean;
    doc: { revision: number; layouts: Record<string, { layout: Layout; queryHash: string }> };
  };
};
type Layout = { x: number; y: number; w: number; h: number };

let env: KernelEnv | undefined;
let browser: Browser | undefined;
beforeAll(async () => {
  if (!live) return;
  env = await startKernelEnv({ alice: "owner" }, { pluginRoot: PLUGIN_ROOT });
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await env?.close();
}, 120_000);

describe("C01 natural-language request to four provenance-backed panels (live model)", () => {
  it("composes, persists, renders, and survives an edit, save and reload", async () => {
    if (!live) {
      observe({
        testId: "C01",
        observed: "NEARESIS_ACCEPT_LIVE != 1: C01 requires the live OpenRouter provider (run with --live)",
        fixtureHash: hashCanonical(PROMPT),
        blocked: "live provider not enabled",
      });
      return;
    }
    const e = env!;
    const s = await e.session("alice");
    const created = await createWs(e.kernel, s, "C01 blank workspace");
    const ws = created.workspaceId;
    let version = created.version;
    await e.kernel.plugins.install(
      s.principal.actorId,
      buildManifest({ publisher: TEST_PUBLISHER, privateKey: TEST_KEY.privateKey }),
    );
    await e.kernel.plugins.enable(s.principal.actorId, "near-thesis");
    version = await pluginUp(e.kernel, s, ws, version, "near-thesis");
    for (const [cap, res, action] of [
      ["semantic.discover@1", "semantic", "discover"],
      ["semantic.query@1", "semantic", "query"],
      ["canvas.preview@1", "canvas", "preview"],
    ] as const)
      await giveLease(e.kernel, s, ws, cap, [grant({ resource: res, action })]);
    const blank = await e.kernel.canvas.get(s, ws);
    expect(blank.panels).toHaveLength(0);

    const opts = openRouterOptionsFromEnv();
    const provider = createProvider({ mode: "openrouter" });
    const model = opts.primaryModel!;
    const ledger = (
      provider as unknown as { spend: { spentUsd(): Promise<number>; entries(): Promise<unknown[]> } }
    ).spend;
    const spentBefore = await ledger.spentUsd();
    const entriesBefore = (await ledger.entries()).length;

    const invoke = async (capability: string, input: unknown) => {
      const r = await e.kernel.gateway.invoke(
        s.principal,
        execReq(s, ws, capability, input, { deadlineMs: 90_000 }),
      );
      if (r.state !== "ok") throw new Error(`${capability}: ${r.state} ${r.reasonCode ?? ""}`);
      return r.payload;
    };
    // Bounded: the composer re-asks (with a new idempotency key) when the plan is rejected or not four panels.
    const attempts: Array<{
      status: string;
      panels: number;
      issues: unknown;
      modelRequestId: string | null;
    }> = [];
    let res: ComposeResult | null = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = await composeCanvas({
        prompt: PROMPT,
        provider,
        model,
        invoke,
        expectedRevision: 0,
        idempotencyKey: `c01-${randomUUID()}`,
      });
      attempts.push({
        status: r.status,
        panels: r.patch?.operations.length ?? 0,
        issues: r.issues,
        modelRequestId: r.modelRequestId,
      });
      res = r;
      if (r.status === "ok" && r.patch?.operations.length === 4) break;
    }
    const spentAfter = await ledger.spentUsd();
    expect(res!.status, JSON.stringify(attempts)).toBe("ok");
    expect(res!.patch!.operations).toHaveLength(4);

    // Persist through the kernel command as the composing agent acting for the owner.
    const exec = new KernelCanvasExecutor(e.kernel);
    const agentSession = exec.sessionFor({
      tenantId: s.principal.orgId,
      runId: randomUUID(),
      agentActorId: randomUUID(),
      requester: { userId: s.userId, role: "owner" } as never,
    });
    await exec.apply(agentSession, ws, res!.patch!);

    // Persisted: four typed valid panels, each with a resolvable query record (provenance).
    const doc = CanvasDocument.parse(await e.kernel.canvas.get(s, ws));
    expect(doc.panels).toHaveLength(4);
    const pg = createPg();
    const provenance = [];
    for (const p of doc.panels) {
      expect(validatePanelSpec(p).ok).toBe(true);
      expect(p.provenanceRequired).toBe(true);
      expect(p.queryRef.hash).toMatch(/^[0-9a-f]{64}$/);
      const saved = await loadQuery(pg, p.queryRef.hash);
      expect(saved, `query ${p.queryRef.hash} recorded`).toBeTruthy();
      expect(SemanticQuery.safeParse(saved!.ast).success).toBe(true);
      expect(saved!.semanticVersion).toBe(p.queryRef.semanticVersion);
      provenance.push({
        panelId: p.panelId,
        kind: p.kind,
        title: p.title,
        queryHash: p.queryRef.hash,
        semanticVersion: p.queryRef.semanticVersion,
        measures: (saved!.ast as { measures: string[] }).measures,
        units: p.dataBinding.units,
        completeness: p.dataBinding.completeness,
      });
    }
    expect(new Set(provenance.map((p) => p.queryHash)).size).toBe(4);
    const rowCount = Number(
      (
        await e.db.admin.query(
          "SELECT count(*) n FROM panel_specs WHERE workspace_id=$1 AND removed_at IS NULL",
          [ws],
        )
      ).rows[0].n,
    );
    expect(rowCount).toBe(4);

    // Visible in the browser, with the inspector resolving each panel's query.
    const ctx = await loggedIn(browser!, e, "alice");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel&data=semantic`);
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true, null, {
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-panel-state='READY']").length === 4,
      null,
      {
        timeout: 60_000,
      },
    );
    const visible = [];
    for (const p of doc.panels) {
      const loc = page.locator(`[data-testid='panel-${p.panelId}']`);
      expect(await loc.locator("[data-testid='panel-title']").textContent()).toBe(p.title);
      await loc.locator("[data-testid='provenance-toggle']").click();
      const insp = JSON.parse((await loc.locator("[data-testid='inspector']").textContent())!) as {
        queryHash: string;
        semanticVersion: string;
        ast: unknown;
      };
      expect(insp.queryHash).toBe(p.queryRef.hash);
      expect(insp.semanticVersion).toBe(p.queryRef.semanticVersion);
      expect(SemanticQuery.safeParse(insp.ast).success).toBe(true);
      visible.push({
        panelId: p.panelId,
        freshness: (await loc.locator("[data-testid='freshness']").textContent())!.trim(),
        units: (await loc.locator("[data-testid='units']").textContent())!.trim(),
      });
    }
    await page.screenshot({ path: "test-results/C01-composed.png", fullPage: true });

    // Editing and persistence demo: move + resize panel 1 by keyboard (kernel patches), reload, verify.
    const target = doc.panels[0]!;
    const before = (await page.evaluate(() => (window as unknown as H).__nearesis.doc)).layouts[
      target.panelId
    ]!.layout;
    const panelLoc = page.locator(`[data-testid='panel-${target.panelId}']`);
    await panelLoc.focus();
    const rev0 = await page.evaluate(() => (window as unknown as H).__nearesis.doc.revision);
    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForFunction((r) => (window as unknown as H).__nearesis.doc.revision === r + 1, rev0);
    await panelLoc.focus();
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await page.waitForFunction((r) => (window as unknown as H).__nearesis.doc.revision === r + 2, rev0);
    const edited = (await page.evaluate(() => (window as unknown as H).__nearesis.doc)).layouts[
      target.panelId
    ]!.layout;
    expect(edited).not.toEqual(before);
    const stored = CanvasDocument.parse(await e.kernel.canvas.get(s, ws));
    expect(stored.documentRevision).toBe(rev0 + 2);
    expect(stored.panels.find((p) => p.panelId === target.panelId)!.layout).toEqual(edited);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true, null, {
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-panel-state='READY']").length === 4,
      null,
      {
        timeout: 60_000,
      },
    );
    const afterReload = (await page.evaluate(() => (window as unknown as H).__nearesis.doc)).layouts;
    expect(afterReload[target.panelId]!.layout).toEqual(edited);
    expect(Object.keys(afterReload).sort()).toEqual(doc.panels.map((p) => p.panelId).sort());
    for (const p of doc.panels) expect(afterReload[p.panelId]!.queryHash).toBe(p.queryRef.hash);
    await page.screenshot({ path: "test-results/C01-after-edit-reload.png", fullPage: true });
    await ctx.close();

    const spentUsd = Math.round((spentAfter - spentBefore) * 1e6) / 1e6;
    observe({
      testId: "C01",
      observed: `live ${model}: blank workspace + "${PROMPT}" -> ${attempts.length} composition attempt(s) (${attempts.map((a) => a.status).join(",")}); 4 typed valid panels (${provenance.map((p) => `${p.kind}:${p.measures.join("+")}`).join("; ")}) each with a distinct recorded query (hash, semanticVersion, AST resolvable), persisted by the kernel and visible in the browser (4/4 READY); edit demo moved/resized "${target.title}" (${JSON.stringify(before)} -> ${JSON.stringify(edited)}), revision ${rev0} -> ${rev0 + 2}, identical after reload; model spend USD ${spentUsd} (ledger entries +${(await ledger.entries()).length - entriesBefore}) within the USD 5 cap`,
      fixtureHash: hashCanonical({ prompt: PROMPT, model }),
      evidence: {
        attempts,
        provenance,
        visible,
        before,
        edited,
        afterReload,
        spentUsd,
        model,
        plan: res!.plan,
        modelRequestId: res!.modelRequestId,
      },
    });
  }, 600_000);
});
