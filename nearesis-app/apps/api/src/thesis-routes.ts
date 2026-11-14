import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KernelError, workspaceNotFound } from "@nearesis/kernel";
import type { Session, Tx } from "@nearesis/kernel";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { APP_ROOT, loadCapsuleView, readCapsuleOwnership, readManifest, renderPdf } from "@nearesis/capsule";
import {
  Uuid,
  assertWorkspace,
  audit,
  ctxOf,
  iso,
  parseBody,
  parseQuery,
  requireWrite,
} from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";
import { claimDetail } from "./claim-routes.ts";
import { experimentSummary, getResearchRun } from "./research-store.ts";

type Obj = Record<string, unknown>;
const Title = z.string().trim().min(1).max(200);
export const CreateBody = z.strictObject({ title: Title });
export const ExportQ = z.object({
  format: z.enum(["markdown", "pdf"]).default("markdown"),
  version: z.coerce.number().int().positive().optional(),
});
export const VersionQ = z.object({ version: z.coerce.number().int().positive().optional() });

export interface ThesisContent {
  schema: "thesis-document@1";
  workspaceId: string;
  title: string;
  objective: string;
  graphVersion: number;
  hypotheses: Array<{
    hypothesisId: string;
    version: number;
    proposition: string;
    target: string;
    predictor: string;
    benchmark: string;
    falsification: string;
    registrationHash: string;
    preregistration: unknown;
  }>;
  unregisteredHypotheses: number;
  claims: {
    included: Obj[];
    excluded: Array<{
      claimId: string;
      statement: string;
      support: string;
      missing: string[];
      reason: string;
    }>;
  };
  findings: { included: Obj[]; excluded: Array<{ findingId: string; status: string; reason: string }> };
  experiments: Obj[];
  capsules: Array<{
    capsuleId: string;
    title: string;
    capsuleHash: string | null;
    local: string;
    outlayer: string;
    createdAt: string;
  }>;
  limitations: string[];
}
export interface Check {
  id: string;
  severity: "blocking" | "warning" | "info";
  passed: boolean;
  detail: string;
}

const capsuleRoot = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");

/** Capsules owned by this org and workspace (ownership.json), with their local/OutLayer verification state. */
async function workspaceCapsules(orgId: string, workspaceId: string): Promise<ThesisContent["capsules"]> {
  const root = capsuleRoot();
  if (!existsSync(root)) return [];
  const out: ThesisContent["capsules"] = [];
  for (const id of readdirSync(root).sort()) {
    const d = join(root, id);
    const o = readCapsuleOwnership(d);
    if (!o || o.orgId !== orgId || o.workspaceId !== workspaceId) continue;
    const m = readManifest(d);
    if (!m) continue;
    const v = await loadCapsuleView(d, { research: "skip", wasm: "skip" }).catch(() => null);
    out.push({
      capsuleId: m.capsuleId,
      title: m.title,
      capsuleHash: m.capsuleHash ?? null,
      local: v?.verification.local.status ?? "not_run",
      outlayer: v?.verification.outlayer.status ?? "unverified",
      createdAt: m.createdAt,
    });
  }
  return out;
}

