/**
 * Evidence graph explorer browser tests: real kernel graph API (nodes, edges, tombstones, semantic rechecks,
 * snapshots), real web app, Playwright Chromium. Not W-series acceptance evidence (the lead records W-tests).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Env, loggedIn, open, startEnv, WEB_DIR } from "../thesis/harness.ts";
import { api, type Api } from "./seed.ts";

const OUT = `${WEB_DIR}test-results/evidence`;
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;
type G = {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    support?: string;
    recheckRequired?: boolean;
    tombstone?: boolean;
    position?: { x: number; y: number };
  }>;
  edges: Array<{ source: string; target: string; relation: string }>;
};
const edgeSet = (g: G) => g.edges.map((x) => `${x.source}|${x.target}|${x.relation}`).sort();

let env: Env;
let a: Api;
const ids: Record<string, string> = {};
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
  a = await api(env);
  ids.H = await a.node("hypothesis", "Intents activity leads NEAR adoption");
  ids.S = await a.node("source", "NEAR Intents Explorer (1Click)");
  ids.Q = await a.node("query", "Completed swaps by day", {
    semanticPins: { "intents.oneclick_completed_swap_count": "1.0.0" },
  });
  ids.R = await a.node("statistical_result", "corr(swaps_t, tx_t+7)");
  ids.C1 = await a.node("claim", "Swaps lead transactions by 7 days");
  ids.C2 = await a.node("claim", "Intents is the better leading indicator");
  for (const [f, t, r] of [
    [ids.Q, ids.S, "derived_from"],
    [ids.R, ids.Q, "derived_from"],
    [ids.R, ids.C1, "supports"],
    [ids.C1, ids.H, "supports"],
    [ids.C2, ids.H, "references"],
  ] as const) {
    const res = await a.edge(f, t, r);
    if (res.status >= 300) throw new Error(`edge ${r}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  // Explicit tombstone for an endpoint that was never persisted.
  const tomb = await a.edge(ids.C2, crypto.randomUUID(), "references", {
    tombstoneMissing: true,
    tombstoneReason: "Source report was withdrawn",
    tombstoneKind: "source",
  });
  if (tomb.status >= 300) throw new Error(`tombstone edge: ${tomb.status} ${JSON.stringify(tomb.body)}`);
  // Semantic version change flags the query node for recheck.
  const sc = await a.post("/graph/semantic-changes", {
    metricId: "intents.oneclick_completed_swap_count",
    toVersion: "1.1.0",
  });
  if (sc.status >= 300) throw new Error(`semantic change: ${sc.status} ${JSON.stringify(sc.body)}`);
}, 600_000);
afterAll(async () => {
  await env?.close();
});

describe("evidence graph explorer", () => {
  it("renders typed nodes with unsupported, recheck and tombstone states; inspection, filtering and keyboard navigation work", async () => {
    const g = await a.get<G>("/graph");
    const byLabel = (l: string) => g.nodes.find((n) => n.label === l)!;
    const tomb = g.nodes.find((n) => n.tombstone);
    expect(byLabel("Intents is the better leading indicator").support).toBe("unsupported");
    expect(byLabel("Swaps lead transactions by 7 days").support).toBe("supported");
    expect(byLabel("Completed swaps by day").recheckRequired).toBe(true);
    expect(tomb).toBeTruthy();

    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(ctx, `/w/${env.workspaceId}/evidence`, "__evidence");
    await page.waitForTimeout(800);
    await expect(page.getByTestId(`ev-state-${ids.C2}`).textContent()).resolves.toBe("Unsupported claim");
    // C1 is supported; the semantic-version change on its upstream query flags it for recheck (impact analysis).
    const c1 = byLabel("Swaps lead transactions by 7 days");
    await expect(page.getByTestId(`ev-node-${ids.C1}`).getAttribute("data-state")).resolves.toBe(
      c1.recheckRequired ? "recheck" : "ok",
    ); // supported: no warning
    await expect(page.getByTestId(`ev-state-${ids.Q}`).textContent()).resolves.toBe("Recheck required");
    await expect(page.getByTestId(`ev-state-${tomb!.id}`).textContent()).resolves.toMatch(/Tombstone/);
    await expect(page.getByTestId(`ev-node-${ids.C2}`).getAttribute("data-state")).resolves.toBe(
      "unsupported",
    );

    // Keyboard: Tab to the node list, Enter opens the unsupported claim; W08 missing provenance is explicit.
    await page.getByTestId(`list-node-${ids.C2}`).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("inspector-state").textContent()).resolves.toContain("Unsupported claim");
    const missing = await page.getByTestId("missing-provenance").textContent();
    expect(missing).toContain("No supports/reproduces edge");
    expect(missing).toContain("No derivation path to a persisted source record");
    // Supported claim: provenance links reach the source through the result and the query.
    await page.getByTestId(`list-node-${ids.C1}`).click();
    const prov = await page.getByTestId("provenance-links").textContent();
    expect(prov).toContain("statistical result: corr(swaps_t, tx_t+7)");
    expect(prov).toContain("source: NEAR Intents Explorer (1Click)");
    expect(await page.getByTestId("missing-provenance").count(), "no missing provenance for C1").toBe(0);

    // Edge inspection.
    // Dispatch on the edge element itself so the check does not depend on pixel positions after fitView.
    await page.locator(".react-flow__edge").first().dispatchEvent("click");
    await expect(page.getByTestId("edge-inspector").textContent()).resolves.toMatch(
      /(supports|derived from|references)/,
    );

    // Filtering by state.
    await page.getByTestId("filter-state").selectOption("unsupported");
    const visible = await page.evaluate(
      () => (window as unknown as { __evidence: { visibleNodes: number } }).__evidence.visibleNodes,
    );
    expect(visible).toBe(1);
    await page.getByTestId("filter-state").selectOption("any");
    await page.getByTestId("kind-claim").uncheck();
    expect(await page.getByTestId(`list-node-${ids.C1}`).count(), "claims hidden by kind filter").toBe(0);
    await page.getByTestId("kind-claim").check();

    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/evidence-graph.png`, fullPage: true });
    await ctx.close();
  }, 300_000);

  it("deep link ?node= selects and inspects that node (marker evidence links)", async () => {
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/evidence?node=${ids.C2}`, "__evidence");
    await page.getByTestId("node-inspector").waitFor({ timeout: 30_000 });
    await expect(page.getByTestId("node-inspector").textContent()).resolves.toContain(
      "Intents is the better leading indicator",
    );
    await expect(page.getByTestId(`list-node-${ids.C2}`).getAttribute("aria-pressed")).resolves.toBe("true");
    // Reviewer comments on the node: add one through the UI and read it back from the API.
    await page.getByTestId("comment-input").fill("Needs a source before publication. <b>not markup</b>");
    await page.getByTestId("comment-submit").click();
    await page.getByTestId("comment").first().waitFor({ timeout: 30_000 });
    await expect(page.getByTestId("comment").first().textContent()).resolves.toContain("<b>not markup</b>");
    const stored = await a.get<{ comments: Array<{ nodeId: string; body: string }> }>(
      `/comments?nodeId=${ids.C2}`,
    );
    expect(stored.comments.map((c) => c.body)).toContain(
      "Needs a source before publication. <b>not markup</b>",
    );
    await ctx.close();
  }, 300_000);

  it("dragging a node saves layout only and never changes evidence relations", async () => {
    const before = await a.get<G>("/graph");
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/evidence`, "__evidence");
    await page.waitForTimeout(800);
    const box = (await page.getByTestId(`ev-node-${ids.H}`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    await page.getByTestId("layout-save-state").filter({ hasText: "saved" }).waitFor({ timeout: 30_000 });
    const after = await a.get<G>("/graph");
    expect(edgeSet(after)).toEqual(edgeSet(before));
    expect(after.nodes.map((n) => `${n.id}:${n.type}:${n.label}:${n.support ?? ""}`).sort()).toEqual(
      before.nodes.map((n) => `${n.id}:${n.type}:${n.label}:${n.support ?? ""}`).sort(),
    );
    const pos = after.nodes.find((n) => n.id === ids.H)!.position;
    expect(pos).toBeTruthy();
    // Reload: the saved position is used.
    await page.reload();
    await page.waitForFunction(
      () => (window as unknown as { __evidence?: { ready: boolean } }).__evidence?.ready === true,
    );
    writeFileSync(
      `${OUT}/drag-result.json`,
      JSON.stringify(
        { edgesBefore: edgeSet(before).length, edgesAfter: edgeSet(after).length, savedPosition: pos },
        null,
        2,
      ),
    );
    await ctx.close();
  }, 300_000);

  it("shows a snapshot as captured with its data vintage, and reports vintage_unavailable instead of current data", async () => {
    const snap = await a.post<{ result: { snapshotId: string } }>("/snapshots", {
      label: "before-new-claim",
    });
    expect(snap.status).toBeLessThan(300);
    const sid = snap.body.result.snapshotId;
    const atSnapshot = (await a.get<G>("/graph")).nodes.length;
    await a.node("claim", "Added after the snapshot");
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/evidence?snapshot=${sid}`, "__evidence");
    await expect(page.getByTestId("vintage-banner").textContent()).resolves.toMatch(
      /Historical snapshot “before-new-claim” captured .*document revision \d+, data revision \d+, event seq \d+.*semantic pins/s,
    );
    const n = await page.evaluate(
      () => (window as unknown as { __evidence: { nodes: number } }).__evidence.nodes,
    );
    expect(n).toBe(atSnapshot);
    expect(await page.getByText("Added after the snapshot").count()).toBe(0);
    await page.screenshot({ path: `${OUT}/evidence-snapshot.png`, fullPage: true });

    const { page: p2 } = await open(
      ctx,
      `/w/${env.workspaceId}/evidence?snapshot=${crypto.randomUUID()}`,
      "__evidence",
    );
    await expect(p2.getByTestId("graph-failure").textContent()).resolves.toMatch(
      /vintage_unavailable.*Current data is not substituted/s,
    );
    expect(await p2.getByTestId("graph-canvas").count()).toBe(0);
    await ctx.close();
  }, 300_000);
});
