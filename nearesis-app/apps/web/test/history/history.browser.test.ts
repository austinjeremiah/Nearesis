/**
 * Time machine browser tests: real kernel snapshots, timeline, branches and merge proposals through the web UI.
 * Not W-series acceptance evidence (the lead records W-tests); reported as browser-test results.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PanelSpec } from "@nearesis/contracts";
import { runCmd } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { type Env, loggedIn, open, startEnv, WEB_DIR } from "../thesis/harness.ts";
import { api, type Api } from "../evidence/seed.ts";

const OUT = `${WEB_DIR}test-results/history`;
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;
const METRIC = "intents.oneclick_completed_swap_count";
const METRIC2 = "prices.daily_close_price_usd";
const PANEL = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels[0]!;
type H = {
  __history: {
    ready: boolean;
    proposal: { conflicts: Array<{ resolution: string }>; status: string } | null;
    lastAccept: { applied: number; deferredObjects: string[] } | null;
  };
};

let env: Env;
let a: Api;
let claimId = "";
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
  a = await api(env);
  const s = await env.kernel.identity.resolveSession(await env.kernel.devAuth!.login(env.subject));
  const ws = await env.kernel.workspaces.get(s, env.workspaceId);
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
      operations: [{ op: "addPanel", panel: PANEL }],
    },
    ws.version,
  );
  claimId = await a.node("claim", "Swaps lead transactions by 7 days", {
    semanticPins: { [METRIC]: "1.0.0" },
  });
  for (const [m, v] of [
    [METRIC, "1.1.0"],
    [METRIC2, "1.0.0"],
  ] as const) {
    const sc = await a.post("/graph/semantic-changes", { metricId: m, toVersion: v });
    if (sc.status >= 300) throw new Error(`semantic change: ${sc.status} ${JSON.stringify(sc.body)}`);
  }
}, 600_000);
afterAll(async () => {
  await env?.close();
});

describe("time machine", () => {
  it("captures, views and compares snapshots with their data vintage", async () => {
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(ctx, `/w/${env.workspaceId}/history`, "__history");
    await page.getByTestId("snapshot-label").fill("S1 baseline");
    await page.getByTestId("capture-snapshot").click();
    await page.getByTestId("open-snapshot-S1 baseline").waitFor({ timeout: 30_000 });
    await a.node("observation", "Swaps rose after 2026-10-27");
    await page.getByTestId("snapshot-label").fill("S2 with observation");
    await page.getByTestId("capture-snapshot").click();
    await page.getByTestId("open-snapshot-S2 with observation").waitFor({ timeout: 30_000 });

    await expect(page.getByTestId("timeline").textContent()).resolves.toMatch(/snapshot/);
    await page.getByTestId("open-snapshot-S1 baseline").click();
    await expect(page.getByTestId("snapshot-vintage").textContent()).resolves.toMatch(`${METRIC}@1.1.0`);
    await expect(page.getByTestId("snapshot-panels").textContent()).resolves.toContain(PANEL.title);

    const snaps = (await a.get<{ snapshots: Array<{ id: string; label: string }> }>("/snapshots")).snapshots;
    await page.getByTestId("compare-a").selectOption(snaps.find((x) => x.label === "S1 baseline")!.id);
    await page
      .getByTestId("compare-b")
      .selectOption(snaps.find((x) => x.label === "S2 with observation")!.id);
    await page.getByTestId("compare-run").click();
    await page.getByTestId("compare-changes").waitFor();
    const rows = await page.getByTestId("compare-changes").locator("tbody tr").allTextContents();
    expect(
      rows.some(
        (r) => r.includes("node:") && r.includes("added") && r.includes("Swaps rose after 2026-10-27"),
      ),
    ).toBe(true);
    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 300_000);

  it("branches without touching main, flags conflicts, requires resolution, and reports deferred panel changes", async () => {
    const snaps = (await a.get<{ snapshots: Array<{ id: string; label: string }> }>("/snapshots")).snapshots;
    const s1 = snaps.find((x) => x.label === "S1 baseline")!.id;
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(ctx, `/w/${env.workspaceId}/history`, "__history");
    page.on("dialog", (d) => void d.accept("Swaps lead transactions by 7 days (branch wording)"));

    await page.getByTestId("branch-from").selectOption(s1);
    await page.getByTestId("branch-name").fill("alt-lag");
    await page.getByTestId("create-branch").click();
    await page.getByTestId("branch-view").waitFor({ timeout: 30_000 });
    await page.getByTestId(`relabel-node:${claimId}`).click();
    await page
      .getByTestId("branch-diff-base")
      .filter({ hasText: "branch wording" })
      .waitFor({ timeout: 30_000 });
    // Main is untouched by the branch edit.
    const mainNode = (await a.get<{ nodes: Array<{ id: string; label: string }> }>("/graph")).nodes.find(
      (n) => n.id === claimId,
    )!;
    expect(mainNode.label).toBe("Swaps lead transactions by 7 days");

    // Branch-only changes the UI does not expose yet are seeded via the API: a metric version and a panel title.
    const branches = (await a.get<{ branches: Array<{ id: string; name: string }> }>("/branches")).branches;
    const bid = branches.find((b) => b.name === "alt-lag")!.id;
    const ch = await a.post(`/branches/${bid}/changes`, {
      ops: [
        // Same major as main's concurrent change -> a conflict to resolve.
        { op: "set", objectId: `metric:${METRIC}`, value: { version: "1.9.0" } },
        // Crosses a major version of main's definition -> excluded by policy (SEMVER_INCOMPATIBLE), never merged.
        { op: "set", objectId: `metric:${METRIC2}`, value: { version: "5.0.0" } },
        { op: "set", objectId: `panel:${PANEL.panelId}`, value: { ...PANEL, title: "Renamed on branch" } },
      ],
    });
    expect(ch.status).toBeLessThan(300);
    // Main moves the same metric concurrently -> conflict.
    expect(
      (await a.post("/graph/semantic-changes", { metricId: METRIC, toVersion: "1.2.0" })).status,
    ).toBeLessThan(300);

    await page.reload();
    await page.waitForFunction(() => (window as unknown as H).__history?.ready === true);
    await page.getByTestId("open-branch-alt-lag").click();
    await page.getByTestId("propose-merge").click();
    await page.getByTestId("proposal-view").waitFor({ timeout: 30_000 });
    await expect(page.getByTestId("proposal-changes").textContent()).resolves.toContain(
      "will be deferred, not applied",
    );
    await expect(page.getByTestId("proposal-excluded").textContent()).resolves.toMatch(
      /metric:prices\.daily_close_price_usd.*SEMVER_INCOMPATIBLE/s,
    );
    const conflicts = await page.getByTestId("conflicts").locator("tbody tr").count();
    expect(conflicts).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("accept-merge").isDisabled()).resolves.toBe(true);
    await page.screenshot({ path: `${OUT}/history-merge.png`, fullPage: true });

    for (let i = 0; i < conflicts; i++) {
      await page.getByTestId("resolve-theirs").nth(i).click();
      await page.waitForFunction(
        (n) =>
          ((window as unknown as H).__history.proposal?.conflicts.filter((c) => c.resolution !== "unresolved")
            .length ?? 0) >= n,
        i + 1,
        { timeout: 30_000 },
      );
    }
    await expect(page.getByTestId("accept-merge").isDisabled()).resolves.toBe(false);
    await page.getByTestId("accept-merge").click();
    await page.waitForFunction(
      () =>
        (window as unknown as H).__history.lastAccept !== null ||
        (window as unknown as { __history: { error: string | null } }).__history.error !== null,
      null,
      { timeout: 30_000 },
    );
    const result = await page.evaluate(() => ({
      last: (window as unknown as H).__history.lastAccept,
      error: (window as unknown as { __history: { error: string | null } }).__history.error,
    }));
    writeFileSync(`${OUT}/merge-result.json`, JSON.stringify(result, null, 2));
    expect(result.error).toBeNull();
    expect(result.last!.deferredObjects).toContain(`panel:${PANEL.panelId}`);
    await expect(page.getByTestId("merge-result").textContent()).resolves.toContain("Deferred, not applied");
    // The merged node label reached main; the deferred panel title did not.
    const after = await a.get<{ nodes: Array<{ id: string; label: string }> }>("/graph");
    expect(after.nodes.find((n) => n.id === claimId)!.label).toContain("branch wording");
    const canvas = await a.get<{ panels: Array<{ panelId: string; title: string }> }>("/canvas");
    expect(canvas.panels.find((p) => p.panelId === PANEL.panelId)!.title).toBe(PANEL.title);
    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/history-after-merge.png`, fullPage: true });
    await ctx.close();
  }, 300_000);
});
