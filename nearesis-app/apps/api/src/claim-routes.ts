import type { FastifyPluginAsync } from "fastify";
import { KernelError, workspaceNotFound } from "@nearesis/kernel";
import type { Tx } from "@nearesis/kernel";
import { Uuid, assertWorkspace, ctxOf, known, unknown } from "./product-common.ts";
import type { Known, ProductDeps } from "./product-common.ts";
import { experimentDetail, experimentSummary, getResearchRun, listResearchRuns } from "./research-store.ts";
import type { ResearchRun } from "./research-store.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
const f = (n: unknown, d = 4): string =>
  typeof n === "number" && Number.isFinite(n) ? String(Number(n.toPrecision(d + 1))) : "n/a";

interface GraphNode {
  id: string;
  type: string;
  label: string;
  data?: Obj;
  support?: string;
  missing?: string[];
  tombstone?: boolean;
  evidenceUnavailable?: boolean;
}
interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

/** The research run a claim rests on: claim.data.researchRunId, else a research run linked to a hypothesis that links this claim. */
async function runsFor(
  tx: Tx,
  workspaceId: string,
  claimId: string,
  data: Obj,
): Promise<{
  runs: ResearchRun[];
  hypotheses: Array<{
    hypothesisId: string;
    proposition: string;
    falsification: string;
    registrationHash: string | null;
  }>;
}> {
  const ids = new Set<string>();
  for (const k of ["researchRunId", "experimentRunId"]) {
    const v = str(data[k]);
    if (v) ids.add(v);
  }
  const hs = (
    await tx.query<{
      root_id: string;
      proposition: string;
      falsification: string;
      freeze_hash: string | null;
    }>(
      `SELECT h.root_id, h.proposition, h.falsification, h.freeze_hash FROM hypotheses h
        WHERE h.workspace_id = $1 AND h.version = (SELECT max(version) FROM hypotheses x WHERE x.root_id = h.root_id)
          AND h.root_id IN (SELECT root_id FROM hypothesis_links WHERE workspace_id = $1 AND kind = 'claim' AND ref = $2)`,
      [workspaceId, claimId],
    )
  ).rows;
  if (hs.length) {
    const ex = await tx.query<{ ref: string }>(
      "SELECT ref FROM hypothesis_links WHERE workspace_id = $1 AND kind = 'experiment' AND root_id = ANY($2::uuid[])",
      [workspaceId, hs.map((h) => h.root_id)],
    );
    for (const e of ex.rows) ids.add(e.ref);
  }
  const runs = [...ids]
    .map((i) => getResearchRun(i))
    .filter((r): r is ResearchRun => !!r && r.integrity === "verified");
  return {
    runs,
    hypotheses: hs.map((h) => ({
      hypothesisId: h.root_id,
      proposition: h.proposition,
      falsification: h.falsification,
      registrationHash: h.freeze_hash,
    })),
  };
}

function estimateOf(data: Obj, runs: ResearchRun[]): Known<unknown> {
  const e = data.estimate;
  if (typeof e === "string" && e.trim()) return known({ text: e }, "claim.data.estimate");
  if (e && typeof e === "object") return known(e, "claim.data.estimate");
  if (data.value !== undefined && data.value !== null)
    return known({ value: data.value, unit: str(data.unit) }, "claim.data.value");
  const run = runs[0];
  if (run) {
    const est = obj(run.artifacts.estimates);
    const p = obj(est.primary);
    const ci = obj(p.delta_mae_ci);
    if (typeof p.delta_mae === "number") {
      const h = obj(run.artifacts.hypothesis).primaryHorizon;
      return known(
        {
          text: `delta MAE ${f(p.delta_mae)} (candidate ${String(p.candidate)} vs baseline, positive favours the candidate), 95% CI [${f(ci.lo)}, ${f(ci.hi)}], ${String(p.n_origins)} origins, horizon ${String(h)}`,
          deltaMae: p.delta_mae,
          ci: p.delta_mae_ci ?? null,
          nOrigins: p.n_origins ?? null,
          horizon: h ?? null,
        },
        `research-run:${run.runId}`,
      );
    }
  }
  return unknown("No estimate is stored on the claim and no linked research run supplies one.");
}

