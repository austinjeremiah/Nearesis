/**
 * C16 — React Flow evidence graph renders persisted, typed nodes only; layout edits persist. PASS: (a) rendered node
 * and edge sets equal the kernel projection (ids and types) minus invalid edges, which are reported in a visible
 * "unresolved references" notice; (b) only registered node types are instantiated; (c) moved positions persist after
 * reload within 1 px; (d) every node is keyboard reachable with an accessible name; (e) dragging creates no evidence
 * edges. Real kernel (graph projection API + graph.save_layout command + Postgres) and the production web build.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { PanelSpec } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";
import { runCmd } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const SC = loadScenario("graph");
const PANELS = (SC.document as { panels: PanelSpec[] }).panels;
const NODE_TYPES = ["hypothesis", "observation", "query", "model", "source", "marker", "agent"];

type H = {
  __nearesis: {
    ready: boolean;
    instantiated: string[];
    graph: { rendered: string[]; edges: string[]; unresolved: Array<{ id: string; reason: string }> };
    graphLayoutSaved?: Record<string, { x: number; y: number }>;
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

async function renderedNodes(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")].map((n) => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((n as HTMLElement).style.transform);
      return {
        id: n.getAttribute("data-id")!,
        type:
          [...n.classList]
            .find((c) => c.startsWith("react-flow__node-") && c !== "react-flow__node-default")
            ?.slice(17) ?? "",
        label: n.getAttribute("aria-label"),
        x: m ? Number(m[1]) : NaN,
        y: m ? Number(m[2]) : NaN,
      };
    }),
  );
}

describe("C16 evidence graph", () => {
  it("renders the persisted projection, reports invalid references, persists layout, and creates no edges", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", PANELS);
    const s = await env.session("alice");
    const org = (await env.db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [ws])).rows[0]
      .org_id as string;
    const dataPanels = PANELS.filter((p) => p.kind !== "evidenceGraph");
    const graphPanel = PANELS.find((p) => p.kind === "evidenceGraph")!;

    // Persisted entities: 1 marker on panel 1 (real command), hypothesis, 2 sources, 4 agents (evidence_nodes).
    const version = (await env.kernel.workspaces.get(s, ws)).version;
    const markerId = crypto.randomUUID();
    await runCmd(
      env.kernel,
      s,
      ws,
      "marker.create",
      {
        panelId: dataPanels[0]!.panelId,
        markerId,
        anchor: { kind: "time_point", at: "2026-10-27T00:00:00Z" },
      },
      version,
    );
    const node = async (kind: string, label: string) => {
      const id = crypto.randomUUID();
      await env.db.admin.query(
        "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,$4,$5)",
        [id, org, ws, kind, label],
      );
      return id;
    };
    const edge = async (from: string, to: string, relation: string) => {
      const id = crypto.randomUUID();
      await env.db.admin.query(
        "INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, org, ws, from, to, relation],
      );
      return id;
    };
    const h1 = await node("hypothesis", "Private settlement did not reduce 1Click activity");
    const s1 = await node("source", "NEAR Intents Explorer");
    const s2 = await node("source", "NEAR BigQuery");
    const agents: string[] = [];
    for (const r of ["scout", "statistics", "skeptic", "auditor"])
      agents.push(await node("agent", `${r} agent`));
    const q = dataPanels.map((p) => p.panelId);
    // 11 stored valid edges + 1 derived marker->panel reference = 12 valid edges.
    await edge(q[0]!, h1, "supports");
    await edge(q[1]!, h1, "supports");
    await edge(q[2]!, h1, "contradicts");
    await edge(q[3]!, h1, "references");
    await edge(q[0]!, s1, "derived_from");
    await edge(q[1]!, s1, "derived_from");
    await edge(q[2]!, s2, "derived_from");
    await edge(q[3]!, s2, "derived_from");
    await edge(agents[0]!, markerId, "monitors");
    await edge(agents[2]!, q[2]!, "reproduces");
    await edge(agents[3]!, q[0]!, "reproduces");
    // Invalid inputs: an edge to a non-existent node (stored; reported by the projection), and an `owns` edge, which the
    // schema CHECK refuses to store at all (asserted) and which is injected into the projection response on the wire to
    // exercise the client validator.
    const ghost = await edge(agents[1]!, crypto.randomUUID(), "supports");
    let ownsRejected = "";
    try {
      await edge(agents[1]!, q[1]!, "owns");
    } catch (e) {
      ownsRejected = String((e as { message?: string }).message);
    }
    expect(ownsRejected).toMatch(/evidence_edges_relation_check|check constraint/i);

    const projection = await env.kernel.graph.get(s, ws);
    const edgesBefore = Number(
      (await env.db.admin.query("SELECT count(*) n FROM evidence_edges WHERE workspace_id=$1", [ws])).rows[0]
        .n,
    );
    expect(projection.edges).toHaveLength(12);
    expect(projection.unresolved.map((u) => u.id)).toEqual([ghost]);
    expect(projection.nodes.filter((n) => n.type === "query")).toHaveLength(5); // 4 data panels + the graph panel itself

    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    await page.route(`**/api/k/workspaces/${ws}/graph`, async (route) => {
      const r = await route.fetch();
      const body = (await r.json()) as { edges: unknown[] };
      body.edges.push({
        id: "injected-owns",
        source: agents[1],
        target: q[1],
        relation: "owns",
        origin: "stored",
      });
      await route.fulfill({ response: r, json: body });
    });
    await page.goto(`${BASE}/w/${ws}?backend=kernel`);
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    await page.locator(`[data-testid='panel-${graphPanel.panelId}'] .react-flow__node`).first().waitFor();
    await page.waitForTimeout(500);

    // (a) rendered == projection minus invalid; (b) registered types only.
    const nodes = await renderedNodes(page);
    const hk = await page.evaluate(() => (window as unknown as H).__nearesis);
    const notice = (await page.locator("[data-testid='unresolved-references']").textContent())!;
    await page.screenshot({ path: "test-results/C16-graph.png", fullPage: true });
    const expectedNodes = projection.nodes.map((n) => `${n.id}:${n.type}`).sort();
    expect(nodes.map((n) => `${n.id}:${n.type}`).sort()).toEqual(expectedNodes);
    expect([...hk.graph.edges].sort()).toEqual(projection.edges.map((e) => e.id).sort());
    expect(hk.graph.edges).not.toContain("injected-owns");
    expect(await page.locator(".react-flow__edge").count()).toBe(projection.edges.length);
    expect(notice).toContain("2 unresolved reference(s)");
    expect(notice).toContain(ghost);
    expect(notice).toContain("injected-owns");
    expect(notice).toMatch(/invalid relation "owns"/);
    expect(hk.graph.unresolved.map((u) => u.id).sort()).toEqual([ghost, "injected-owns"].sort());
    const graphTypes = new Set(hk.instantiated.filter((i) => i.startsWith("graph:")).map((i) => i.slice(6)));
    for (const t of graphTypes) expect(NODE_TYPES).toContain(t);
    for (const n of nodes) expect(NODE_TYPES).toContain(n.type);

    // (d) keyboard reachability: Tab through the graph; each node announces `type: label`.
    const reached = new Set<string>();
    await page.locator(".react-flow__node").first().focus();
    for (let i = 0; i < nodes.length + 4; i++) {
      const a = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { id: el?.getAttribute("data-id") ?? null, name: el?.getAttribute("aria-label") ?? null };
      });
      if (a.id) {
        reached.add(a.id);
        expect(a.name && a.name.length > 3).toBe(true);
      }
      await page.keyboard.press("Tab");
    }
    expect([...reached].sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const n of nodes)
      expect(n.label).toBe(`${n.type}: ${projection.nodes.find((x) => x.id === n.id)!.label}`);

    // Drag 2 nodes (layout save is issued on drag stop through the kernel command).
    const targets = [nodes.find((n) => n.type === "hypothesis")!, nodes.find((n) => n.id === s2)!];
    for (const [i, t] of targets.entries()) {
      const loc = page.locator(`.react-flow__node[data-id='${t.id}']`);
      await loc.scrollIntoViewIfNeeded();
      const b = (await loc.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 90 + i * 20, b.y + b.height / 2 + 50, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(
      (ids) => ids.every((id) => (window as unknown as H).__nearesis.graphLayoutSaved?.[id]),
      targets.map((t) => t.id),
    );
    const afterDrag = await renderedNodes(page);
    const row = (await env.db.admin.query("SELECT positions FROM graph_layouts WHERE workspace_id=$1", [ws]))
      .rows[0].positions as Record<string, { x: number; y: number }>;
    for (const t of targets) {
      const moved = afterDrag.find((n) => n.id === t.id)!;
      expect(Math.hypot(moved.x - t.x, moved.y - t.y)).toBeGreaterThan(20);
      expect(Math.abs(row[t.id]!.x - moved.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(row[t.id]!.y - moved.y)).toBeLessThanOrEqual(1);
    }

    // (c) reload: positions come back from the persisted layout within 1 px.
    await page.reload();
    await page.waitForFunction(() => (window as unknown as H).__nearesis?.ready === true);
    await page.locator(".react-flow__node").first().waitFor();
    await page.waitForTimeout(500);
    const reloaded = await renderedNodes(page);
    const positionDiffs = targets.map((t) => {
      const a = afterDrag.find((n) => n.id === t.id)!;
      const b = reloaded.find((n) => n.id === t.id)!;
      return { id: t.id, type: t.type, savedAt: { x: a.x, y: a.y }, afterReload: { x: b.x, y: b.y } };
    });
    for (const d of positionDiffs) {
      expect(Math.abs(d.savedAt.x - d.afterReload.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(d.savedAt.y - d.afterReload.y)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: "test-results/C16-graph-reloaded.png", fullPage: true });

    // (e) dragging created no evidence edges and did not alter the projection's edges.
    const edgesAfter = Number(
      (await env.db.admin.query("SELECT count(*) n FROM evidence_edges WHERE workspace_id=$1", [ws])).rows[0]
        .n,
    );
    const projectionAfter = await env.kernel.graph.get(s, ws);
    expect(edgesAfter).toBe(edgesBefore);
    expect(projectionAfter.edges.map((e) => e.id).sort()).toEqual(projection.edges.map((e) => e.id).sort());
    await ctx.close();

    observe({
      testId: "C16",
      observed: `rendered ${nodes.length} nodes / ${hk.graph.edges.length} edges equal the kernel projection (ids and types) minus 2 unresolved references (edge to missing node ${ghost.slice(0, 8)}, injected relation "owns" which the schema also refuses to store), both listed in the visible notice; only registered types instantiated (${[...graphTypes].sort().join(",")}); all ${reached.size} nodes reached by Tab with accessible names; 2 dragged nodes persisted via graph.save_layout and restored within 1 px after reload (${positionDiffs.map((d) => `${d.type}: ${d.savedAt.x},${d.savedAt.y} -> ${d.afterReload.x},${d.afterReload.y}`).join("; ")}); evidence_edges count unchanged at ${edgesAfter}`,
      fixtureHash: hashCanonical({
        nodes: expectedNodes,
        edges: projection.edges.map((e) => e.relation).sort(),
      }),
      evidence: {
        projection,
        rendered: nodes,
        notice,
        layoutRow: row,
        positionDiffs,
        edgesBefore,
        edgesAfter,
        ownsRejected,
      },
    });
  }, 300_000);
});
