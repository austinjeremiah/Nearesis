/**
 * Browser halves of W08, W09, W11, W12 and W18 against the real kernel (seeded in-process through the history
 * service, read through the web app and its BFF):
 *  - W08 unsupported claims listed under UNSUPPORTED with the server's `missing` list; web evidence `unverified`;
 *  - W09 impact of a metric version change: dependents with depth, cycles listed, a restricted node absent for a
 *    user without a grant;
 *  - W11 reconstruction at a journal revision: panels without a data vintage are `vintage_unavailable`; export hash;
 *  - W12 timeline entries attributed human / agent;
 *  - W18 retention deletion: tombstone metadata only, dependent claims flagged evidence unavailable, foreign
 *    dereference refused.
 * Reported as browser-test results; no acceptance evidence is recorded here.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { PanelSpec } from "@nearesis/contracts";
import { historyService, type Session } from "@nearesis/kernel";
import { createWs, loginSession } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, type Env, loggedIn, ready, seedPanels, startEnv, watch, WEB_DIR } from "../p11/harness.ts";

const OUT = `${WEB_DIR}test-results/history`;
const FULL = {
  resultRowIds: ["r1", "r2"],
  columnIds: ["volume_usd"],
  queryHash: "a".repeat(64),
  semanticModelVersion: "intents@1.2.0",
  rawSourceManifestHash: "b".repeat(64),
  quantModelRevision: "quant-r7",
};

let env: Env;
let ws = "";
let owner: Session;
let h: ReturnType<typeof historyService>;
const ids: Record<string, string> = {};

const version = async () => (await env.kernel.workspaces.get(owner, ws)).version;
async function node(s: Session, kind: string, label: string, extra: Record<string, unknown> = {}) {
  const r = await h.graphOps.addNode(s, ws, { expectedVersion: await version(), kind, label, ...extra });
  return r.result.nodeId as string;
}
async function edge(from: string, to: string, relation: string) {
  await h.graphOps.addEdge(owner, ws, { expectedVersion: await version(), from, to, relation });
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
  h = historyService(env.kernel);
  owner = await loginSession(env.kernel, env.subjects.alice);
  ws = (await createWs(env.kernel, owner, "W UI halves")).workspaceId;

  // W11: two panels with no recorded data vintage.
  const tpl = (loadScenario("graph").document as { panels: PanelSpec[] }).panels[0]!;
  const panels = [0, 1].map((i) => ({
    ...structuredClone(tpl),
    panelId: randomUUID(),
    title: `Reconstructed panel ${i + 1}`,
    layout: { x: i * 12, y: 0, w: 12, h: 6 },
  }));
  await seedPanels(env, "alice", ws, panels);
  ids.panel1 = panels[0]!.panelId;

  // W08: a full-provenance claim, a claim missing quant_model_revision, a web source without a fragment hash.
  const result = await node(owner, "statistical_result", "Result table r1");
  ids.full = await node(owner, "claim", "Full provenance claim", {
    data: { numeric: true, value: 42, provenance: FULL },
  });
  await edge(result, ids.full, "supports");
  const { quantModelRevision: _q, ...noQuant } = FULL;
  void _q;
  ids.hole = await node(owner, "claim", "Claim without model revision", {
    data: { numeric: true, value: 7, provenance: noQuant },
  });
  await edge(result, ids.hole, "supports");
  ids.web = await node(owner, "source", "Web page without fragment hash", {
    data: {
      web: {
        title: "Intents overview",
        canonicalUrl: "https://example.org/intents",
        retrievedAt: "2026-11-09T10:00:00Z",
        confidenceTier: "high",
      },
    },
  });
  ids.webClaim = await node(owner, "claim", "Claim relying on web evidence", { data: { numeric: false } });
  await edge(ids.web, ids.webClaim, "supports");

  // W09: three nodes pinned to metric M 1.0.0 with derived dependents, a cycle, and a restricted dependent.
  const M = "prices.daily_close_price_usd";
  ids.root = await node(owner, "statistical_result", "Price regression", { semanticPins: { [M]: "1.0.0" } });
  ids.dep1 = await node(owner, "claim", "Derived claim one");
  ids.dep2 = await node(owner, "observation", "Derived observation two");
  ids.secret = await node(owner, "observation", "Restricted dependent");
  await edge(ids.dep1, ids.root, "derived_from");
  await edge(ids.dep2, ids.dep1, "derived_from");
  await edge(ids.dep1, ids.dep2, "derived_from"); // cycle dep1 <-> dep2
  await edge(ids.secret, ids.root, "derived_from");
  await h.graphOps.setRestriction(owner, ws, {
    expectedVersion: await version(),
    nodeId: ids.secret,
    restricted: true,
    grantUserIds: [env.orgs.a.users.alice!.userId],
  });
  await h.graphOps.changeSemanticVersion(owner, ws, {
    expectedVersion: await version(),
    metricId: M,
    toVersion: "2.0.0",
  });

  // W12: an agent principal adds a node (server-resolved kind, as the runtime does for subagents).
  const agent: Session = {
    principal: { kind: "agent", actorId: randomUUID(), orgId: env.orgs.a.orgId, parentRunId: randomUUID() },
    role: "analyst",
    userId: env.orgs.a.users.dave!.userId,
  } as Session;
  ids.agentNode = await node(agent, "observation", "Agent observation");

  // W18: an evidence item with a raw payload; a claim supported by it; then the payload is deleted under retention.
  const obj = await h.objects.put(owner, new TextEncoder().encode(`retained payload ${"x".repeat(200)}`));
  ids.item = await node(owner, "observation", "Excerpt with raw payload", { rawObjectHash: obj.hash });
  ids.itemClaim = await node(owner, "claim", "Claim supported by the excerpt");
  await edge(ids.item, ids.itemClaim, "supports");
  await h.retention.deletePayload(owner, ws, {
    expectedVersion: await version(),
    nodeId: ids.item,
    reason: "legal retention limit reached",
  });
}, 900_000);
afterAll(async () => {
  await env?.close();
});

async function evidence(who: "alice" | "dave" | "bob", path = `/w/${ws}/evidence`) {
  const ctx = await loggedIn(env, who);
  const w = await watch(ctx);
  await w.page.goto(`${BASE}${path}`);
  await w.page.getByTestId("graph-canvas").waitFor({ timeout: 120_000 });
  return { ctx, ...w };
}
const text = async (p: Page, id: string) => (await p.getByTestId(id).first().textContent()) ?? "";

describe("W UI halves", () => {
  it("W08: unsupported claims are listed under UNSUPPORTED with their missing provenance; web evidence is unverified", async () => {
    const { ctx, page, csp } = await evidence("alice");
    await page.getByTestId("publication-unsupported").waitFor();
    const section = await text(page, "publication-unsupported");
    expect(section).toMatch(/^UNSUPPORTED/);
    expect(section).not.toContain("Full provenance claim");
    await expect(text(page, `unsupported-${ids.hole}`)).resolves.toContain("quant_model_revision");
    await expect(text(page, `unsupported-${ids.webClaim}`)).resolves.toContain(
      "Claim relying on web evidence",
    );
    // The full-provenance claim is publishable as supported; other fixture claims may be too.
    await expect(text(page, "publication-supported")).resolves.toMatch(/^[1-9]\d* supported claim/);
    // The claim's inspector shows the server's missing list; the web source shows its confidence tier.
    await page.getByTestId(`unsupported-${ids.hole}`).getByRole("button").click();
    await expect(text(page, "missing-provenance")).resolves.toContain("quant_model_revision");
    await page.getByTestId(`list-node-${ids.web}`).click();
    await expect(text(page, "confidence-tier")).resolves.toContain("unverified");
    await expect(text(page, "missing-provenance")).resolves.toContain("fragment_hash");
    await page.getByTestId("publication-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/w08-unsupported.png`, fullPage: true });
    expect(await csp()).toEqual([]);
    await ctx.close();
  }, 300_000);

  it("W09: impact lists dependents and cycles; a restricted node is absent for a user without a grant", async () => {
    const M = "prices.daily_close_price_usd";
    const run = async (who: "alice" | "dave") => {
      const s = await evidence(who);
      await s.page.getByTestId("impact-metric").fill(M);
      await s.page.getByTestId("impact-run").click();
      await s.page.getByTestId("impact-result").waitFor();
      return s;
    };
    const a = await run("alice");
    for (const k of ["root", "dep1", "dep2", "secret"])
      expect(await a.page.getByTestId(`impact-node-${ids[k]}`).count(), k).toBe(1);
    await expect(a.page.getByTestId(`impact-node-${ids.root}`).getAttribute("data-depth")).resolves.toBe("0");
    const cycles = await a.page.getByTestId("impact-cycle").allTextContents();
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain("Derived claim one");
    expect(cycles[0]).toContain("Derived observation two");
    await a.page.getByTestId("impact-panel").scrollIntoViewIfNeeded();
    await a.page.screenshot({ path: `${OUT}/w09-impact.png`, fullPage: true });
    await a.ctx.close();

    const d = await run("dave");
    expect(await d.page.getByTestId(`impact-node-${ids.secret}`).count()).toBe(0);
    expect(await d.page.getByTestId(`impact-node-${ids.dep1}`).count()).toBe(1);
    // Impact never names the restricted node. (GET /graph itself does not yet apply node restrictions: queued.)
    expect(await text(d.page, "impact-result")).not.toContain("Restricted dependent");
    await d.ctx.close();
  }, 300_000);

  it("W11 + W12: timeline attributes human and agent edits; reconstruction shows vintage_unavailable and exports a hash", async () => {
    const ctx = await loggedIn(env, "alice");
    const w = await watch(ctx);
    await w.page.goto(`${BASE}/w/${ws}/history`);
    await ready(w.page, "__history", 120_000);
    const actors = await w.page
      .getByTestId("tl-entry")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-actor")));
    expect(actors).toContain("human");
    expect(actors).toContain("agent");
    expect(actors).not.toContain("unknown");
    // Filter: agent edits only.
    await w.page.getByTestId("actor-human").uncheck();
    const onlyAgent = await w.page
      .getByTestId("tl-entry")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-actor")));
    expect(new Set(onlyAgent)).toEqual(new Set(["agent"]));
    await w.page.screenshot({ path: `${OUT}/w12-agent-filter.png`, fullPage: true });
    await w.page.getByTestId("actor-human").check();

    // Reconstruct at the latest journal revision from the timeline.
    await w.page.getByTestId("tl-reconstruct").first().click();
    await w.page.getByTestId("rec-view").waitFor({ timeout: 60_000 });
    await expect(text(w.page, "rec-exact")).resolves.toBe("not an exact reproduction");
    const states = await w.page
      .getByTestId("rec-panels")
      .locator("li")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
    expect(states.length).toBe(2);
    expect(new Set(states)).toEqual(new Set(["vintage_unavailable"]));
    await expect(text(w.page, `rec-panel-${ids.panel1}`)).resolves.toContain("current data is not shown");
    await w.page.getByTestId("rec-export").click();
    await w.page.getByTestId("rec-exported").waitFor();
    await expect(text(w.page, "rec-exported")).resolves.toMatch(/content hash \S{16,}/);
    await w.page.getByTestId("reconstruction").scrollIntoViewIfNeeded();
    await w.page.screenshot({ path: `${OUT}/w11-reconstruction.png`, fullPage: true });
    expect(await w.csp()).toEqual([]);
    await ctx.close();
  }, 300_000);

  it("W18: a deleted payload shows tombstone metadata only; the claim is flagged; foreign dereference is refused", async () => {
    const { ctx, page, csp } = await evidence("alice", `/w/${ws}/evidence?node=${ids.item}`);
    await page.getByTestId("evidence-record").waitFor({ timeout: 60_000 });
    await expect(page.getByTestId("evidence-record").getAttribute("data-tombstone")).resolves.toBe("true");
    await expect(text(page, "tombstone-reason")).resolves.toBe("legal retention limit reached");
    await expect(text(page, "tombstone-hash")).resolves.toMatch(/[0-9a-f]{16,}/);
    expect(await text(page, "node-inspector")).not.toContain("retained payload");
    await page.screenshot({ path: `${OUT}/w18-tombstone.png`, fullPage: true });
    await page.getByTestId(`list-node-${ids.itemClaim}`).click();
    await page.getByTestId("evidence-unavailable").waitFor();
    await expect(text(page, `ev-flag-${ids.itemClaim}`)).resolves.toContain("Evidence unavailable");
    expect(await csp()).toEqual([]);
    await ctx.close();

    // Tenant B cannot dereference tenant A's item through the BFF: same answer as a missing item.
    const b = await loggedIn(env, "bob");
    const bp = await b.newPage();
    await bp.goto(`${BASE}/w/${env.wsB}/evidence`);
    const codes = await bp.evaluate(
      async ([wsA, item]) => [
        (await fetch(`/api/k/workspaces/${wsA}/evidence/${item}`)).status,
        (await fetch(`/api/k/workspaces/${wsA}/evidence/${crypto.randomUUID()}`)).status,
        (await fetch(`/api/k/workspaces/${wsA}/publication-eligibility`)).status,
        (await fetch(`/api/k/workspaces/${wsA}/impact/prices.daily_close_price_usd`)).status,
        (await fetch(`/api/k/workspaces/${wsA}/revisions/1`)).status,
      ],
      [ws, ids.item] as const,
    );
    expect(codes).toEqual([404, 404, 404, 404, 404]);
    await b.close();
  }, 300_000);
});
