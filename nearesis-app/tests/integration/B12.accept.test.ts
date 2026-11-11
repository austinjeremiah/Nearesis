import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import {
  Dispatcher,
  SnapshotMismatch,
  contextHashes,
  reconcile,
  type Headline,
} from "../../plugins/near-thesis/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, q, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("B12: every agent works from the same question, snapshot, metric catalog and preregistration, and the headline number agrees across artifacts", async () => {
  if (await stopIfBlocked(s, "B12", "the real-stack flow")) return;
  const f = await runFlow(s);
  const d = f.dispatcher!;
  const ws = f.workspaceId;
  const read = (rel: string) => readFileSync(join(f.capsuleDir!, rel), "utf8");

  // (a) all child contexts carry equal question, snapshot, metric map and preregistration hashes
  expect(d.dispatched.length).toBeGreaterThanOrEqual(3);
  const first = d.dispatched[0]!.hashes;
  for (const x of d.dispatched) expect(x.hashes, x.child).toEqual(first);
  expect(first.preregistrationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.snapshotId).toBeTruthy();
  // and the runtime's own child identities agree on the snapshot and model version (real tasks rows)
  const kids = await q<{
    dedup_key: { inputSnapshot: string; modelVersion: string; investigationId: string; workspaceId: string };
  }>(s.env, s.env.tenantId, "SELECT dedup_key FROM tasks WHERE workspace_id=$1 AND depth=1 AND run_id=$2", [
    ws,
    f.runId,
  ]);
  expect(kids.length).toBeGreaterThanOrEqual(3);
  for (const k of kids) {
    expect(k.dedup_key.inputSnapshot).toBe(kids[0]!.dedup_key.inputSnapshot);
    expect(k.dedup_key.modelVersion).toBe(kids[0]!.dedup_key.modelVersion);
    expect(k.dedup_key.investigationId).toBe(kids[0]!.dedup_key.investigationId);
  }

  // (b) the headline values (verdict, delta MAE) agree across 6 artifacts the flow produced
  const snapId = first.snapshotId;
  const manifest = JSON.parse(read("manifest.json")) as { results: Array<{ id: string; value: string }> };
  const val = (id: string) => manifest.results.find((r) => r.id === id)?.value;
  const research = JSON.parse(read("research/research_run.json")) as {
    status: string;
    estimates: { primary: { delta_mae: number } };
  };
  const graph = (await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json as {
    nodes: Array<{ id: string; label: string }>;
  };
  const resultNode = graph.nodes.find((n) => n.id === f.graph!.result)!;
  const memo = readFileSync(join(f.capsuleDir!, "exports", "memo.pdf")).toString("latin1");
  const site = read("exports/site/index.html");
  const thesis = f.texts["THESIS.md"]!;
  const status = f.headline!.status;
  const delta = String(f.headline!.deltaMae);
  const heads: Headline[] = [
    {
      source: "quant result (research engine output)",
      metric: "verdict",
      value: status,
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "research_run.json in the capsule",
      metric: "verdict",
      value: research.status,
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "capsule results (THESIS table source)",
      metric: "verdict",
      value: val("research-status") ?? "",
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "evidence graph result node (skeptic/auditor view)",
      metric: "verdict",
      value: /verdict (\w+)/.exec(resultNode.label)?.[1] ?? "",
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "THESIS.md",
      metric: "verdict",
      value: new RegExp(`verdict is (${status})`).exec(thesis)?.[1] ?? "",
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "memo.pdf",
      metric: "verdict",
      value: new RegExp(`verdict is (${status})`).exec(memo)?.[1] ?? "",
      kind: "count",
      snapshotId: snapId,
    },
    {
      source: "capsule results",
      metric: "delta_mae",
      value: val("research-delta-mae") ?? "",
      kind: "derived",
      snapshotId: snapId,
    },
    {
      source: "research_run.json",
      metric: "delta_mae",
      value: String(research.estimates.primary.delta_mae),
      kind: "derived",
      snapshotId: snapId,
    },
    { source: "engine output", metric: "delta_mae", value: delta, kind: "derived", snapshotId: snapId },
  ];
  expect(
    heads.every((h) => h.value !== ""),
    heads
      .filter((h) => h.value === "")
      .map((h) => h.source)
      .join(","),
  ).toBe(true);
  const ok = reconcile(heads, snapId);
  expect(ok.conflicts).toEqual([]);
  expect(ok.included).toHaveLength(heads.length);
  expect(site.length).toBeGreaterThan(0);

  // (c) a child handed a different snapshot is rejected at dispatch, or flagged snapshot_mismatch and excluded
  expect(() => d.dispatch("composer", { snapshotId: "snap-other" })).toThrow(SnapshotMismatch);
  expect(d.dispatched.at(-1)!.accepted).toBe(false);
  const stray = reconcile(
    [
      ...heads,
      {
        source: "composer (older snapshot)",
        metric: "verdict",
        value: "MIXED",
        kind: "count",
        snapshotId: "snap-other",
      },
    ],
    snapId,
  );
  expect(stray.excluded).toEqual([
    expect.objectContaining({ flag: "snapshot_mismatch", source: "composer (older snapshot)" }),
  ]);
  expect(stray.conflicts).toEqual([]);

  // (d) disagreement within one snapshot becomes an explicit conflict record, never smoothed
  const cached = reconcile(
    [
      ...heads,
      {
        source: "composer (cached older result)",
        metric: "delta_mae",
        value: String(f.headline!.deltaMae! + 0.01),
        kind: "derived",
        snapshotId: snapId,
      },
    ],
    snapId,
  );
  expect(cached.conflicts).toHaveLength(1);
  expect(cached.conflicts[0]).toMatchObject({ metric: "delta_mae" });
  expect(cached.conflicts[0]!.values.map((v) => v.source)).toContain("composer (cached older result)");
  void Dispatcher;
  void contextHashes;

  observe({
    testId: "B12",
    fixtureHash: createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    observed: `${d.dispatched.length - 1} children dispatched by one dispatcher with identical question hash, snapshot ${snapId}, metric-version-map hash and preregistration hash; the runtime's ${kids.length} child task identities share inputSnapshot, modelVersion and investigation; headline verdict "${status}" and delta MAE ${delta} agree across ${heads.length} reads of 6 artifacts (engine output, research_run.json, capsule results, evidence graph node, THESIS.md, memo.pdf); a child asking for another snapshot was refused (snapshot_mismatch) and a stale artifact is excluded; a cached older delta MAE produced an explicit conflict record naming its source. Scope: the director's own task identity (5-tuple) does not carry the question and preregistration hashes, so the four-hash context is enforced by the dispatcher in the integration layer.`,
    evidence: { dispatched: d.dispatched, heads, conflicts: cached.conflicts },
  });
}, 900_000);