async function assemble(
  tx: Tx,
  graph: { version: number; nodes: Obj[]; edges: Obj[] },
  ws: { id: string; orgId: string },
  title: string,
): Promise<ThesisContent> {
  const w = (await tx.query<{ objective: string }>("SELECT objective FROM workspaces WHERE id = $1", [ws.id]))
    .rows[0]!;
  const nodes = new Map(
    (
      graph.nodes as unknown as Array<{
        id: string;
        type: string;
        label: string;
        data?: Obj;
        support?: string;
        missing?: string[];
        tombstone?: boolean;
        evidenceUnavailable?: boolean;
      }>
    ).map((n) => [n.id, n]),
  );
  const edges = graph.edges as unknown as Array<{ source: string; target: string; relation: string }>;

  const included: Obj[] = [];
  const excluded: ThesisContent["claims"]["excluded"] = [];
  for (const n of nodes.values()) {
    if (n.type !== "claim" || n.tombstone) continue;
    const d = await claimDetail(tx, ws.id, n, edges, nodes);
    const support = n.support ?? "unsupported";
    if (support === "supported" && !d.evidenceUnavailable) included.push(d as unknown as Obj);
    else
      excluded.push({
        claimId: n.id,
        statement: n.label,
        support,
        missing: n.missing ?? [],
        reason: d.evidenceUnavailable
          ? "evidence unavailable (retired or tombstoned)"
          : support === "contradicted"
            ? "contradicted by linked evidence"
            : "unsupported: incomplete provenance or no supporting evidence",
      });
  }

  const hs = (
    await tx.query<{
      root_id: string;
      version: number;
      proposition: string;
      target: string;
      predictor: string;
      benchmark: string;
      falsification: string;
      freeze_hash: string;
      preregistration: unknown;
    }>(
      `SELECT h.root_id, h.version, h.proposition, h.target, h.predictor, h.benchmark, h.falsification, h.freeze_hash, h.preregistration FROM hypotheses h
        WHERE h.workspace_id = $1 AND h.status = 'frozen' AND h.version = (SELECT max(version) FROM hypotheses x WHERE x.root_id = h.root_id AND x.status = 'frozen') ORDER BY h.created_at`,
      [ws.id],
    )
  ).rows;
  const unreg = (
    await tx.query<{ n: string }>(
      "SELECT count(DISTINCT root_id)::text AS n FROM hypotheses WHERE workspace_id = $1 AND root_id NOT IN (SELECT root_id FROM hypotheses WHERE workspace_id = $1 AND status = 'frozen')",
      [ws.id],
    )
  ).rows[0]!;

  const fInc: Obj[] = [];
  const fExc: ThesisContent["findings"]["excluded"] = [];
  try {
    const fr = (
      await tx.query<{
        id: string;
        run_id: string;
        finding: {
          status: string;
          statement: string;
          facts: Array<{ resultRef?: unknown }>;
          limitations: string[];
          agentRole: string;
        };
      }>(
        "SELECT id, run_id, finding FROM runtime.run_findings WHERE workspace_id = $1 ORDER BY created_at, id",
        [ws.id],
      )
    ).rows;
    for (const r of fr) {
      const f = r.finding;
      const grounded = f.facts.length > 0 && f.facts.every((x) => x.resultRef);
      if (["supported", "contradicted", "mixed"].includes(f.status) && grounded)
        fInc.push({
          findingId: r.id,
          runId: r.run_id,
          status: f.status,
          statement: f.statement,
          facts: f.facts,
          limitations: f.limitations,
        });
      else
        fExc.push({
          findingId: r.id,
          status: f.status,
          reason: !grounded
            ? "no grounded facts (every number needs a result reference)"
            : `status ${f.status} is not a certified conclusion`,
        });
    }
  } catch {
    /* runtime schema absent: no findings */
  }

  const runIds = new Set<string>();
  for (const c of included)
    for (const r of (c as { research: Array<{ experimentId: string }> }).research) runIds.add(r.experimentId);
  const linked = (
    await tx.query<{ ref: string }>(
      "SELECT DISTINCT ref FROM hypothesis_links WHERE workspace_id = $1 AND kind = 'experiment'",
      [ws.id],
    )
  ).rows;
  for (const l of linked) runIds.add(l.ref);
  const experiments: Obj[] = [];
  const limitations = new Set<string>();
  for (const id of [...runIds].sort()) {
    const r = getResearchRun(id);
    if (!r || r.integrity !== "verified") continue;
    experiments.push(experimentSummary(r) as unknown as Obj);
    for (const l of (r.artifacts.limitations as unknown[] | undefined) ?? [])
      if (typeof l === "string") limitations.add(l);
  }
  const capsules = await workspaceCapsules(ws.orgId, ws.id);
  return {
    schema: "thesis-document@1",
    workspaceId: ws.id,
    title,
    objective: w.objective,
    graphVersion: graph.version,
    hypotheses: hs.map((h) => ({
      hypothesisId: h.root_id,
      version: h.version,
      proposition: h.proposition,
      target: h.target,
      predictor: h.predictor,
      benchmark: h.benchmark,
      falsification: h.falsification,
      registrationHash: h.freeze_hash,
      preregistration: h.preregistration,
    })),
    unregisteredHypotheses: Number(unreg.n),
    claims: { included, excluded },
    findings: { included: fInc, excluded: fExc },
    experiments,
    capsules,
    limitations: [...limitations],
  };
}

