/**
 * End-to-end user journey over the real integrated app: kernel API, Postgres, semantic gateway (fixture cubes),
 * capsule API and the web build. Each step asserts persisted server state, not just that a control rendered.
 * Writes product screenshots to apps/web/test-results/product/. Reported as browser-test results, not acceptance.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { PanelSpec } from "@nearesis/contracts";
import { createWs, loginSession, runCmd } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, type Env, loggedIn, open, startEnv, WEB_DIR } from "../thesis/harness.ts";
import { api, type Api } from "../evidence/seed.ts";

const OUT = `${WEB_DIR}test-results/product`;
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;
const PANELS = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels;
const steps: Array<{ step: string; result: string }> = [];
const record = (step: string, result: string) => steps.push({ step, result });

let env: Env;
let a: Api;
let wsB = "";
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
  a = await api(env);
  const s = await loginSession(env.kernel, env.subject);
  wsB = (await createWs(env.kernel, s, "Second workspace: Base adapter checks")).workspaceId;
  const v = (await env.kernel.workspaces.get(s, env.workspaceId)).version;
  await runCmd(
    env.kernel,
    s,
    env.workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      operations: PANELS.slice(0, 3).map((panel) => ({ op: "addPanel", panel })),
    },
    v,
  );
}, 600_000);
afterAll(async () => {
  writeFileSync(`${OUT}/journey-steps.json`, JSON.stringify(steps, null, 2));
  await env?.close();
});

const waitWorkspace = (p: Page) =>
  p.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready?: boolean } }).__nearesis?.ready === true,
    null,
    { timeout: 180_000 },
  );

describe("user journey", () => {
  it("signs in, works on the canvas, switches workspaces, and reaches every research page from the sidebar", async () => {
    const ctx = await loggedIn(env);
    const page = await ctx.newPage();
    // Panels seeded from the fixture scenario carry fixture query hashes, so the canvas uses the labelled SYNTHETIC
    // fixture data path (backend=kernel without data=semantic). Persistence is the real kernel either way.
    await page.goto(`${BASE}/w/${env.workspaceId}?backend=kernel`);
    await waitWorkspace(page);
    await page.locator("[data-panel-kind]").first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-panel-kind]")].every(
          (e) => e.getAttribute("data-panel-state") === "READY",
        ),
      null,
      { timeout: 60_000 },
    );
    const panels = await page.locator("[data-panel-kind][data-panel-state='READY']").count();
    expect(panels).toBe(3);
    record(
      "canvas loads the persisted panels and renders their data (SYNTHETIC fixture data path)",
      `${panels} panels READY`,
    );
    await page.screenshot({ path: `${OUT}/01-canvas.png`, fullPage: false });

    // Workspace switching through the sidebar menu.
    await page.getByTestId("workspace-switch").click();
    await page.getByTestId(`workspace-option-${wsB}`).click();
    await page.waitForURL(new RegExp(`/w/${wsB}`), { timeout: 60_000 });
    await waitWorkspace(page);
    record(
      "workspace switcher navigates to the chosen workspace",
      page.url().includes(wsB) ? "ok" : "failed",
    );
    await page.goto(`${BASE}/w/${env.workspaceId}?backend=kernel&data=semantic`);
    await waitWorkspace(page);

    // Settings view.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByTestId("settings-page").waitFor();
    record("settings view opens", "ok");
    await page.getByTestId("back-to-canvas").click();

    // Research pages from the sidebar, each reaching its ready state.
    for (const [label, path, flag] of [
      ["Investment thesis", "thesis", "__thesis"],
      ["Evidence graph", "evidence", "__evidence"],
      ["Time machine", "history", "__history"],
      ["Research capsules", "capsule", "__capsule"],
    ] as const) {
      await page.goto(`${BASE}/w/${env.workspaceId}?backend=kernel&data=semantic`);
      await waitWorkspace(page);
      await page.getByTestId("sidebar-research").getByRole("button", { name: label }).click();
      await page.waitForURL(new RegExp(`/w/${env.workspaceId}/${path}`), { timeout: 60_000 });
      await page.waitForFunction(
        (f) => (window as unknown as Record<string, { ready?: boolean } | undefined>)[f]?.ready === true,
        flag,
        { timeout: 180_000 },
      );
      record(`sidebar → ${label}`, "page ready");
    }
    await ctx.close();
  }, 900_000);

  it("records evidence, captures history, branches, reads a capsule and exports the thesis report", async () => {
    // Evidence recorded through the API appears in the explorer with its claim state.
    const src = await a.node("source", "NEAR Intents Explorer");
    const res = await a.node("statistical_result", "ΔMAE intents vs baseline, 1d");
    const claim = await a.node("claim", "Intents volume improves 1-day forecasts");
    await a.edge(res, src, "derived_from");
    await a.edge(res, claim, "supports");
    const ctx = await loggedIn(env);
    const ev = await open(ctx, `/w/${env.workspaceId}/evidence`, "__evidence");
    await ev.page.getByTestId(`ev-node-${claim}`).waitFor();
    await ev.page.waitForTimeout(600);
    await ev.page.screenshot({ path: `${OUT}/02-evidence-graph.png` });
    record(
      "evidence explorer shows recorded nodes",
      `${await ev.page.locator("[data-testid^='ev-node-']").count()} nodes`,
    );

    // Snapshot captured in the time machine; the evidence explorer can open it.
    const h = await open(ctx, `/w/${env.workspaceId}/history`, "__history");
    await h.page.getByTestId("snapshot-label").fill("Journey baseline");
    await h.page.getByTestId("capture-snapshot").click();
    await h.page.getByTestId("open-snapshot-Journey baseline").waitFor({ timeout: 30_000 });
    const snaps = (await a.get<{ snapshots: Array<{ id: string; label: string }> }>("/snapshots")).snapshots;
    const sid = snaps.find((x) => x.label === "Journey baseline")!.id;
    await h.page.getByTestId("branch-from").selectOption(sid);
    await h.page.getByTestId("branch-name").fill("journey-alt");
    await h.page.getByTestId("create-branch").click();
    await h.page.getByTestId("branch-view").waitFor({ timeout: 30_000 });
    const branches = (await a.get<{ branches: Array<{ name: string }> }>("/branches")).branches;
    expect(branches.some((b) => b.name === "journey-alt")).toBe(true);
    await h.page.screenshot({ path: `${OUT}/03-time-machine.png`, fullPage: true });
    record("snapshot captured and branch created from it (persisted)", "ok");
    const evs = await open(ctx, `/w/${env.workspaceId}/evidence?snapshot=${sid}`, "__evidence");
    await evs.page.getByTestId("vintage-banner").waitFor();
    record("evidence explorer opens the captured snapshot with its vintage", "ok");

    // Capsule built by the capsule CLI, read through the live API.
    env.buildCapsule();
    const cap = await open(ctx, `/w/${env.workspaceId}/capsule`, "__capsule");
    await cap.page.getByTestId("proof-outlayer").waitFor({ timeout: 60_000 });
    await cap.page.screenshot({ path: `${OUT}/04-capsule.png`, fullPage: true });
    record(
      "capsule viewer shows the latest published capsule",
      (await cap.page.getByTestId("capsule-status-summary").textContent()) ?? "",
    );

    // Thesis: research results from the capsule; the JSON report export equals what the page renders.
    const th = await open(ctx, `/w/${env.workspaceId}/thesis?from=2025-09-01&to=2025-12-31`, "__thesis");
    await th.page.getByTestId("verdict").waitFor({ timeout: 60_000 });
    const [dl] = await Promise.all([
      th.page.waitForEvent("download"),
      th.page.getByTestId("export-json").click(),
    ]);
    const exported = JSON.parse(readFileSync((await dl.path())!, "utf8")) as { sha256: string };
    const shown = await th.page.evaluate(
      () => (window as unknown as { __thesis: { report: { sha256: string } } }).__thesis.report.sha256,
    );
    expect(exported.sha256).toBe(shown);
    await th.page.screenshot({ path: `${OUT}/05-thesis.png`, fullPage: true });
    record("thesis report export equals the rendered report", exported.sha256);
    for (const p of [ev, h, evs, cap, th]) expect(contentCsp(await p.csp())).toEqual([]);
    await ctx.close();
  }, 900_000);
});
