import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { dependentIndex, traverseDependents } from "../../src/history/impact.ts";
import type { DepEdge } from "../../src/history/impact.ts";
import { addEdge, addNode, newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w09")));
afterAll(async () => w?.db.drop());

const CHAIN_BUDGET_MS = 15_000; // declared time budget for the 5,000-node chain

it("W09: impact analysis is complete, cycle-safe, ACL-aware and bounded", async () => {
  const { workspaceId } = await newWs(w);
  const M = "intents";
  const pin = { semanticPins: { [M]: "1.1.0" } };
  const n = async (label: string, kind = "statistical_result", extra: object = {}) =>
    addNode(w, workspaceId, kind, label, extra);
  const R = await n("R", "statistical_result", pin);
  const A = await n("A");
  const B = await n("B");
  const C = await n("C");
  const D = await n("D");
  const E = await n("E");
  const F = await n("F");
  const G = await n("G");
  const H = await n("H");
  const I = await n("I", "claim");
  const K = await n("K");
  const L = await n("L");
  const X = await n("X", "statistical_result", { semanticPins: { fee_rate: "1.0.0" } });
  const Y = await n("Y");
  const U = await n("U", "observation");
  const V = await n("V", "observation");
  const W = await n("W", "claim");
  const names: Record<string, string> = { R, A, B, C, D, E, F, G, H, I, K, L, X, Y, U, V, W };
  const name = (id: string) => Object.keys(names).find((k) => names[k] === id) ?? id;
  const dep = (from: string, to: string, rel = "derived_from") => addEdge(w, workspaceId, from, to, rel);
  // 5 levels with diamond joins (D from A and B, F from C and D, I from G and H).
  await dep(A, R);
  await dep(B, R);
  await dep(C, A);
  await dep(D, A);
  await dep(D, B);
  await dep(E, D);
  await dep(F, C);
  await dep(F, D);
  await dep(G, E);
  await dep(H, F);
  await dep(I, G);
  await dep(I, H);
  await dep(K, B);
  await dep(L, K);
  // The deliberate cycle is closed by a `references` edge: R depends on I, I depends (through the chain) on R.
  await dep(R, I, "references");
  // An independent subgraph, and a node that only contradicts R (a contradiction is not a dependency).
  await dep(Y, X);
  await dep(V, U);
  await dep(W, R, "contradicts");

  // A foreign tenant's node pins the same metric name: it must never appear in this workspace's result.
  const foreign = await newWs(w, w.outsider);
  const asset = randomUUID();
  await w.db.admin.query("INSERT INTO public_assets(id, content_hash, title) VALUES ($1,$2,'shared')", [
    asset,
    "c".repeat(64),
  ]);
  const fNode = (
    await w.h.graphOps.addNode(w.outsider, foreign.workspaceId, {
      expectedVersion: await wsVersion(w, foreign.workspaceId),
      kind: "statistical_result",
      label: "foreign",
      semanticPins: { [M]: "1.1.0" },
      data: { publicAssetId: asset },
    })
  ).result.nodeId as string;

  // Restrict B (and K, L which depend only on B). Alice (owner) keeps access; ann (analyst) gets none.
  await w.h.graphOps.setRestriction(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: B,
    restricted: true,
    grantUserIds: [],
  });
  await w.h.graphOps.setRestriction(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: K,
    restricted: true,
    grantUserIds: [],
  });

  // Step 1: mark intents@1.2.0 changed (cap 3 to prove bounded revalidation).
  const change = await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: M,
    toVersion: "1.2.0",
    revalidationCap: 3,
  });

  const expectedFull = ["R", "A", "B", "C", "D", "E", "F", "G", "H", "I", "K", "L"]
    .map((k) => names[k]!)
    .sort();

  // Step 2: member / restricted member / outsider.
  const member = await w.h.impact.impact(w.owner, workspaceId, { metricId: M });
  const ids = member.affected.map((a) => a.nodeId);
  // (a) exact, each node once.
  expect([...ids].sort()).toEqual(expectedFull);
  expect(new Set(ids).size).toBe(ids.length);
  // (d) unrelated subgraph and the contradicting node are not flagged.
  for (const k of ["X", "Y", "U", "V", "W"]) expect(ids).not.toContain(names[k]);
  expect(new Set(change.result.flaggedNodeIds)).toEqual(new Set(expectedFull));
  // (b) the cycle terminates and is reported, not silently cut.
  expect(member.cycles.length).toBe(1);
  expect(member.cycles[0]).toEqual(
    ["R", "A", "B", "C", "D", "E", "F", "G", "H", "I"].map((k) => names[k]!).sort(),
  );

  // (c) restricted member: B, K, L omitted without a trace; outsider: 404 identical to a nonexistent workspace.
  const restricted = await w.h.impact.impact(w.analyst, workspaceId, { metricId: M });
  const rIds = restricted.affected.map((a) => a.nodeId).sort();
  expect(rIds).toEqual(expectedFull.filter((id) => ![B, K, L].includes(id)).sort());
  const raw = JSON.stringify(restricted);
  for (const hid of [B, K, L]) expect(raw).not.toContain(hid);
  // The cycle still exists through A, so it is reported - but without hidden B in it.
  expect(restricted.cycles).toEqual([
    ["R", "A", "C", "D", "E", "F", "G", "H", "I"].map((k) => names[k]!).sort(),
  ]);
  const outsider = await rejection(w.h.impact.impact(w.outsider, workspaceId, { metricId: M }));
  const missing = await rejection(w.h.impact.impact(w.outsider, randomUUID(), { metricId: M }));
  expect([outsider.code, outsider.reasonCode, outsider.message]).toEqual([
    missing.code,
    missing.reasonCode,
    missing.message,
  ]);
  const foreignOwn = await w.h.impact.impact(w.outsider, foreign.workspaceId, { metricId: M });
  expect(foreignOwn.affected.map((a) => a.nodeId)).toEqual([fNode]);
  expect(ids).not.toContain(fNode);
  const restrictedStatus = await w.h.impact.revalidationStatus(w.analyst, workspaceId);
  const fullStatus = await w.h.impact.revalidationStatus(w.owner, workspaceId);

  // (e) bounded revalidation: cap 3 -> 3 created, the remaining 9 queued with a visible count.
  expect(change.result.revalidation).toEqual({ created: 3, queued: expectedFull.length - 3, cap: 3 });
  expect(fullStatus).toEqual({ created: 3, queued: expectedFull.length - 3, done: 0 });
  expect(restrictedStatus.created + restrictedStatus.queued).toBe(expectedFull.length - 3); // hidden nodes uncounted

  // Depth bound.
  const bounded = await w.h.impact.impact(w.owner, workspaceId, { metricId: M, maxDepth: 2 });
  expect(Math.max(...bounded.affected.map((a) => a.depth))).toBe(2);
  expect(bounded.truncated).toBe(true);
  expect(bounded.affected.length).toBeLessThan(member.affected.length);

  // 5,000-node synthetic chain: finishes within the declared budget, no stack exhaustion.
  const chain = await newWs(w);
  const N = 5000;
  const nodeIds = Array.from({ length: N }, () => randomUUID());
  await w.db.admin.query(
    `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, semantic_pins)
     SELECT u.id, $1, $2, 'statistical_result', 'c' || u.ord, CASE WHEN u.ord = 1 THEN '{"intents":"1.1.0"}'::jsonb ELSE '{}'::jsonb END
       FROM unnest($3::uuid[]) WITH ORDINALITY AS u(id, ord)`,
    [w.orgA.orgId, chain.workspaceId, nodeIds],
  );
  await w.db.admin.query(
    `INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation, created_by)
     SELECT gen_random_uuid(), $1, $2, a.id, b.id, 'derived_from', $4
       FROM unnest($3::uuid[]) WITH ORDINALITY AS a(id, ord)
       JOIN unnest($3::uuid[]) WITH ORDINALITY AS b(id, ord) ON b.ord = a.ord - 1`,
    [w.orgA.orgId, chain.workspaceId, nodeIds, w.owner.userId],
  );
  const t0 = Date.now();
  const longChange = await w.h.graphOps.changeSemanticVersion(w.owner, chain.workspaceId, {
    expectedVersion: await wsVersion(w, chain.workspaceId),
    metricId: M,
    toVersion: "1.2.0",
  });
  const longImpact = await w.h.impact.impact(w.owner, chain.workspaceId, { metricId: M });
  const elapsed = Date.now() - t0;
  expect(longChange.result.flaggedCount).toBe(N);
  expect(longChange.result.revalidation).toEqual({ created: 100, queued: N - 100, cap: 100 });
  expect(longImpact.affected.length).toBe(N);
  expect(Math.max(...longImpact.affected.map((a) => a.depth))).toBe(N - 1);
  expect(elapsed).toBeLessThan(CHAIN_BUDGET_MS);

  // Negative control: a traversal that follows `contradicts` as a dependency must FAIL (a).
  const edges = (
    await w.db.admin.query("SELECT from_node, to_node, relation FROM evidence_edges WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows as DepEdge[];
  const wrong = traverseDependents(
    [R],
    dependentIndex(edges.map((e) => (e.relation === "contradicts" ? { ...e, relation: "derived_from" } : e))),
  );
  expect(wrong.affected.map((a) => a.nodeId)).toContain(names.W);
  expect(wrong.affected.map((a) => a.nodeId).sort()).not.toEqual(expectedFull);

  observe({
    testId: "W09",
    observed: `member impact set equals the hand-computed ${expectedFull.length} nodes exactly (each once; independent subgraph and contradicting node not flagged); the references-closed cycle of ${member.cycles[0]!.length} nodes terminated and was reported; restricted member saw ${rIds.length} nodes with hidden B/K/L absent from the raw response and from the reported cycle; outsider got the same 404 as a nonexistent workspace; foreign tenant node never appeared; cap 3 created 3 tasks and queued ${expectedFull.length - 3}; depth bound 2 truncated; 5,000-node chain flagged ${N} nodes (100 tasks + ${N - 100} queued) in ${elapsed} ms (budget ${CHAIN_BUDGET_MS} ms); following contradicts as a dependency is detected as wrong`,
    evidence: {
      affected: member.affected.map((a) => `${name(a.nodeId)}:${a.depth}`),
      cycle: member.cycles[0]!.map(name),
      restrictedCount: rIds.length,
      revalidation: change.result.revalidation,
      chain: { nodes: N, elapsedMs: elapsed, budgetMs: CHAIN_BUDGET_MS },
    },
  });
}, 60_000);