export function validateThesis(c: ThesisContent): { status: "validated" | "blocked"; checks: Check[] } {
  const frozen = new Set(c.hypotheses.map((h) => h.hypothesisId));
  const claims = c.claims.included as unknown as Array<{
    claimId: string;
    estimate: { state: string };
    falsification: { state: string };
    hypotheses: Array<{ hypothesisId: string }>;
  }>;
  const unregisteredLinked = claims.flatMap((x) =>
    x.hypotheses.map((h) => h.hypothesisId).filter((h) => !frozen.has(h)),
  );
  const checks: Check[] = [
    {
      id: "has_supported_claims",
      severity: "blocking",
      passed: claims.length > 0,
      detail: claims.length
        ? `${claims.length} supported claim(s) included.`
        : "No supported claim with complete provenance exists; a thesis cannot be assembled from nothing.",
    },
    {
      id: "hypotheses_registered",
      severity: "blocking",
      passed: unregisteredLinked.length === 0,
      detail: unregisteredLinked.length
        ? `Claim(s) rest on hypotheses that are not frozen: ${[...new Set(unregisteredLinked)].join(", ")}.`
        : "Every hypothesis behind an included claim is frozen.",
    },
    {
      id: "claims_have_estimates",
      severity: "warning",
      passed: claims.every((x) => x.estimate.state === "available"),
      detail: `${claims.filter((x) => x.estimate.state !== "available").length} included claim(s) have no stored estimate (shown as unknown).`,
    },
    {
      id: "claims_have_falsification",
      severity: "warning",
      passed: claims.every((x) => x.falsification.state === "available"),
      detail: `${claims.filter((x) => x.falsification.state !== "available").length} included claim(s) have no falsification criterion.`,
    },
    {
      id: "capsule_attached",
      severity: "warning",
      passed: c.capsules.length > 0,
      detail: c.capsules.length
        ? `${c.capsules.length} capsule(s) attached.`
        : "No research capsule belongs to this workspace.",
    },
    {
      id: "capsule_reproduced",
      severity: "warning",
      passed: c.capsules.some((x) => x.local === "reproduced"),
      detail: c.capsules.some((x) => x.local === "reproduced")
        ? "At least one capsule reproduces locally."
        : "No attached capsule is locally reproduced.",
    },
    {
      id: "excluded_claims",
      severity: "info",
      passed: true,
      detail: `${c.claims.excluded.length} unsupported or contradicted claim(s) are excluded and listed in their own section.`,
    },
  ];
  return {
    status: checks.some((k) => k.severity === "blocking" && !k.passed) ? "blocked" : "validated",
    checks,
  };
}

const cell = (v: unknown) =>
  String(v ?? "")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ");
const known = (k: unknown, pick: (v: unknown) => string): string => {
  const o = k as { state?: string; value?: unknown; reason?: string } | undefined;
  return o?.state === "available" ? pick(o.value) : `UNKNOWN (${o?.reason ?? "not available"})`;
};