/** Derived read model of one evidence-graph claim. Anything the sources do not provide is typed unknown. */
export async function claimDetail(
  tx: Tx,
  workspaceId: string,
  n: GraphNode,
  edges: GraphEdge[],
  nodes: Map<string, GraphNode>,
) {
  const data = obj(n.data);
  const live = (id: string) => nodes.get(id) && !nodes.get(id)!.tombstone;
  const rel = (relation: string) =>
    edges
      .filter((e) => e.relation === relation && (e.target === n.id || e.source === n.id))
      .map((e) => (e.target === n.id ? e.source : e.target))
      .filter(live)
      .map((id) => ({ nodeId: id, kind: nodes.get(id)!.type, label: nodes.get(id)!.label }));
  const supporters = rel("supports");
  const contradictors = rel("contradicts");
  const { runs, hypotheses } = await runsFor(tx, workspaceId, n.id, data);
  const run = runs[0];

  const counterexamples: Array<{ source: string; text: string; ref?: string }> = [
    ...strs(data.counterexamples).map((t) => ({ source: "claim.data.counterexamples", text: t })),
    ...(str(data.counterexample)
      ? [{ source: "claim.data.counterexample", text: String(data.counterexample) }]
      : []),
    ...contradictors.map((c) => ({ source: "evidence_graph.contradicts", text: c.label, ref: c.nodeId })),
    ...(run
      ? ((run.artifacts.counterevidence as Obj[] | undefined) ?? []).map((c) => ({
          source: `research-run:${run.runId}`,
          text: `${String(c.kind)}: ${String(c.candidate)} at horizon ${String(c.horizon)} (delta MAE ${f(c.delta_mae)}, adjusted p ${f(c.p_adjusted)})`,
        }))
      : []),
  ];
  const criteria: Array<{ source: string; text: string }> = [
    ...(str(data.falsification)
      ? [{ source: "claim.data.falsification", text: String(data.falsification) }]
      : []),
    ...hypotheses.map((h) => ({ source: `hypothesis:${h.hypothesisId}`, text: h.falsification })),
  ];
  const falsRun = run ? obj(run.artifacts.falsification) : null;
  const disputed = contradictors.length > 0 && supporters.length > 0;
  const support = n.support ?? "unsupported";
  return {
    claimId: n.id,
    workspaceId,
    statement: n.label,
    support,
    verdict: disputed ? "mixed" : support,
    disputed,
    missing: n.missing ?? [],
    evidenceUnavailable: n.evidenceUnavailable === true,
    strength: {
      evidenceTier: str(data.evidenceTier) ?? "exploratory",
      research: run
        ? known(str(run.run.evidenceStrength), `research-run:${run.runId}`)
        : unknown("No linked research run."),
    },
    estimate: estimateOf(data, runs),
    counterexamples: counterexamples.length
      ? known(counterexamples, "derived")
      : unknown(
          "No counterexample is stored, no contradicting evidence is linked and no research run lists counter-evidence.",
        ),
    falsification:
      criteria.length || falsRun
        ? known({ criteria, checks: falsRun ?? null }, "derived")
        : unknown("No falsification criterion is stored on the claim or on a linked hypothesis."),
    evidence: {
      supporting: supporters,
      contradicting: contradictors,
      provenance: data.provenance ?? null,
      resultIds: [...new Set(supporters.map((s) => s.nodeId))],
    },
    hypotheses,
    research: runs.map((r) => experimentSummary(r)),
  };
}

/** Claims over the evidence graph, enriched from hypotheses and research artifacts. */
export const claimRoutes: FastifyPluginAsync<ProductDeps> = async (app, { kernel, authenticate }) => {
  async function graphOf(req: { params: { id: string } }, s: Awaited<ReturnType<typeof authenticate>>) {
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    try {
      const g = (await kernel.graph.get(s, req.params.id)) as unknown as {
        version: number;
        nodes: GraphNode[];
        edges: GraphEdge[];
      };
      return g;
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
  }

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/claims", async (req) => {
    const s = await authenticate(req);
    const g = await graphOf(req, s);
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const claims = [];
      for (const n of g.nodes.filter((x) => x.type === "claim" && !x.tombstone)) {
        const d = await claimDetail(tx, ws.id, n, g.edges, nodes);
        claims.push({
          claimId: d.claimId,
          statement: d.statement,
          verdict: d.verdict,
          support: d.support,
          disputed: d.disputed,
          strength: d.strength.evidenceTier,
          estimate: d.estimate,
          hypothesisIds: d.hypotheses.map((h) => h.hypothesisId),
        });
      }
      return { workspaceId: ws.id, graphVersion: g.version, claims };
    });
  });

  app.get<{ Params: { id: string; cid: string } }>("/v1/workspaces/:id/claims/:cid", async (req) => {
    const s = await authenticate(req);
    const g = await graphOf(req, s);
    const n = Uuid.safeParse(req.params.cid).success
      ? g.nodes.find((x) => x.id === req.params.cid && x.type === "claim")
      : undefined;
    if (!n) throw new KernelError("NOT_FOUND", "CLAIM_NOT_FOUND", "No such claim.");
    const nodes = new Map(g.nodes.map((x) => [x.id, x]));
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      return { graphVersion: g.version, ...(await claimDetail(tx, ws.id, n, g.edges, nodes)) };
    });
  });

  // Experiments: read-only views over the research engine's real run artifacts (docs/research/live-results).
  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/experiments", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const lk = (
        await tx.query<{ root_id: string; ref: string }>(
          "SELECT root_id, ref FROM hypothesis_links WHERE workspace_id = $1 AND kind = 'experiment'",
          [ws.id],
        )
      ).rows;
      return {
        workspaceId: ws.id,
        scope: "platform_research_runs" as const,
        experiments: listResearchRuns().map((r) => ({
          ...experimentSummary(r),
          hypothesisIds: lk.filter((l) => l.ref === r.runId).map((l) => l.root_id),
        })),
      };
    });
  });

  app.get<{ Params: { id: string; eid: string } }>("/v1/workspaces/:id/experiments/:eid", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const r = getResearchRun(req.params.eid);
      if (!r) throw new KernelError("NOT_FOUND", "EXPERIMENT_NOT_FOUND", "No such experiment.");
      const lk = (
        await tx.query<{ root_id: string }>(
          "SELECT root_id FROM hypothesis_links WHERE workspace_id = $1 AND kind = 'experiment' AND ref = $2",
          [ws.id, r.runId],
        )
      ).rows;
      return { workspaceId: ws.id, ...experimentDetail(r), hypothesisIds: lk.map((l) => l.root_id) };
    });
  });
};
