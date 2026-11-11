/**
 * Pure evidence-graph logic for the explorer: display state per node, branch-overlay projection, provenance paths
 * and filtering. No network, no React; unit-testable.
 */
import type { GraphEdge, GraphNode, GraphProjection } from "@nearesis/contracts";

export const NODE_KINDS = [
  "hypothesis",
  "claim",
  "statistical_result",
  "observation",
  "query",
  "model",
  "source",
  "verification_artifact",
  "marker",
  "agent",
] as const;
export const RELATIONS = [
  "supports",
  "contradicts",
  "derived_from",
  "monitors",
  "references",
  "reproduces",
  "supersedes",
] as const;

export type NodeState =
  | "ok"
  | "unsupported"
  | "contradicted"
  | "support_unknown"
  | "recheck"
  | "tombstone"
  | "evidence_unavailable";

/**
 * Display state. Claims without a supporting path are `unsupported` (W08); a claim whose support was not computed
 * (e.g. a branch overlay view) is `support_unknown`, never assumed supported. Tombstones win; rechecks are
 * secondary on unsupported or contradicted claims.
 */
export function nodeState(n: GraphNode): NodeState {
  if (n.tombstone) return "tombstone";
  // W08: an unsupported or contradicted claim is shown as such first; a pending recheck is a secondary flag.
  if (n.type === "claim" && n.support === "unsupported") return "unsupported";
  if (n.type === "claim" && n.support === "contradicted") return "contradicted";
  if (n.recheckRequired) return "recheck";
  if (n.type === "claim" && n.support === undefined) return "support_unknown";
  return "ok";
}

/** Secondary flags shown beside the primary state, so no state hides another. */
export function secondaryFlags(n: GraphNode): NodeState[] {
  const p = nodeState(n);
  const out: NodeState[] = [];
  if (n.recheckRequired && p !== "recheck") out.push("recheck");
  if (n.evidenceUnavailable) out.push("evidence_unavailable");
  return out;
}

export const STATE_LABEL: Record<NodeState, string> = {
  ok: "",
  unsupported: "Unsupported claim",
  contradicted: "Contradicted claim",
  support_unknown: "Support unknown",
  recheck: "Recheck required",
  tombstone: "Tombstone (missing endpoint)",
  evidence_unavailable: "Evidence unavailable (payload deleted)",
};

/**
 * W08: an unsupported claim lists the provenance it is missing. Inbound `supports`/`reproduces` edges from evidence
 * kinds count as support; anything short of a path to a source or statistical result is reported.
 */
export function missingProvenance(id: string, g: Pick<GraphProjection, "nodes" | "edges">): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const supporters = g.edges
    .filter((e) => e.target === id && (e.relation === "supports" || e.relation === "reproduces"))
    .map((e) => byId.get(e.source))
    .filter((n): n is GraphNode => !!n && !n.tombstone);
  const missing: string[] = [];
  if (!supporters.length) missing.push("No supports/reproduces edge from a persisted, non-tombstoned node.");
  const up = upstream(id, g);
  if (!up.some((n) => n.type === "source")) missing.push("No derivation path to a persisted source record.");
  if (!up.some((n) => n.type === "statistical_result" || n.type === "query" || n.type === "observation"))
    missing.push("No computation output (statistical result, query or observation) on any path.");
  return missing;
}