/** THESIS.md: claim table with verdict, estimate, counterexample, falsification and provenance links (ch.02 deliverables). */
export function renderMarkdown(
  c: ThesisContent,
  digest: string,
  version: number,
  v: { status: string; checks: Check[] },
): string {
  const L: string[] = [
    `# ${c.title}`,
    "",
    `Document digest: \`${digest}\` (version ${version}, schema ${c.schema}).`,
    `Validation: **${v.status}**.`,
    "",
    `## Objective`,
    "",
    c.objective,
    "",
  ];
  L.push("## Registered hypotheses", "");
  if (!c.hypotheses.length) L.push("None frozen.", "");
  for (const h of c.hypotheses)
    L.push(
      `- **${h.proposition}** (v${h.version}, freeze \`${h.registrationHash}\`). Falsification: ${h.falsification}`,
    );
  if (c.unregisteredHypotheses)
    L.push(
      "",
      `${c.unregisteredHypotheses} hypothesis line(s) are still drafts and are not part of this thesis.`,
    );
  L.push(
    "",
    "## Claims",
    "",
    "| Claim | Verdict | Strength | Estimate | Counterexample | Falsification | Provenance |",
    "|---|---|---|---|---|---|---|",
  );
  for (const x of c.claims.included as unknown as Array<Record<string, any>>) {
    L.push(
      `| ${cell(x.statement)} | ${cell(x.verdict)} | ${cell(x.strength?.evidenceTier)} | ${cell(known(x.estimate, (e) => String((e as any).text ?? JSON.stringify(e))))} | ${cell(known(x.counterexamples, (e) => (e as any[]).map((y) => y.text).join("; ")))} | ${cell(known(x.falsification, (e) => (e as any).criteria.map((y: any) => y.text).join("; ") || "see research checks"))} | ${cell(`${x.evidence?.supporting?.length ?? 0} supporting node(s)`)} |`,
    );
  }
  L.push("", "## UNSUPPORTED: excluded from the supported thesis", "");
  if (!c.claims.excluded.length) L.push("None.");
  for (const x of c.claims.excluded)
    L.push(
      `- ${x.statement} (${x.support}; ${x.reason}${x.missing.length ? `; missing: ${x.missing.join(", ")}` : ""})`,
    );
  L.push("", "## Findings", "");
  if (!c.findings.included.length) L.push("No certified, grounded findings.");
  for (const f of c.findings.included as Array<Record<string, any>>) L.push(`- [${f.status}] ${f.statement}`);
  L.push("", "## Experiments", "");
  if (!c.experiments.length) L.push("None.");
  for (const e of c.experiments as Array<Record<string, any>>)
    L.push(
      `- ${e.name}: status ${e.status}, strength ${e.evidenceStrength}, ${e.origins ?? "unknown"} origins, method validated: ${e.methodValidated === null ? "unknown" : e.methodValidated}`,
    );
  L.push("", "## Capsules", "");
  if (!c.capsules.length) L.push("None.");
  for (const k of c.capsules)
    L.push(
      `- ${k.title} (${k.capsuleId}, hash ${k.capsuleHash ?? "n/a"}): local ${k.local}, OutLayer ${k.outlayer}`,
    );
  L.push("", "## Limitations", "");
  if (!c.limitations.length) L.push("None recorded by the linked research runs.");
  for (const l of c.limitations) L.push(`- ${l}`);
  L.push("", "## Validation", "");
  for (const k of v.checks)
    L.push(`- [${k.passed ? "pass" : k.severity === "blocking" ? "FAIL" : "warn"}] ${k.id}: ${k.detail}`);
  return L.join("\n") + "\n";
}

const digestOf = (c: ThesisContent) => `sha256:${sha256Hex(canonicalJson(c))}`;

/**
 * Thesis document builder (ch.02 THESIS.md deliverable). Assembles from certified material only: supported claims with complete
 * provenance, frozen hypotheses, grounded findings, verified research runs and the workspace's capsules. Versions are immutable
 * and carry a content digest the publish step can bind to.
 *   GET  /v1/workspaces/:id/thesis/documents                  POST {title} creates the document with version 1
 *   GET  /v1/workspaces/:id/thesis/documents/:did[?version=n]
 *   POST /v1/workspaces/:id/thesis/documents/:did/versions    re-assemble from current state as a new version
 *   POST /v1/workspaces/:id/thesis/documents/:did/validate    dry run: is the latest version still current, and what do the checks say now
 *   GET  /v1/workspaces/:id/thesis/documents/:did/export?format=markdown|pdf&version=n
 */
