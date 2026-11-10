/**
 * C01 — Natural-language 4-panel task. PASS: a blank workspace receives "investigate NEAR Intents activity after the
 * private-settlement change" and yields four typed valid panels with query provenance, persisted by the kernel and
 * visible in the browser. Real path end to end: live OpenRouter model plans (typed plan only) -> near-thesis composer
 * -> semantic.discover@1 / canvas.preview@1 through the kernel ToolGateway (production plugin trust, leases) -> real
 * guarded gateway / Cube / ClickHouse -> kernel canvas.apply_patch via the agent runtime's KernelCanvasExecutor ->
 * production web build. The model is never mocked; without NEARESIS_ACCEPT_LIVE=1 the test records BLOCKED.
 * The directive's milestone demo (edit, save, reload, verify) is part of this evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "@nearesis/api";
import { CanvasDocument, SemanticQuery } from "@nearesis/contracts";
import { createPg, loadQuery } from "@nearesis/analytics";
import { createProvider, openRouterOptionsFromEnv } from "@nearesis/inference";
import { hashCanonical, validatePanelSpec } from "@nearesis/canvas-schema";
import { temporalEngine } from "../../../api/src/temporal-engine.ts";
import { makeEnv, startWorker, type Env } from "../../../../packages/workflow/test/helpers/harness.ts";
import { BASE, launch, startWeb, stopWeb } from "./harness.ts";
import { API_PORT } from "./kernel-harness.ts";

const PROMPT = "investigate NEAR Intents activity after the private-settlement change";
const live = process.env.NEARESIS_ACCEPT_LIVE === "1";

type H = {
  __nearesis: {
    ready: boolean;
    doc: { revision: number; layouts: Record<string, { layout: Layout; queryHash: string }> };
  };
};
type Layout = { x: number; y: number; w: number; h: number };

type App = Awaited<ReturnType<typeof buildApp>>;
let env: Env | undefined;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let app: App | undefined;
let browser: Browser | undefined;
beforeAll(async () => {
  if (!live) return;
  // Real path: kernel + runtime schema in one disposable database, a Temporal worker with the live composer, the
  // investigation API (Temporal-backed engine) on :4199 and the production web build in front of it.
  env = await makeEnv({ kernel: true });
  worker = await startWorker(env, { live: true });
  app = await buildApp({
    kernel: env.kernel!.kernel,
    engine: temporalEngine({ taskQueue: env.taskQueue }),
    nodeEnv: "test",
    ssePollMs: 50,
  });
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  await startWeb({ NEARESIS_API_URL: `http://127.0.0.1:${API_PORT}` });
  browser = await launch();
}, 600_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
  await app?.close();
  await worker?.stop();
  await env?.stop();
}, 180_000);

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
    const k = e.kernel!;
    const ws = k.workspaceId;
    const blank = await k.kernel.canvas.get(k.session, ws);
    expect(blank.panels).toHaveLength(0);

    const opts = openRouterOptionsFromEnv();
    const model = opts.primaryModel!;
    const ledger = (
      createProvider({ mode: "openrouter" }) as unknown as {
        spend: { spentUsd(): Promise<number>; entries(): Promise<unknown[]> };
      }
    ).spend;
    const spentBefore = await ledger.spentUsd();
    const entriesBefore = (await ledger.entries()).length;

    // The user asks in the browser (blank workspace -> POST /v1/workspaces/:id/questions, no scenario tag).
    const ctx = await browser!.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const login = await ctx.request.post(`${BASE}/api/dev/login`, { data: { subject: k.subject } });
    expect(login.status()).toBe(204);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel&data=semantic`);
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true, null, {
      timeout: 60_000,
    });
    expect(await page.locator("[data-panel-kind]").count()).toBe(0);
    await page.locator("[data-testid='ask-input']").fill(PROMPT);
    await page.locator("[data-testid='ask-submit']").click();

    // The run plans and composes; it stops at APPROVAL_NEEDED with the exact patch hash on an approval card.
    const card = page.locator("[data-testid='approval-card'][data-approval-status='pending']");
    await card.waitFor({ timeout: 300_000 });
    const actionHash = ((await card.locator("[data-testid='approval-hash']").textContent()) ?? "").trim();
    expect(actionHash).toMatch(/^[0-9a-f]{64}$/);
    const patchesBefore = await k.kernelAdmin.query(
      "SELECT count(*)::int AS n FROM canvas_patches WHERE workspace_id=$1",
      [ws],
    );
    expect(patchesBefore.rows[0].n).toBe(0); // nothing applied before the human approves
    expect(await page.locator("[data-panel-kind]").count()).toBe(0);
    await page.screenshot({ path: "test-results/C01-approval.png", fullPage: true });

    // The user approves the exact action hash (POST /v1/runs/:id/approvals/:approvalId); the kernel records it.
    await card.locator("[data-testid='approval-approve']").click();
    await page.locator("[data-testid='run-status'][data-run-state='COMPLETE']").waitFor({ timeout: 300_000 });
    const approval = await k.kernelAdmin.query(
      "SELECT action_hash FROM runtime.approvals ORDER BY id DESC LIMIT 1",
    );
    expect(approval.rows[0]?.action_hash).toBe(actionHash);
    const spentAfter = await ledger.spentUsd();

    // Persisted: four typed valid panels, each with a resolvable query record (provenance).
    const doc = CanvasDocument.parse(await k.kernel.canvas.get(k.session, ws));
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
        await k.kernelAdmin.query(
          "SELECT count(*) n FROM panel_specs WHERE workspace_id=$1 AND removed_at IS NULL",
          [ws],
        )
      ).rows[0].n,
    );
    expect(rowCount).toBe(4);

    // Visible in the browser (panels arrived over canvas.patched), with the inspector resolving each query.
    await page
      .waitForFunction(() => document.querySelectorAll("[data-panel-state='READY']").length === 4, null, {
        timeout: 60_000,
      })
      .catch(async (e) => {
        const seen = await page.evaluate(() =>
          [...document.querySelectorAll("[data-panel-kind]")].map((p) => ({
            kind: p.getAttribute("data-panel-kind"),
            state: p.getAttribute("data-panel-state"),
            error: p.querySelector("[data-testid='error-notice']")?.textContent ?? null,
          })),
        );
        throw new Error(`panels not READY: ${JSON.stringify(seen)}; ${String(e).slice(0, 120)}`);
      });
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
    const stored = CanvasDocument.parse(await k.kernel.canvas.get(k.session, ws));
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
      observed: `live ${model}: blank workspace + "${PROMPT}" asked in the browser -> POST /questions -> Temporal run -> approval card shown with action hash ${actionHash.slice(0, 12)} (0 patches applied before approval) -> user approved the exact hash in the UI (kernel approval record matches) -> run COMPLETE; 4 typed valid panels (${provenance.map((p) => `${p.kind}:${p.measures.join("+")}`).join("; ")}) each with a distinct recorded query (hash, semanticVersion, AST resolvable), persisted by the kernel and visible in the browser (4/4 READY); edit demo moved/resized "${target.title}" (${JSON.stringify(before)} -> ${JSON.stringify(edited)}), revision ${rev0} -> ${rev0 + 2}, identical after reload; model spend USD ${spentUsd} (ledger entries +${(await ledger.entries()).length - entriesBefore}) within the USD 5 cap`,
      fixtureHash: hashCanonical({ prompt: PROMPT, model }),
      evidence: {
        actionHash,
        provenance,
        visible,
        before,
        edited,
        afterReload,
        spentUsd,
        model,
      },
    });
  }, 600_000);
});
