import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EvidenceNodeKind, EvidenceRelation } from "@nearesis/contracts";
import { observe } from "@nearesis/acceptance";
import { GRAPH_NODE_TYPES } from "../../src/index.ts";
import { newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w07")));
afterAll(async () => w?.db.drop());

/** Vendored from the Bible (ch.10 "Database entities", ch.26 "Supported visual grammar", ch.15 P08). */
const BIBLE_RELATIONS = [
  "supports",
  "contradicts",
  "derived_from",
  "monitors",
  "references",
  "reproduces",
  "supersedes",
] as const;
const BIBLE_KINDS = [
  "hypothesis",
  "observation",
  "query",
  "model",
  "source",
  "marker",
  "agent",
  "statistical_result",
  "claim",
  "verification_artifact",
] as const;

/** The registry-vs-Bible diff: symmetric difference of two enumerations. */
const enumDiff = (registry: readonly string[], bible: readonly string[]) => [
  ...registry.filter((x) => !bible.includes(x)).map((x) => `+${x}`),
  ...bible.filter((x) => !registry.includes(x)).map((x) => `-${x}`),
];

const checkValues = async (table: string, column: string): Promise<string[]> => {
  const r = await w.db.admin.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'`,
    [table, column],
  );
  return [...(r.rows[0]?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
};

it("W07: nodes have the authorised kinds and edges use only the seven authorised relations", async () => {
  const { workspaceId } = await newWs(w);

  // (a) every kind persists; every relation persists between sensible pairs with actor and reason.
  const ids: Record<string, string> = {};
  for (const kind of BIBLE_KINDS) {
    const r = await w.h.graphOps.addNode(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      kind,
      label: `fx ${kind}`,
    });
    ids[kind] = r.result.nodeId as string;
  }
  const pairs: Array<[string, string, (typeof BIBLE_RELATIONS)[number]]> = [
    ["statistical_result", "claim", "supports"],
    ["observation", "claim", "contradicts"],
    ["claim", "query", "derived_from"],
    ["agent", "marker", "monitors"],
    ["hypothesis", "source", "references"],
    ["verification_artifact", "statistical_result", "reproduces"],
    ["model", "hypothesis", "supersedes"],
  ];
  for (const [f, t, relation] of pairs)
    await w.h.graphOps.addEdge(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      from: ids[f],
      to: ids[t],
      relation,
      reason: `fixture ${relation}`,
    });
  const nodeRows = (
    await w.db.admin.query("SELECT kind FROM evidence_nodes WHERE workspace_id = $1", [workspaceId])
  ).rows.map((r) => r.kind as string);
  const edgeRows = (
    await w.db.admin.query(
      "SELECT relation, reason, created_by FROM evidence_edges WHERE workspace_id = $1 ORDER BY relation",
      [workspaceId],
    )
  ).rows as Array<{ relation: string; reason: string; created_by: string }>;
  expect([...nodeRows].sort()).toEqual([...BIBLE_KINDS].sort());
  expect(edgeRows.map((e) => e.relation).sort()).toEqual([...BIBLE_RELATIONS].sort());
  for (const e of edgeRows) {
    expect(e.created_by).toBe(w.owner.userId);
    expect(e.reason).toBe(`fixture ${e.relation}`);
  }

  // (b) invalid inputs: 422-class rejection and nothing changes.
  const countNodes = async () =>
    Number(
      (await w.db.admin.query("SELECT count(*) FROM evidence_nodes WHERE workspace_id = $1", [workspaceId]))
        .rows[0].count,
    );
  const countEdges = async () =>
    Number(
      (await w.db.admin.query("SELECT count(*) FROM evidence_edges WHERE workspace_id = $1", [workspaceId]))
        .rows[0].count,
    );
  const [n0, e0, v0] = [await countNodes(), await countEdges(), await wsVersion(w, workspaceId)];
  const badRelation = await rejection(
    w.h.graphOps.addEdge(w.owner, workspaceId, {
      expectedVersion: v0,
      from: ids.claim,
      to: ids.query,
      relation: "causes",
    }),
  );
  const badKind = await rejection(
    w.h.graphOps.addNode(w.owner, workspaceId, { expectedVersion: v0, kind: "jsx", label: "x" }),
  );
  const selfSupersedes = await rejection(
    w.h.graphOps.addEdge(w.owner, workspaceId, {
      expectedVersion: v0,
      from: ids.claim,
      to: ids.claim,
      relation: "supersedes",
    }),
  );
  for (const e of [badRelation, badKind, selfSupersedes]) expect(e.code).toBe("VALIDATION_FAILED");
  expect([await countNodes(), await countEdges(), await wsVersion(w, workspaceId)]).toEqual([n0, e0, v0]);

  // (c) the projection exposes node kinds as the typed enum, no free-text kind.
  const proj = await w.k.graph.get(w.owner, workspaceId);
  const projKinds = new Set(proj.nodes.map((n) => n.type as string));
  for (const k of projKinds) expect((BIBLE_KINDS as readonly string[]).includes(k)).toBe(true);
  expect(proj.nodes.filter((n) => n.type !== "query" && n.type !== "agent").length).toBeGreaterThan(0);
  expect(new Set(proj.edges.map((e) => e.relation))).toEqual(new Set(BIBLE_RELATIONS));

  // (d) the Bible is silent on relation-by-kind restrictions, so none is enforced: an unusual pair is accepted.
  const odd = await w.h.graphOps.addEdge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    from: ids.marker,
    to: ids.hypothesis,
    relation: "supports",
    reason: "no relation-by-kind table exists in the Bible",
  });
  expect(odd.replayed).toBe(false);

  // Enum diff against the Bible list: contracts, kernel registry and DB constraints agree exactly.
  const registries = {
    "contracts.EvidenceRelation": EvidenceRelation.options as readonly string[],
    "contracts.EvidenceNodeKind": EvidenceNodeKind.options as readonly string[],
    "kernel.GRAPH_NODE_TYPES": GRAPH_NODE_TYPES as readonly string[],
    "db.evidence_edges.relation": await checkValues("evidence_edges", "relation"),
    "db.evidence_nodes.kind": await checkValues("evidence_nodes", "kind"),
  };
  const diffs = Object.fromEntries(
    Object.entries(registries).map(([name, reg]) => [
      name,
      enumDiff(reg, name.endsWith("relation") || name.includes("Relation") ? BIBLE_RELATIONS : BIBLE_KINDS),
    ]),
  );
  for (const d of Object.values(diffs)) expect(d).toEqual([]);

  // Drift check against the Bible chapter itself when it is present in this checkout.
  let bibleDrift = "bible chapter not present, vendored list used";
  const dir = join(process.cwd(), "../../../NEARESIS_Build_Bible/chapters");
  if (existsSync(dir)) {
    const f = (await import("node:fs")).readdirSync(dir).find((n) => n.startsWith("10_"));
    if (f) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const r of BIBLE_RELATIONS) expect(text).toContain(r);
      bibleDrift = `all ${BIBLE_RELATIONS.length} relations found in ${f}`;
    }
  }

  // Negative control: adding `causes` to the enum in a test build must FAIL (a) through the diff.
  const broken = enumDiff([...EvidenceRelation.options, "causes"], BIBLE_RELATIONS);
  expect(broken).toEqual(["+causes"]);

  observe({
    testId: "W07",
    observed: `${nodeRows.length} node kinds and ${edgeRows.length} relations persisted with actor and reason; relation "causes", kind "jsx" and self-supersedes rejected (VALIDATION_FAILED) with node/edge counts and workspace version unchanged; projection kinds all in the 10-kind enum; contracts, kernel registry and DB check constraints match the Bible list exactly (${bibleDrift}); an unusual kind pair is accepted because no restriction table exists; adding "causes" is detected by the diff (+causes)`,
    evidence: {
      kinds: [...BIBLE_KINDS],
      relations: edgeRows.map((e) => e.relation),
      rejections: [badRelation.reasonCode, badKind.reasonCode, selfSupersedes.reasonCode],
      enumDiffs: diffs,
      negativeControl: broken,
    },
  });
}, 60_000);