export const thesisRoutes: FastifyPluginAsync<ProductDeps> = async (app, { kernel, authenticate }) => {
  type PD = { Params: { id: string; did: string } };
  async function graphOf(s: Session, id: string) {
    if (!Uuid.safeParse(id).success) throw workspaceNotFound();
    try {
      return (await kernel.graph.get(s, id)) as unknown as { version: number; nodes: Obj[]; edges: Obj[] };
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
  }
  const docNotFound = () => new KernelError("NOT_FOUND", "THESIS_NOT_FOUND", "No such thesis document.");
  async function loadDoc(tx: Tx, wsId: string, did: string) {
    const d = Uuid.safeParse(did).success
      ? (
          await tx.query<{ id: string; title: string; created_at: Date; created_by: string }>(
            "SELECT id, title, created_at, created_by FROM thesis_documents WHERE id = $1 AND workspace_id = $2",
            [did, wsId],
          )
        ).rows[0]
      : undefined;
    if (!d) throw docNotFound();
    return d;
  }
  async function version(tx: Tx, did: string, n?: number) {
    const r = (
      await tx.query<{
        version: number;
        content: ThesisContent;
        markdown: string;
        content_digest: string;
        validation: { status: string; checks: Check[] };
        status: string;
        created_at: Date;
        created_by: string;
      }>(
        n
          ? "SELECT * FROM thesis_versions WHERE document_id = $1 AND version = $2"
          : "SELECT * FROM thesis_versions WHERE document_id = $1 ORDER BY version DESC LIMIT 1",
        n ? [did, n] : [did],
      )
    ).rows[0];
    if (!r) throw docNotFound();
    return r;
  }
  const vView = (v: Awaited<ReturnType<typeof version>>) => ({
    version: v.version,
    digest: v.content_digest,
    status: v.status,
    validation: v.validation,
    createdAt: iso(v.created_at),
    createdBy: v.created_by,
  });

  async function writeVersion(
    tx: Tx,
    s: Session,
    ws: { id: string; orgId: string },
    docId: string,
    title: string,
    n: number,
    graph: Awaited<ReturnType<typeof graphOf>>,
  ) {
    const content = await assemble(tx, graph, ws, title);
    const validation = validateThesis(content);
    const digest = digestOf(content);
    const markdown = renderMarkdown(content, digest, n, validation);
    await tx.query(
      `INSERT INTO thesis_versions(id, org_id, workspace_id, document_id, version, content, markdown, content_digest, validation, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        ws.orgId,
        ws.id,
        docId,
        n,
        JSON.stringify(content),
        markdown,
        digest,
        JSON.stringify(validation),
        validation.status,
        s.userId,
      ],
    );
    await audit(
      tx,
      s,
      "thesis.version_created",
      `thesis:${docId}`,
      { version: n, digest, status: validation.status },
      ws.id,
    );
    return { digest, validation };
  }

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/thesis/documents", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const rows = (
        await tx.query<{
          id: string;
          title: string;
          created_at: Date;
          latest: number;
          status: string;
          digest: string;
        }>(
          `SELECT d.id, d.title, d.created_at, v.version AS latest, v.status, v.content_digest AS digest FROM thesis_documents d
           JOIN thesis_versions v ON v.document_id = d.id AND v.version = (SELECT max(version) FROM thesis_versions WHERE document_id = d.id)
          WHERE d.workspace_id = $1 ORDER BY d.created_at DESC`,
          [ws.id],
        )
      ).rows;
      return {
        workspaceId: ws.id,
        documents: rows.map((r) => ({
          documentId: r.id,
          title: r.title,
          latestVersion: r.latest,
          status: r.status,
          digest: r.digest,
          createdAt: iso(r.created_at),
        })),
      };
    });
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/thesis/documents", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(CreateBody, req.body);
    const graph = await graphOf(s, req.params.id);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO thesis_documents(id, org_id, workspace_id, title, created_by) VALUES ($1,$2,$3,$4,$5)",
        [id, ws.orgId, ws.id, b.title, s.userId],
      );
      const v = await writeVersion(tx, s, ws, id, b.title, 1, graph);
      return {
        documentId: id,
        title: b.title,
        version: 1,
        digest: v.digest,
        status: v.validation.status,
        validation: v.validation,
      };
    });
    return reply.status(201).send(out);
  });

  app.get<PD & { Querystring: Record<string, string> }>(
    "/v1/workspaces/:id/thesis/documents/:did",
    async (req) => {
      const s = await authenticate(req);
      const q = parseQuery(VersionQ, req.query);
      return kernel.db.tx(ctxOf(s), async (tx) => {
        const ws = await assertWorkspace(tx, req.params.id);
        const d = await loadDoc(tx, ws.id, req.params.did);
        const v = await version(tx, d.id, q.version);
        const all = (
          await tx.query<{ version: number; content_digest: string; status: string; created_at: Date }>(
            "SELECT version, content_digest, status, created_at FROM thesis_versions WHERE document_id = $1 ORDER BY version",
            [d.id],
          )
        ).rows;
        return {
          documentId: d.id,
          workspaceId: ws.id,
          title: d.title,
          ...vView(v),
          content: v.content,
          markdown: v.markdown,
          versions: all.map((a) => ({
            version: a.version,
            digest: a.content_digest,
            status: a.status,
            createdAt: iso(a.created_at),
          })),
        };
      });
    },
  );

  app.post<PD>("/v1/workspaces/:id/thesis/documents/:did/versions", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const graph = await graphOf(s, req.params.id);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const d = await loadDoc(tx, ws.id, req.params.did);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`thesis:${d.id}`]);
      const last = await version(tx, d.id);
      const v = await writeVersion(tx, s, ws, d.id, d.title, last.version + 1, graph);
      return {
        documentId: d.id,
        version: last.version + 1,
        digest: v.digest,
        status: v.validation.status,
        validation: v.validation,
        changedSincePrevious: v.digest !== last.content_digest,
      };
    });
    return reply.status(201).send(out);
  });

  app.post<PD>("/v1/workspaces/:id/thesis/documents/:did/validate", async (req) => {
    const s = await authenticate(req);
    const graph = await graphOf(s, req.params.id);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const d = await loadDoc(tx, ws.id, req.params.did);
      const last = await version(tx, d.id);
      const now = await assemble(tx, graph, ws, d.title);
      const currentDigest = digestOf(now);
      return {
        documentId: d.id,
        version: last.version,
        storedDigest: last.content_digest,
        currentDigest,
        upToDate: currentDigest === last.content_digest,
        validation: validateThesis(now),
      };
    });
  });

  app.get<PD & { Querystring: Record<string, string> }>(
    "/v1/workspaces/:id/thesis/documents/:did/export",
    async (req, reply) => {
      const s = await authenticate(req);
      const q = parseQuery(ExportQ, req.query);
      const { d, v } = await kernel.db.tx(ctxOf(s), async (tx) => {
        const ws = await assertWorkspace(tx, req.params.id);
        const d = await loadDoc(tx, ws.id, req.params.did);
        return { d, v: await version(tx, d.id, q.version) };
      });
      void reply.header("x-content-digest", v.content_digest).header("x-thesis-version", String(v.version));
      if (q.format === "markdown") return reply.type("text/markdown; charset=utf-8").send(v.markdown);
      const body = v.markdown.split("\n").map((l) => l.replace(/^#{1,6}\s*/, "").replace(/\*\*|`/g, ""));
      return reply.type("application/pdf").send(renderPdf(d.title, body));
    },
  );
};
