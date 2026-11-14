import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { KernelError, canWrite, workspaceNotFound } from "@nearesis/kernel";
import type { Session, Tx } from "@nearesis/kernel";
import { APP_ROOT, readCapsuleOwnership } from "@nearesis/capsule";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { createWorkspaceCapsule } from "./workspace-capsule-routes.ts";
import { createPanelDataPort } from "./panel-data.ts";
import type { PanelDataPort } from "./panel-data.ts";
import { Uuid, audit, ctxOf, iso, parseBody } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";
import type { RunsService } from "./runs.ts";
import { readCapsuleFacts } from "./user-thesis/facts.ts";
import { ThesisBuildError, buildThesis } from "./user-thesis/generate.ts";
import type {
  HypothesisInput,
  MarkerBrief,
  MonitorBrief,
  OutlayerState,
  PreviousThesis,
} from "./user-thesis/generate.ts";
import { renderThesisMarkdown } from "./user-thesis/render.ts";
import { compareDocs } from "./user-thesis/compare.ts";
import { docHash, verifyReferenceBundle, verifyWorkspaceThesis } from "./user-thesis/verify.ts";
import type { Check, Doc, ProofBinding } from "./user-thesis/verify.ts";
import { UNTESTED_NOTE } from "./user-thesis/validate.ts";

/**
 * User theses (backend part 1). A thesis is a deterministic `nearesis.thesis.v1` document built from a workspace run and its
 * capsule (no model call), stored per workspace and run, shareable by a public link, importable into other accounts, and
 * verifiable by anyone who can open it (free: no model and no chain call). The NEAR Intents reference thesis is listed beside
 * them as the pinned entry `reference-near-intents`, read from thesis/build. `/v1/thesis` (the reference bundle) is unchanged.
 */
export const REFERENCE_ID = "reference-near-intents";

export interface UserThesisRoutesOptions extends ProductDeps {
  runs: RunsService;
  /** Test seam; default: the guarded semantic gateway and analytics capabilities, created on first use. */
  panelData?: PanelDataPort;
  /** Test seam: capsule root (default NEARESIS_CAPSULE_DIR or <app>/.data/capsules). */
  capsuleRoot?: () => string;
  /** Test seam: the pinned verifier wasm. */
  wasmPath?: string;
  /** Requests per window per client IP on the public routes (default 60 per minute). */
  perWindow?: number;
  windowMs?: number;
  now?: () => number;
}

const BuildBody = z.strictObject({ runId: z.uuid().optional() });
const SlugBody = z.strictObject({ slug: z.string().regex(/^[a-z0-9]{12,40}$/) });
const CompareBody = z.strictObject({ against: z.union([z.uuid(), z.literal(REFERENCE_ID)]) });

const defaultRoot = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
const thesisDir = (): string => process.env.NEARESIS_THESIS_DIR ?? join(APP_ROOT, "thesis");
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

interface Row {
  id: string;
  org_id: string;
  workspace_id: string;
  owner_user_id: string;
  run_id: string;
  capsule_id: string;
  version: string;
  status: "draft" | "published" | "unpublished";
  share_slug: string | null;
  title: string;
  doc: Doc;
  doc_sha256: string;
  kind: "workspace" | "reproduction";
  source_thesis_id: string | null;
  created_at: Date;
  published_at: Date | null;
}
const COLS =
  "id, org_id, workspace_id, owner_user_id, run_id, capsule_id, version, status, share_slug, title, doc, doc_sha256, kind, source_thesis_id, created_at, published_at";

interface Counts {
  verified: number;
  reproduced: number;
  drift: number;
}
const noCounts: Counts = { verified: 0, reproduced: 0, drift: 0 };

const notFound = (): KernelError => new KernelError("NOT_FOUND", "THESIS_NOT_FOUND", "Thesis not found.");
const fileNotFound = (): KernelError =>
  new KernelError("NOT_FOUND", "THESIS_FILE_NOT_FOUND", "Thesis file not found.");

