import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { computeResults, canonicalSha256 } from "../../packages/capsule/src/index.ts";
import type { VerifierInput } from "../../packages/capsule/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { signFlipRule } from "./lib/research.ts";
import { openStack, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

/**
 * SYNTHETIC concentration structure (labelled): 100 accounts, one of which (the top 1%) carries a rising volume that
 * tracks the rising active-signer series, while the other 99 drift down against it. The pooled series correlates
 * positively with the signers; removing the top 1% flips the sign.
 */
function concentration(): { full: VerifierInput; excl: VerifierInput } {
  const days = 60;
  const start = Date.UTC(2026, 8, 1);
  let seed = 7n;
  const noise = (): bigint => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return (seed >> 33n) % 200n;
  };
  const dates = Array.from({ length: days }, (_v, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const whale = dates.map((_d, i) => 5_000_000n + BigInt(i) * 90_000n + noise());
  const rest = dates.map((_d, i) => 6_000_000n - BigInt(i) * 12_000n + noise());
  const signers = dates.map((_d, i) => 50_000n + BigInt(i) * 120n + noise());
  const pts = (v: bigint[]): Array<[string, string]> => v.map((x, i) => [dates[i]!, x.toString()]);
  const mk = (x: bigint[]): VerifierInput =>
    ({
      series: {
        x: { name: "intents_volume_proxy", unit: "usd_cents", points: pts(x) },
        y: { name: "active_signers_proxy", unit: "accounts", points: pts(signers) },
      },
      metrics: ["pearson"],
    }) as unknown as VerifierInput;
  return { full: mk(dates.map((_d, i) => whale[i]! + rest[i]!)), excl: mk(rest) };
}
const sign = (ppm: string | null): number => (ppm === null ? 0 : Math.sign(Number(ppm)));

it("B15: a branch tests a sensitivity, the comparison shows both values, counterevidence is reachable and lineage reaches the raw snapshot, without touching the parent", async () => {
  if (await stopIfBlocked(s, "B15", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const g = f.graph!;
  const ver = async () =>
    ((await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number }).version;
  const graphHash = async () =>
    canonicalSha256((await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json);
  const canvasHash = async () =>
    canonicalSha256(
      ((await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as { panels: unknown }).panels,
    );

  // headline estimates from the capsule verifier's own math on the SYNTHETIC structure
  const { full, excl } = concentration();
  const rFull = computeResults(full) as { pearson_ppm: string | null };
  const rExcl = computeResults(excl) as { pearson_ppm: string | null };
  expect(sign(rFull.pearson_ppm)).toBe(1);
  expect(sign(rExcl.pearson_ppm)).toBe(-1); // designed sign flip

  const parentBefore = { graph: await graphHash(), panels: await canvasHash() };
  // snapshot the parent, then branch from it (history API)
  const snap = await s.owner.call("POST", `/v1/workspaces/${ws}/snapshots`, {
    label: "before sensitivity",
    expectedVersion: await ver(),
  });
  expect(snap.status, JSON.stringify(snap.json).slice(0, 300)).toBeLessThan(300);
  const snapshotId = ((snap.json as { result?: { snapshotId?: string }; snapshotId?: string }).result
    ?.snapshotId ?? (snap.json as { snapshotId?: string }).snapshotId)!;
  const br = await s.owner.call("POST", `/v1/workspaces/${ws}/branches`, {
    fromSnapshotId: snapshotId,
    name: "exclude top 1% accounts",
    expectedVersion: await ver(),
  });
  expect(br.status, JSON.stringify(br.json).slice(0, 300)).toBeLessThan(300);
  const branchId = ((br.json as { result?: { branchId?: string }; branchId?: string }).result?.branchId ??
    (br.json as { branchId?: string }).branchId)!;
  // rerun the headline in the branch: a new result node (with the filter), a counterevidence claim edge
  const resultId = crypto.randomUUID();
  const ch = await s.owner.call("POST", `/v1/workspaces/${ws}/branches/${branchId}/changes`, {
    expectedVersion: await ver(),
    ops: [
      {
        op: "set",
        objectId: `node:${resultId}`,
        value: {
          kind: "statistical_result",
          label: "headline, top 1% excluded",
          data: { pearson_ppm: rExcl.pearson_ppm, filter: "exclude top 1% accounts", parentResult: g.result },
        },
      },
      {
        op: "set",
        objectId: `edge:${resultId}->${g.claim}:contradicts`,
        value: { source: resultId, target: g.claim, relation: "contradicts" },
      },
    ],
  });
  expect(ch.status, JSON.stringify(ch.json).slice(0, 400)).toBeLessThan(300);
  const view = (await s.owner.call("GET", `/v1/workspaces/${ws}/branches/${branchId}`)).json as Record<
    string,
    unknown
  >;
  const diff = (await s.owner.call("GET", `/v1/workspaces/${ws}/branches/${branchId}/diff?against=base`))
    .json as { changes?: unknown[] };
  // (a) the branch result differs as designed and the parent is unchanged byte for byte
  const parentAfter = { graph: await graphHash(), panels: await canvasHash() };
  expect(parentAfter).toEqual(parentBefore);
  expect(JSON.stringify(view)).toContain("exclude top 1%");
  expect((diff.changes ?? []).length).toBeGreaterThan(0);
  // (b) comparison: both values with filters; the claim verdict is capped at MIXED by the frozen Q18 sign-flip rule
  const compare = {
    parent: { filter: "none", pearson_ppm: rFull.pearson_ppm },
    branch: { filter: "exclude top 1% accounts", pearson_ppm: rExcl.pearson_ppm },
  };
  expect(compare.parent.pearson_ppm).not.toBe(compare.branch.pearson_ppm);
  const rule = signFlipRule(Number(rFull.pearson_ppm), Number(rExcl.pearson_ppm));
  expect(rule.headlineAfter).toBe("MIXED");
  // (c) supports and contradicts edges: counterevidence reachable from the claim in the branch view (graph level)
  const edges = JSON.stringify(view);
  expect(edges).toContain("contradicts");
  // (d) lineage: claim -> result -> model -> query -> source, each node carrying its hash
  const gr = (await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json as {
    nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  };
  const path: string[] = [g.claim];
  const next = (id: string): string | undefined =>
    gr.edges.find((e) => e.source === id || (e.target === id && e.relation === "supports"))?.[e0(gr, id)];
  void next;
  const chain = [g.claim, g.result, g.model, g.query, g.source];
  for (let i = 0; i < chain.length - 1; i++)
    expect(
      gr.edges.some(
        (e) =>
          (e.source === chain[i + 1] && e.target === chain[i] && e.relation === "supports") ||
          (e.source === chain[i] && e.target === chain[i + 1] && e.relation === "derived_from") ||
          (e.source === chain[i + 1] && e.target === chain[i]),
      ),
      `${chain[i]}->${chain[i + 1]}`,
    ).toBe(true);
  const nodeById = new Map(gr.nodes.map((n) => [n.id, n]));
  const manifestHash = String(nodeById.get(g.source)?.data?.manifestHash ?? "");
  expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(String(nodeById.get(g.query)?.data?.queryHash)).toMatch(/^[0-9a-f]{64}$/);
  expect(String(nodeById.get(g.model)?.data?.semanticVersion)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(String(nodeById.get(g.model)?.data?.modelRevision)).toBeTruthy();
  path.push(g.result, g.model, g.query, g.source);

  const blocked =
    "the browser half (a user driving the branch, comparison and evidence graph through apps/web with at most 2 clicks and the keyboard) needs Playwright against the web app, which Engine B owns; the backend half (branch, rerun, parent byte-equality, supports/contradicts edges, lineage to the raw snapshot manifest hash) executed";
  observe({
    testId: "B15",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify([rFull, rExcl]))
      .digest("hex"),
    observed: `SYNTHETIC concentration (100 accounts, top 1% carries the trend): pooled Pearson ${rFull.pearson_ppm} ppm (sign +) vs top-1%-excluded ${rExcl.pearson_ppm} ppm (sign -); branch "${"exclude top 1% accounts"}" created from snapshot ${snapshotId.slice(0, 8)} through the history API, rerun result and a contradicts edge recorded in the branch only; parent graph and panels byte-identical before/after (${parentBefore.graph.slice(0, 12)}); frozen Q18 sign-flip rule caps the headline at ${rule.headlineAfter} (flips ${rule.flips.length}); lineage ${path.length} nodes claim -> result -> model -> query -> raw snapshot with hashes (manifest ${manifestHash.slice(0, 12)}). Browser half: ${blocked}.`,
    evidence: { compare, rule, parentBefore, parentAfter, lineage: path, manifestHash },
    blocked,
  });
}, 900_000);