/** Upstream provenance: every node reachable by following edges backwards (evidence flows into its target). */
export function upstream(id: string, g: Pick<GraphProjection, "nodes" | "edges">): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const into = new Map<string, GraphEdge[]>();
  for (const e of g.edges) into.set(e.target, [...(into.get(e.target) ?? []), e]);
  // derived_from points from the derived node to its origin; walk it forwards as well.
  const derived = new Map<string, GraphEdge[]>();
  for (const e of g.edges)
    if (e.relation === "derived_from") derived.set(e.source, [...(derived.get(e.source) ?? []), e]);
  const seen = new Set<string>([id]);
  const out: GraphNode[] = [];
  const queue = [id];
  while (queue.length && out.length < 500) {
    const cur = queue.shift()!;
    const next = [
      ...(into.get(cur) ?? []).filter((e) => e.relation !== "derived_from").map((e) => e.source),
      ...(derived.get(cur) ?? []).map((e) => e.target),
    ];
    for (const n of next)
      if (!seen.has(n)) {
        seen.add(n);
        const node = byId.get(n);
        if (node) {
          out.push(node);
          queue.push(n);
        }
      }
  }
  return out;
}

/**
 * Branch overlay -> projection. Branch views are materialized object maps (`node:<id>`, `edge:<from>|<to>|<rel>`);
 * claim support is not computed for them, so claims are `support_unknown` rather than shown as supported.
 */
export function projectionFromObjects(
  workspaceId: string,
  objects: Record<string, unknown>,
): GraphProjection {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolved: GraphProjection["unresolved"] = [];
  for (const [k, v] of Object.entries(objects)) {
    if (k.startsWith("node:")) {
      const o = (v ?? {}) as {
        kind?: string;
        label?: string;
        data?: Record<string, unknown>;
        tombstone?: boolean;
      };
      nodes.push({
        id: k.slice(5),
        type: (o.kind ?? "source") as GraphNode["type"],
        label: o.label ?? k.slice(5),
        ...(o.data ? { data: o.data } : {}),
        ...(o.tombstone ? { tombstone: true } : {}),
      });
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const [k, v] of Object.entries(objects)) {
    if (!k.startsWith("edge:")) continue;
    const [from, to, rel] = k.slice(5).split("|");
    const relation = ((v as { relation?: string })?.relation ?? rel) as GraphEdge["relation"];
    const missing = [
      ...(ids.has(from!) ? [] : ["source" as const]),
      ...(ids.has(to!) ? [] : ["target" as const]),
    ];
    if (missing.length)
      unresolved.push({
        id: k,
        reason: "endpoint not in branch",
        source: from!,
        target: to!,
        relation,
        missing,
      });
    else edges.push({ id: k, source: from!, target: to!, relation, origin: "stored" });
  }
  return { workspaceId, version: 0, nodes, edges, unresolved };
}

export interface GraphFilter {
  kinds: Set<string>;
  states: Set<NodeState | "any">;
  text: string;
  relations: Set<string>;
}

export function applyFilter(g: GraphProjection, f: GraphFilter): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const t = f.text.trim().toLowerCase();
  const nodes = g.nodes.filter(
    (n) =>
      f.kinds.has(n.type) &&
      (f.states.has("any") || f.states.has(nodeState(n))) &&
      (!t || n.label.toLowerCase().includes(t) || n.id.toLowerCase().includes(t)),
  );
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && f.relations.has(e.relation)),
  };
}

/** Evidence flows downward: origins at the top, computations, then claims, then the hypothesis they bear on. */
const LAYOUT_ORDER = [
  "source",
  "agent",
  "marker",
  "query",
  "observation",
  "model",
  "statistical_result",
  "verification_artifact",
  "claim",
  "hypothesis",
] as const;

/** Deterministic layered layout for nodes without a saved position (by evidence-flow rank, then id). */
export function autoLayout(nodes: GraphNode[]): Record<string, { x: number; y: number }> {
  const rank = new Map<string, number>(LAYOUT_ORDER.map((k, i) => [k, i]));
  const rows = new Map<number, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = rank.get(n.type) ?? LAYOUT_ORDER.length;
    rows.set(r, [...(rows.get(r) ?? []), n]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  [...rows.keys()]
    .sort((a, b) => a - b)
    .forEach((r, ri) => rows.get(r)!.forEach((n, i) => (out[n.id] = { x: i * 240, y: ri * 150 })));
  return out;
}