const verdictOf = (doc: Doc): { status: string; headline: string } => ({
  status: String(doc.verdict?.status ?? ""),
  headline: String(doc.verdict?.headline ?? ""),
});

/** The document a signed-out reader gets: no workspace, run or hypothesis ids. */
export function publicDoc(doc: Doc): Doc {
  return { ...doc, origin: { ...doc.origin, workspaceId: null, runId: null, hypothesisId: null } };
}

function loadReference(): { doc: Doc; markdown: string; updatedAt: string } {
  const p = join(thesisDir(), "build", "thesis.json");
  if (!existsSync(p))
    throw new KernelError(
      "UPSTREAM_DEGRADED",
      "THESIS_NOT_BUILT",
      "The thesis bundle has not been built; run pnpm thesis:build.",
    );
  const doc = JSON.parse(readFileSync(p, "utf8")) as Doc;
  const md = join(thesisDir(), "build", "THESIS.md");
  return {
    doc: { ...doc, origin: { kind: "reference" } },
    markdown: existsSync(md) ? readFileSync(md, "utf8") : "",
    updatedAt: String(doc.generatedAt ?? ""),
  };
}

const slugOf = (): string => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = randomBytes(20);
  return [...b].map((x) => a[x % a.length]).join("");
};

export const userThesisRoutes: FastifyPluginAsync<UserThesisRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate, runs } = opts;
  let port: PanelDataPort | null = opts.panelData ?? null;
  const data = (): PanelDataPort => (port ??= createPanelDataPort());
  app.addHook("onClose", async () => {
    if (!opts.panelData) await port?.close();
  });
  const root = (): string => (opts.capsuleRoot ?? defaultRoot)();

  // ------------------------------------------------------------------------------------------------------ shared reads
  const counts = async (tx: Tx, ids: string[]): Promise<Map<string, Counts>> => {
    const m = new Map<string, Counts>();
    for (const id of ids) {
      const r = await tx.query<Counts>("SELECT * FROM thesis_receipt_counts($1)", [id]);
      m.set(id, r.rows[0] ?? noCounts);
    }
    return m;
  };
  const summaryOf = (r: Row, s: Session | null, c: Counts) => ({
    id: r.id,
    title: r.title,
    hypothesis: String(r.doc.hypothesis ?? ""),
    verdict: verdictOf(r.doc),
    kind: s && r.org_id !== s.principal.orgId ? ("imported" as const) : ("workspace" as const),
    workspaceId: s && r.org_id === s.principal.orgId ? r.workspace_id : null,
    version: r.version,
    status: r.status,
    shareSlug: r.share_slug,
    sourceThesisId: r.source_thesis_id,
    updatedAt: (r.published_at ?? r.created_at).toISOString(),
    receipts: c,
  });
  const referenceSummary = (c: Counts) => {
    const ref = loadReference();
    return {
      id: REFERENCE_ID,
      title: String(ref.doc.hypothesis ?? "NEAR Intents reference thesis"),
      hypothesis: String(ref.doc.hypothesis ?? ""),
      verdict: verdictOf(ref.doc),
      kind: "reference" as const,
      workspaceId: null,
      version: String(ref.doc.version ?? ""),
      status: "published" as const,
      shareSlug: null,
      sourceThesisId: null,
      updatedAt: ref.updatedAt,
      receipts: c,
    };
  };
  const rowOf = async (tx: Tx, id: string): Promise<Row> => {
    if (!Uuid.safeParse(id).success) throw notFound();
    const r = await tx.query<Row>(`SELECT ${COLS} FROM theses WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound();
    return r.rows[0];
  };
  const displayOf = async (tx: Tx, s: Session): Promise<string | null> =>
    (
      await tx.query<{ display_name: string | null }>("SELECT display_name FROM users WHERE id = $1", [
        s.userId,
      ])
    ).rows[0]?.display_name ?? null;
  const recordReceipt = async (
    tx: Tx,
    s: Session,
    thesisId: string,
    kind: "verify" | "reproduce",
    outcome: string,
    detail: unknown,
  ): Promise<string> =>
    (
      await tx.query<{ id: string }>(
        "INSERT INTO thesis_receipts(thesis_id, user_id, display_name, kind, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [thesisId, s.userId, await displayOf(tx, s), kind, outcome, JSON.stringify(detail)],
      )
    ).rows[0]!.id;
  const proofBinding =
    (s: Session | null) =>
    async (capsuleId: string): Promise<ProofBinding | null> => {
      const read = async (tx: Tx): Promise<ProofBinding | null> =>
        (
          await tx.query<ProofBinding>(
            s
              ? "SELECT state, request_id, tx_hash, input_sha256, output_sha256, decision FROM outlayer_proofs WHERE capsule_id = $1 ORDER BY (state = 'verified') DESC, created_at DESC LIMIT 1"
              : "SELECT * FROM thesis_proof_binding($1)",
            [capsuleId],
          )
        ).rows[0] ?? null;
      if (s) {
        const own = await kernel.db.tx(ctxOf(s), read);
        if (own) return own;
      }
      return kernel.db.txGlobal(
        async (tx) =>
          (await tx.query<ProofBinding>("SELECT * FROM thesis_proof_binding($1)", [capsuleId])).rows[0] ??
          null,
      );
    };

  // ----------------------------------------------------------------------------------------------------------- build
  async function pickRun(s: Session, workspaceId: string, runId: string | undefined): Promise<string> {
    if (runId) return runId;
    const list = await runs.listRuns(s, workspaceId);
    for (const r of list.runs) {
      if (r.state !== "COMPLETE") continue;
      const d = await runs.getRun(s, r.runId).catch(() => null);
      if (d && d.interpretation.state === "ready" && d.findings.length) return r.runId;
    }
    throw new KernelError(
      "VALIDATION_FAILED",
      "NO_COMPLETE_RUN",
      "The workspace has no COMPLETE run with a ready interpretation.",
    );
  }

  async function buildForWorkspace(s: Session, workspaceId: string, runIdIn: string | undefined) {
    if (!Uuid.safeParse(workspaceId).success) throw workspaceNotFound();
    try {
      await kernel.workspaces.get(s, workspaceId);
    } catch (e) {
      if (e instanceof KernelError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND"))
        throw workspaceNotFound();
      throw e;
    }
    if (!canWrite(s.role))
      throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
    const runId = await pickRun(s, workspaceId, runIdIn);
    const cap = await createWorkspaceCapsule(
      {
        kernel,
        runs,
        panelData: data(),
        root: root(),
        ...(opts.wasmPath ? { wasmPath: opts.wasmPath } : {}),
      },
      s,
      workspaceId,
      runId,
    );
    const dir = resolveCapsuleDir(root(), cap.view.capsuleId);
    const owner = dir ? readCapsuleOwnership(dir) : null;
    if (!dir || !owner || owner.orgId !== s.principal.orgId || owner.workspaceId !== workspaceId)
      throw new KernelError(
        "INTERNAL",
        "CAPSULE_UNREADABLE",
        "The capsule of this run could not be read back.",
      );
    const facts = readCapsuleFacts(dir);
    if (!facts)
      throw new KernelError(
        "INTERNAL",
        "CAPSULE_UNREADABLE",
        "The capsule of this run is not a workspace-run capsule.",
      );
    const run = await runs.getRun(s, runId);
    const question =
      (await runs.listRuns(s, workspaceId)).runs.find((r) => r.runId === runId)?.questionSummary ?? null;

    const [hyp, monitors, markers, outlayer] = await Promise.all([
      readHypothesis(s, workspaceId),
      readMonitors(s, workspaceId, facts.index.selection.x.column, facts.index.selection.y.column),
      readMarkers(s, workspaceId),
      readOutlayer(s, facts.capsuleId),
    ]);
    const inputs = {
      facts,
      workspaceId,
      runId,
      question,
      frozenAt: run.updatedAt,
      verifiedAt: new Date().toISOString(),
      capsuleStatus: cap.verification.local,
      hypothesis: hyp,
      monitors,
      markers,
      outlayer,
      previous: null as PreviousThesis | null,
    };
    inputs.previous = await kernel.db.tx(ctxOf(s), async (tx) => previousOf(tx, workspaceId, runId));
    let built: ReturnType<typeof buildThesis>;
    try {
      built = buildThesis(inputs);
    } catch (e) {
      if (e instanceof ThesisBuildError)
        throw new KernelError("INTERNAL", "THESIS_BUILD_FAILED", `${e.message}`, {
          details: Array.isArray(e.detail)
            ? (e.detail as Array<Record<string, unknown>>).slice(0, 10).map((d) => ({
                path: String(d.rule ?? d.kind ?? "thesis"),
                issue: String(d.detail ?? d.text ?? e.message).slice(0, 300),
              }))
            : [],
        });
      throw e;
    }
    const hash = docHash(built.doc);
    const row = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO theses(org_id, workspace_id, owner_user_id, run_id, capsule_id, version, title, doc, doc_sha256, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'workspace') ON CONFLICT (workspace_id, run_id, version) DO NOTHING RETURNING id`,
        [
          s.principal.orgId,
          workspaceId,
          s.userId,
          runId,
          facts.capsuleId,
          built.version,
          built.title,
          JSON.stringify(built.doc),
          hash,
        ],
      );
      if (ins.rows[0])
        await audit(
          tx,
          s,
          "thesis.build",
          `thesis:${ins.rows[0].id}`,
          { runId, version: built.version },
          workspaceId,
        );
      const r = await tx.query<Row>(
        `SELECT ${COLS} FROM theses WHERE workspace_id = $1 AND run_id = $2 AND version = $3`,
        [workspaceId, runId, built.version],
      );
      return r.rows[0]!;
    });
    return row;
  }

  async function readHypothesis(s: Session, workspaceId: string): Promise<HypothesisInput | null> {
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const r = await tx.query<{
        root_id: string;
        status: string;
        proposition: string;
        falsification: string;
        created_at: Date;
      }>(
        `SELECT DISTINCT ON (root_id) root_id, status, proposition, falsification, created_at FROM hypotheses
          WHERE workspace_id = $1 ORDER BY root_id, version DESC`,
        [workspaceId],
      );
      const rows = r.rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const pick = rows.find((x) => x.status === "frozen") ?? rows[0];
      return pick
        ? {
            id: pick.root_id,
            status: pick.status === "frozen" ? ("frozen" as const) : ("draft" as const),
            proposition: pick.proposition,
            falsification: pick.falsification?.trim() ? pick.falsification : null,
          }
        : null;
    });
  }
  const metricIds = (c: unknown, out: string[] = []): string[] => {
    const o = c as { kind?: string; metricId?: string; terms?: unknown[]; term?: unknown } | null;
    if (!o) return out;
    if (typeof o.metricId === "string") out.push(o.metricId);
    for (const t of o.terms ?? []) metricIds(t, out);
    if (o.term) metricIds(o.term, out);
    return out;
  };
  async function readMonitors(
    s: Session,
    workspaceId: string,
    xCol: string,
    yCol: string,
  ): Promise<MonitorBrief[]> {
    const rules = await kernel.monitoring.listRules(s, workspaceId);
    return rules
      .slice(0, 20)
      .map((r) => {
        const ids = metricIds(r.condition);
        return {
          ruleId: r.ruleId,
          name: r.name,
          sourceId: r.sourceId,
          enabled: r.enabled,
          action: r.action,
          markerId: r.markerId,
          metricIds: ids,
          watchesSeries: ids.some((m) => m === xCol || m === yCol),
        };
      })
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  }
  async function readMarkers(s: Session, workspaceId: string): Promise<MarkerBrief[]> {
    const ms = await kernel.monitoring.listMarkers(s, workspaceId);
    return ms
      .slice(0, 20)
      .map((m) => ({
        markerId: m.markerId,
        question: m.question,
        status: m.status,
        anchorType: m.anchorType,
        timestamp: m.timestamp,
        monitorRuleId: m.monitorRuleId,
      }))
      .sort((a, b) => a.markerId.localeCompare(b.markerId));
  }
  async function readOutlayer(s: Session, capsuleId: string): Promise<OutlayerState | null> {
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const r = await tx.query<{ state: string; request_id: string | null; tx_hash: string | null }>(
        `SELECT state, request_id, tx_hash FROM outlayer_proofs WHERE capsule_id = $1 AND (state IN ('verified','not_attested') OR (state = 'failed' AND tx_hash IS NOT NULL))
          ORDER BY (state = 'verified') DESC, created_at DESC LIMIT 1`,
        [capsuleId],
      );
      return r.rows[0]
        ? { status: r.rows[0].state, requestId: r.rows[0].request_id, txHash: r.rows[0].tx_hash }
        : null;
    });
  }
  async function previousOf(tx: Tx, workspaceId: string, runId: string): Promise<PreviousThesis | null> {
    const r = await tx.query<{ version: string; doc: Doc }>(
      "SELECT version, doc FROM theses WHERE workspace_id = $1 AND NOT (run_id = $2) ORDER BY created_at DESC LIMIT 1",
      [workspaceId, runId],
    );
    const p = r.rows[0];
    if (!p) return null;
    return {
      version: p.version,
      verdict: String(p.doc.verdict?.status ?? ""),
      n: typeof p.doc.test?.n === "number" ? p.doc.test.n : null,
      pearson: typeof p.doc.test?.pearson === "string" ? p.doc.test.pearson : null,
      lag: null,
    };
  }

  // ------------------------------------------------------------------------------------------------------------ routes
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/theses", async (req, reply) => {
    const s = await authenticate(req);
    const body = parseBody(BuildBody, req.body);
    const row = await buildForWorkspace(s, req.params.id, body.runId);
    return reply.status(201).send({
      thesisId: row.id,
      version: row.version,
      status: row.status === "published" ? "published" : "draft",
      verdict: verdictOf(row.doc),
    });
  });

  app.get("/v1/theses", async (req) => {
    const s = await authenticate(req);
    const rows = await kernel.db.tx(ctxOf(s), async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLS} FROM theses ORDER BY created_at DESC, id LIMIT 200`);
      const c = await counts(tx, [REFERENCE_ID, ...r.rows.map((x) => x.id)]);
      return { rows: r.rows, c };
    });
    return {
      items: [
        referenceSummary(rows.c.get(REFERENCE_ID) ?? noCounts),
        ...rows.rows.map((r) => summaryOf(r, s, rows.c.get(r.id) ?? noCounts)),
      ],
    };
  });

  app.post("/v1/theses/import", async (req) => {
    const s = await authenticate(req);
    const { slug } = parseBody(SlugBody, req.body);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const g = (await tx.query<{ id: string }>("SELECT id FROM thesis_public_get($1)", [slug])).rows[0];
      if (!g) throw notFound();
      const own = (
        await tx.query("SELECT 1 FROM theses WHERE id = $1 AND org_id = $2", [g.id, s.principal.orgId])
      ).rows[0];
      let created = false;
      if (!own) {
        const ins = await tx.query(
          "INSERT INTO thesis_imports(user_id, thesis_id) VALUES ($1,$2) ON CONFLICT (user_id, thesis_id) DO NOTHING RETURNING thesis_id",
          [s.userId, g.id],
        );
        created = ins.rows.length > 0;
      }
      const row = await rowOf(tx, g.id);
      const c = await counts(tx, [g.id]);
      return { thesisId: g.id, created, thesis: summaryOf(row, s, c.get(g.id) ?? noCounts) };
    });
  });

  app.get<{ Params: { id: string } }>("/v1/theses/:id", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    if (id === REFERENCE_ID) {
      const ref = loadReference();
      const rec = await kernel.db.tx(ctxOf(s), async (tx) => ({
        c: await counts(tx, [REFERENCE_ID]),
        receipts: await receiptsOf(tx, REFERENCE_ID),
      }));
      return {
        thesis: referenceSummary(rec.c.get(REFERENCE_ID) ?? noCounts),
        doc: ref.doc,
        receipts: rec.receipts,
      };
    }
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const row = await rowOf(tx, id);
      const c = await counts(tx, [id]);
      const doc = row.org_id === s.principal.orgId ? row.doc : publicDoc(row.doc);
      return { thesis: summaryOf(row, s, c.get(id) ?? noCounts), doc, receipts: await receiptsOf(tx, id) };
    });
  });

  const receiptsOf = async (tx: Tx, id: string) =>
    (
      await tx.query<{
        id: string;
        kind: string;
        outcome: string;
        display_name: string | null;
        created_at: Date;
        detail: unknown;
      }>(
        "SELECT id, kind, outcome, display_name, created_at, detail FROM thesis_receipts WHERE thesis_id = $1 ORDER BY created_at DESC, id LIMIT 200",
        [id],
      )
    ).rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      outcome: r.outcome,
      userDisplay: r.display_name,
      createdAt: iso(r.created_at),
      detail: r.detail,
    }));

  app.get<{ Params: { id: string } }>("/v1/theses/:id/receipts", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    return kernel.db.tx(ctxOf(s), async (tx) => {
      if (id !== REFERENCE_ID) await rowOf(tx, id);
      const c = await counts(tx, [id]);
      return { receipts: await receiptsOf(tx, id), counts: c.get(id) ?? noCounts };
    });
  });

  // publish / unpublish ---------------------------------------------------------------------------------------------
  async function ownerRow(tx: Tx, s: Session, id: string): Promise<Row> {
    if (id === REFERENCE_ID)
      throw new KernelError(
        "VALIDATION_FAILED",
        "THESIS_IS_REFERENCE",
        "The reference thesis is pinned and cannot be changed.",
      );
    const row = await rowOf(tx, id);
    if (row.org_id !== s.principal.orgId) throw notFound();
    if (!canWrite(s.role))
      throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
    return row;
  }
  app.post<{ Params: { id: string } }>("/v1/theses/:id/publish", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const row = await ownerRow(tx, s, req.params.id);
      const dir = resolveCapsuleDir(root(), row.capsule_id);
      if (!dir)
        throw new KernelError(
          "VALIDATION_FAILED",
          "THESIS_NOT_PUBLISHABLE",
          "The capsule of this thesis is not available, so it cannot be verified by others.",
        );
      const against =
        (row.doc.sections as Array<{ id: string; markdown: string }> | undefined)?.find(
          (x) => x.id === "evidence-against",
        )?.markdown ?? "";
      if (!against.trim() && !against.includes(UNTESTED_NOTE))
        throw new KernelError(
          "VALIDATION_FAILED",
          "THESIS_NOT_PUBLISHABLE",
          "The thesis has no Evidence against section and not the explicit untested note.",
        );
      const slug = row.share_slug ?? slugOf();
      if (row.status !== "published") {
        await tx.query(
          "UPDATE theses SET status = 'published', share_slug = $2, published_at = now() WHERE id = $1",
          [row.id, slug],
        );
        await audit(tx, s, "thesis.publish", `thesis:${row.id}`, { slug }, row.workspace_id);
      }
      return { shareSlug: slug, publicUrlPath: `/t/${slug}`, status: "published" as const };
    });
  });
  app.post<{ Params: { id: string } }>("/v1/theses/:id/unpublish", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const row = await ownerRow(tx, s, req.params.id);
      if (row.status === "published") {
        await tx.query("UPDATE theses SET status = 'unpublished' WHERE id = $1", [row.id]);
        await audit(tx, s, "thesis.unpublish", `thesis:${row.id}`, {}, row.workspace_id);
      }
      return {
        shareSlug: row.share_slug,
        status: row.status === "draft" ? ("draft" as const) : ("unpublished" as const),
      };
    });
  });

  // verify ---------------------------------------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/theses/:id/verify", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    let checks: Check[];
    if (id === REFERENCE_ID) {
      loadReference();
      checks = verifyReferenceBundle(thesisDir());
    } else {
      const row = await kernel.db.tx(ctxOf(s), (tx) => rowOf(tx, id));
      checks = await verifyWorkspaceThesis(row.doc, row.doc_sha256, row.capsule_id, {
        capsuleDir: (cid) => resolveCapsuleDir(root(), cid),
        proofBinding: proofBinding(s),
        ...(opts.wasmPath ? { wasmPath: opts.wasmPath } : {}),
      });
    }
    const outcome = checks.every((c) => c.ok) ? ("verified" as const) : ("mismatch" as const);
    const receiptId = await kernel.db.tx(ctxOf(s), (tx) =>
      recordReceipt(tx, s, id, "verify", outcome, {
        checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
      }),
    );
    return { outcome, checks, receiptId };
  });

  // compare: :id is the REPRODUCED thesis, `against` the ORIGINAL ----------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/theses/:id/compare", async (req) => {
    const s = await authenticate(req);
    const { against } = parseBody(CompareBody, req.body);
    const id = req.params.id;
    if (id === against)
      throw new KernelError(
        "VALIDATION_FAILED",
        "THESIS_COMPARE_SELF",
        "A thesis cannot be compared with itself.",
      );
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const docOf = async (x: string): Promise<{ doc: Doc; row: Row | null }> => {
        if (x === REFERENCE_ID) return { doc: loadReference().doc, row: null };
        const row = await rowOf(tx, x);
        return { doc: row.doc, row };
      };
      const repro = await docOf(id);
      const orig = await docOf(against);
      const { outcome, rows } = compareDocs(orig.doc, repro.doc);
      const receiptId = await recordReceipt(tx, s, against, "reproduce", outcome, {
        rows: rows.length,
        differing: rows.filter((r) => r.original !== r.reproduced).length,
        reproducedVersion: repro.row?.version ?? null,
      });
      // the caller's own thesis is now known to reproduce `against`
      if (
        repro.row &&
        repro.row.org_id === s.principal.orgId &&
        against !== REFERENCE_ID &&
        !repro.row.source_thesis_id
      )
        await tx.query(
          "UPDATE theses SET kind = 'reproduction', source_thesis_id = $2 WHERE id = $1 AND source_thesis_id IS NULL",
          [id, against],
        );
      return { outcome, rows, receiptId };
    });
  });

  // files ----------------------------------------------------------------------------------------------------------
  const DATA_FILES: Record<string, string> = {
    "data/daily_series.csv": "snapshot/raw/daily_series.csv",
    "data/verifier-input.json": "computation/verifier-input.json",
    "data/results.json": "computation/results.json",
  };
  const TYPES: Record<string, string> = {
    "THESIS.md": "text/markdown; charset=utf-8",
    "thesis.json": "application/json; charset=utf-8",
    "data/daily_series.csv": "text/csv; charset=utf-8",
    "data/verifier-input.json": "application/json; charset=utf-8",
    "data/results.json": "application/json; charset=utf-8",
  };
  function fileOf(
    row: Pick<Row, "doc" | "title" | "capsule_id">,
    rel: string,
    forPublic: boolean,
  ): { body: string | Buffer; sha: string } {
    if (rel === "THESIS.md") {
      const md = renderThesisMarkdown({ title: row.title, doc: row.doc as never });
      return { body: md, sha: sha(md) };
    }
    if (rel === "thesis.json") {
      const text = `${JSON.stringify(forPublic ? publicDoc(row.doc) : row.doc, null, 2)}\n`;
      return { body: text, sha: sha(text) };
    }
    const cap = DATA_FILES[rel];
    if (!cap) throw fileNotFound();
    const dir = resolveCapsuleDir(root(), row.capsule_id);
    const entry = dir
      ? (row.doc.reproduce?.hashes as Array<{ path: string; sha256: string }> | undefined)?.find(
          (h) => h.path === cap,
        )
      : undefined;
    if (!dir || !entry || !existsSync(join(dir, cap))) throw fileNotFound();
    const bytes = readFileSync(join(dir, cap));
    if (sha(bytes) !== entry.sha256)
      throw new KernelError("INTERNAL", "THESIS_FILE_HASH_MISMATCH", "File failed its hash check.");
    return { body: bytes, sha: entry.sha256 };
  }
  const send = (
    reply: FastifyReply,
    rel: string,
    f: { body: string | Buffer; sha: string },
    cache: string,
  ) => {
    void reply
      .header("content-type", TYPES[rel] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("x-thesis-sha256", f.sha)
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      )
      .header("cache-control", cache);
    return reply.send(f.body);
  };
  app.get<{ Params: { id: string; "*": string } }>("/v1/theses/:id/files/*", async (req, reply) => {
    const s = await authenticate(req);
    const rel = req.params["*"];
    if (!(rel in TYPES)) throw fileNotFound();
    if (req.params.id === REFERENCE_ID) {
      const ref = loadReference();
      if (rel === "THESIS.md")
        return send(reply, rel, { body: ref.markdown, sha: sha(ref.markdown) }, "no-cache");
      if (rel === "thesis.json") {
        const p = join(thesisDir(), "build", "thesis.json");
        const b = readFileSync(p);
        return send(reply, rel, { body: b, sha: sha(b) }, "no-cache");
      }
      throw fileNotFound();
    }
    const row = await kernel.db.tx(ctxOf(s), (tx) => rowOf(tx, req.params.id));
    return send(reply, rel, fileOf(row, rel, row.org_id !== s.principal.orgId), "private, no-cache");
  });

  // ------------------------------------------------------------------------------------------- public (no session)
  const limit = opts.perWindow ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { start: number; n: number }>();
  const take = (ip: string): number | null => {
    const t = now();
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
    let b = buckets.get(ip);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      buckets.set(ip, b);
    }
    b.n++;
    return b.n <= limit ? null : Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
  };
  interface PublicRow {
    id: string;
    version: string;
    title: string;
    doc: Doc;
    doc_sha256: string;
    kind: string;
    capsule_id: string;
    published_at: Date;
    owner_display: string | null;
  }
  const publicRow = async (
    req: { ip: string },
    reply: { header(k: string, v: string): unknown },
    slug: string,
  ): Promise<{ row: PublicRow; c: Counts }> => {
    const wait = take(req.ip);
    if (wait !== null) {
      void reply.header("retry-after", String(wait));
      throw new KernelError("RATE_LIMITED", "TOO_MANY_REQUESTS", "Too many requests.", { retryable: true });
    }
    if (!/^[a-z0-9]{12,40}$/.test(slug)) throw notFound();
    return kernel.db.txGlobal(async (tx) => {
      const row = (await tx.query<PublicRow>("SELECT * FROM thesis_public_get($1)", [slug])).rows[0];
      if (!row) throw notFound();
      const c =
        (await tx.query<Counts>("SELECT * FROM thesis_receipt_counts($1)", [row.id])).rows[0] ?? noCounts;
      return { row, c };
    });
  };
  app.get<{ Params: { slug: string } }>("/v1/public/theses/:slug", async (req, reply) => {
    const { row, c } = await publicRow(req, reply, req.params.slug);
    void reply.header("cache-control", "public, max-age=30").header("x-content-type-options", "nosniff");
    return {
      thesis: {
        id: row.id,
        title: row.title,
        hypothesis: String(row.doc.hypothesis ?? ""),
        verdict: verdictOf(row.doc),
        kind: "workspace" as const,
        version: row.version,
        status: "published" as const,
        shareSlug: req.params.slug,
        ownerDisplay: row.owner_display,
        updatedAt: row.published_at.toISOString(),
      },
      doc: publicDoc(row.doc),
      receipts: c,
    };
  });
  app.get<{ Params: { slug: string; "*": string } }>(
    "/v1/public/theses/:slug/files/*",
    async (req, reply) => {
      const { row } = await publicRow(req, reply, req.params.slug);
      const rel = req.params["*"];
      if (!(rel in TYPES)) throw fileNotFound();
      return send(
        reply,
        rel,
        fileOf({ doc: row.doc, title: row.title, capsule_id: row.capsule_id }, rel, true),
        "public, max-age=30",
      );
    },
  );
};

(userThesisRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
