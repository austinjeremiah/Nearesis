import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { checkPublication, canonicalJson } from "../../packages/capsule/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, stopIfBlocked, q, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("B01: a new workspace carries one question through panels, a marker, a subagent, evidence and a thesis on the real stack", async () => {
  if (await stopIfBlocked(s, "B01", "the real-stack flow")) return;
  const f = await runFlow(s);
  const why = f.trace.steps
    .filter((x) => x.status !== "completed")
    .map((x) => `${x.name}:${x.status}:${x.reason_code}:${x.detail}`)
    .join(" | ");
  const ws = f.workspaceId;
  const done = (n: string) => f.trace.steps.find((x) => x.name === n)!.status;
  // question -> panels
  for (const n of ["plan", "execute", "compose"]) expect(done(n), why).toBe("completed");
  const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
    panels: Array<{ panelId: string; queryRef: { hash: string }; provenanceRequired: boolean }>;
    markers: Array<{ markerId: string; panelId: string; status: string }>;
  };
  expect(canvas.panels.length).toBeGreaterThanOrEqual(1);
  for (const p of canvas.panels) {
    expect(p.queryRef.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.provenanceRequired).toBe(true);
  }
  // panels -> marker -> subagent
  expect(done("investigate")).toBe("completed");
  const marker = (await s.owner.call("GET", `/v1/workspaces/${ws}/markers/${f.markerId}`)).json as {
    status: string;
    sourcePanelId: string;
  };
  expect(marker.status).toBe("REVIEW_REQUIRED");
  expect(canvas.panels.map((p) => p.panelId)).toContain(marker.sourcePanelId);
  const mtasks = (await s.owner.call("GET", `/v1/workspaces/${ws}/markers/${f.markerId}/tasks`)).json as {
    tasks: Array<{ taskId: string; runId: string; status: string }>;
  };
  expect(mtasks.tasks).toHaveLength(1);
  const sub = await q<{ role: string; status: string }>(
    s.env,
    s.env.tenantId,
    "SELECT role, status FROM tasks WHERE run_id=$1 AND depth=1",
    [mtasks.tasks[0]!.runId],
  );
  expect(sub.length).toBeGreaterThan(0);
  expect(sub.every((t) => t.status === "DONE")).toBe(true);
  // subagent -> evidence: the evidence graph carries claim <- result <- model <- query <- raw snapshot
  const g = (await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json as {
    nodes: Array<{ id: string; type: string }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  };
  const gr = f.graph!;
  for (const id of Object.values(gr))
    expect(
      g.nodes.some((n) => n.id === id),
      id,
    ).toBe(true);
  expect(
    g.edges.some((e) => e.source === gr.result && e.target === gr.claim && e.relation === "supports"),
  ).toBe(true);
  expect(g.nodes.filter((n) => n.type === "agent").length).toBeGreaterThanOrEqual(3);
  // evidence -> thesis: every number in the published thesis cites a computed result
  expect(done("publish")).toBe("completed");
  const thesis = f.texts["THESIS.md"]!;
  expect(thesis).toContain("## Claims");
  const manifest = JSON.parse(
    (await import("node:fs")).readFileSync(`${f.capsuleDir}/manifest.json`, "utf8"),
  ) as { results: Array<{ id: string; value: string }>; capsuleHash: string };
  const pub = checkPublication(thesis, manifest.results);
  expect(pub.ok).toBe(true);
  expect(pub.numbersChecked).toBeGreaterThan(5);

  // negative control: a marker on a panel that does not exist is refused (the chain cannot skip the panel step)
  const bogus = await s.owner.call("POST", `/v1/workspaces/${ws}/markers`, {
    panelId: crypto.randomUUID(),
    anchor: { kind: "time_range", start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" },
    question: "[scenario=basic] ghost",
  });
  expect(bogus.status).toBeGreaterThanOrEqual(400);

  observe({
    testId: "B01",
    fixtureHash: createHash("sha256").update(canonicalJson(manifest.results)).digest("hex"),
    observed: `one workspace ${ws.slice(0, 8)} on the real stack (real kernel, API, Temporal worker with scripted inference, near-thesis plugin, research engine, capsule): question -> ${canvas.panels.length} persisted panel(s) with query hashes -> marker ${marker.status} on that panel -> ${sub.length} subagent task(s) DONE (scoped, 1 marker task) -> evidence graph nodes ${Object.keys(gr).join("/")} with supports edge and ${g.nodes.filter((n) => n.type === "agent").length} agent nodes -> THESIS.md with ${pub.numbersChecked} numbers all cited and passing the publication check (capsule ${manifest.capsuleHash.slice(0, 12)}). Marker on a missing panel refused (HTTP ${bogus.status}). Trace: ${f.trace.steps.map((x) => `${x.name}:${x.status}`).join(" ")}.`,
    evidence: {
      trace: f.trace.steps.map((x) => ({ name: x.name, status: x.status, mode: x.mode })),
      panels: canvas.panels.map((p) => p.queryRef.hash),
      graph: gr,
      numbersChecked: pub.numbersChecked,
    },
  });
}, 600_000);
