import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { createActivities } from "../../packages/workflow/src/index.ts";
import { h, reconcile, type Headline } from "../../plugins/near-thesis/src/index.ts";
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
  const d = f.dispatch!;
  const ws = f.workspaceId;
  const read = (rel: string) => readFileSync(join(f.capsuleDir!, rel), "utf8");

  // (a) the real workflow froze the run's context and stamped every child task it dispatched with exactly that context
  expect(d.children.length).toBeGreaterThanOrEqual(3);
  for (const c of d.children) expect(c.context, c.role).toEqual(d.run);
  expect(d.run.question).toBe(h(f.postedQuestion));
  expect(d.run.preregistrationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(d.run.preregistrationHash).toBe(
    f.events.find((e) => e.kind === "preregistration.frozen")!.data.preregistrationHash,
  );
  const runRow = (
    await q<{ snapshot_ref: string }>(s.env, s.env.tenantId, "SELECT snapshot_ref FROM runs WHERE id=$1", [
      f.runId,
    ])
  )[0]!;
  expect(d.run.snapshotId).toBe(runRow.snapshot_ref);
  expect(d.run.metricVersionMap).toMatch(/^[0-9a-f]{64}$/);
  const first = d.run;
  // the same context is exposed on the run API
  const api = (await s.owner.call("GET", `/v1/runs/${f.runId}`)).json as {
    source: string;
    context: Record<string, string> | null;
  };
  expect(api.context).toEqual(d.run);
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

  // (c) a child handed a different question, snapshot, metric map or preregistration is refused by the real dispatch path
  // (the same `spawnTask` activity the workflow calls); its attempt is audited and no task row is created
  const acts = createActivities(s.worker.deps);
  const base = (
    await q<{ id: string; budget_id: string; investigation_id: string }>(
      s.env,
      s.env.tenantId,
      "SELECT t.id, r.budget_id, r.investigation_id FROM tasks t JOIN runs r ON r.id=t.run_id WHERE t.run_id=$1 AND t.depth=0",
      [f.runId],
    )
  )[0]!;
  const taskCount = async () =>
    Number(
      (
        await q<{ n: string }>(s.env, s.env.tenantId, "SELECT count(*)::text n FROM tasks WHERE run_id=$1", [
          f.runId,
        ])
      )[0]!.n,
    );
  const before = await taskCount();
  const refused: Array<{ field: string; reason: unknown }> = [];
  for (const field of ["question", "snapshotId", "metricVersionMap", "preregistrationHash"] as const) {
    const bad = { ...first, [field]: field === "snapshotId" ? "snap-other" : "sha256:" + "0".repeat(64) };
    const err = await acts
      .spawnTask({
        tenantId: s.env.tenantId,
        workspaceId: ws,
        runId: f.runId!,
        budgetId: base.budget_id,
        investigationId: base.investigation_id,
        parentTaskId: base.id,
        modelVersion: "scripted-1",
        child: {
          task: `rogue-${field}`,
          role: "composer",
          objective: "uses a different input",
          capabilities: [],
          inputSnapshot: "snap-other",
          budget: { tokens: 1, toolCalls: 1, usd: 0 },
          maxChildDepth: 0,
          context: bad,
        },
      })
      .then(
        () => null,
        (e: unknown) => e as { type?: string; message?: string },
      );
    expect(err, field).not.toBeNull();
    expect(err!.type).toBe("CONTEXT_MISMATCH");
    expect(err!.message).toContain(field);
    refused.push({ field, reason: err!.type });
  }
  expect(await taskCount()).toBe(before);
  const audited = await q<{ n: string }>(
    s.env,
    s.env.tenantId,
    "SELECT count(*)::text n FROM agent_audit WHERE run_id=$1 AND kind='spawn.rejected' AND reason_code='CONTEXT_MISMATCH'",
    [f.runId],
  );
  expect(Number(audited[0]!.n)).toBe(4);
  // an artifact tagged with another snapshot is flagged and excluded from the thesis
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

  observe({
    testId: "B12",
    fixtureHash: createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    observed: `the real workflow froze one context for the run (question hash, snapshot ${snapId}, metric-version-map hash, preregistration hash) and stamped all ${d.children.length} dispatched children with exactly it (read back from the runtime tables and GET /v1/runs/:id); the runtime's ${kids.length} child task identities share inputSnapshot, modelVersion and investigation; headline verdict "${status}" and delta MAE ${delta} agree across ${heads.length} reads of 6 artifacts (engine output, research_run.json, capsule results, evidence graph node, THESIS.md, memo.pdf); the real spawnTask dispatch refused a child whose question, snapshot, metric-version-map or preregistration hash differed (4 of 4 refused with CONTEXT_MISMATCH, 4 audit rows, 0 task rows created) and a stale artifact is excluded; a cached older delta MAE produced an explicit conflict record naming its source.`,
    evidence: { dispatch: d, refused, heads, conflicts: cached.conflicts },
  });
}, 900_000);
