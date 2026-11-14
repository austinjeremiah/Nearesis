import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KernelError } from "@nearesis/kernel";
import type { Session, Tx } from "@nearesis/kernel";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { APP_ROOT } from "@nearesis/capsule";
import { Uuid, assertWorkspace, audit, ctxOf, iso, parseBody, requireWrite } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";
import { getResearchRun, listResearchRuns } from "./research-store.ts";

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Fields = {
  proposition: Text(5, 4000),
  target: z.string().trim().max(2000),
  predictor: z.string().trim().max(2000),
  benchmark: z.string().trim().max(2000),
  falsification: Text(1, 4000),
};
export const CreateBody = z.strictObject(Fields);
export const PatchBody = z.strictObject({
  proposition: Fields.proposition.optional(),
  target: Fields.target.optional(),
  predictor: Fields.predictor.optional(),
  benchmark: Fields.benchmark.optional(),
  falsification: Fields.falsification.optional(),
});
export const FreezeBody = z.strictObject({
  preregistrationHash: Hash.optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export const AmendBody = z.strictObject({ ...PatchBody.shape, reason: Text(5, 1000) });
export const ForkBody = PatchBody.extend({ reason: Text(5, 1000).optional() }).strict();
export const LinkBody = z.strictObject({
  kind: z.enum(["claim", "experiment", "finding"]),
  ref: z.string().trim().min(1).max(200),
});

interface Row {
  id: string;
  org_id: string;
  workspace_id: string;
  root_id: string;
  version: number;
  parent_id: string | null;
  forked_from_id: string | null;
  proposition: string;
  target: string;
  predictor: string;
  benchmark: string;
  falsification: string;
  status: "draft" | "frozen";
  freeze_hash: string | null;
  frozen_at: Date | null;
  frozen_by: string | null;
  preregistration: { hash: string; verified: boolean; source: string; note: string } | null;
  /** The two series and expected sign that test the proposition (null for hypotheses written by hand). */
  test_plan: unknown | null;
  created_by: string;
  created_at: Date;
}

/** Content hash of a frozen version. Chained: an amendment commits to the freeze hash of the version it amends. */
export function freezeHashOf(
  r: Pick<
    Row,
    "root_id" | "version" | "proposition" | "target" | "predictor" | "benchmark" | "falsification"
  >,
  parentFreezeHash: string | null,
  preregistrationHash: string | null,
): string {
  return `sha256:${sha256Hex(
    canonicalJson({
      schema: "hypothesis-freeze@1",
      rootId: r.root_id,
      version: r.version,
      parentFreezeHash,
      proposition: r.proposition,
      target: r.target,
      predictor: r.predictor,
      benchmark: r.benchmark,
      falsification: r.falsification,
      preregistrationHash,
    }),
  )}`;
}

/** Preregistration documents the platform actually holds: research runs' registered rules and the committed freeze files. */
export function knownPreregistrations(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of listResearchRuns()) {
    const h = (r.artifacts.preregistration as { hash?: unknown } | undefined)?.hash;
    if (typeof h === "string") m.set(h, `research-run:${r.runId}`);
  }
  const dir = join(APP_ROOT, "docs", "research");
  if (existsSync(dir))
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".freeze.json"))) {
      try {
        const h = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { documentHash?: unknown }).documentHash;
        if (typeof h === "string" && !m.has(h)) m.set(h, `freeze-file:${f}`);
      } catch {
        /* unreadable freeze file: not a known registration */
      }
    }
  return m;
}

const view = (r: Row) => ({
  hypothesisId: r.root_id,
  versionId: r.id,
  workspaceId: r.workspace_id,
  version: r.version,
  parentVersionId: r.parent_id,
  forkedFromVersionId: r.forked_from_id,
  proposition: r.proposition,
  target: r.target,
  predictor: r.predictor,
  benchmark: r.benchmark,
  falsification: r.falsification,
  status: r.status,
  registered: r.status === "frozen",
  registrationHash: r.freeze_hash,
  registeredAt: iso(r.frozen_at),
  frozenBy: r.frozen_by,
  preregistration: r.preregistration,
  testPlan: r.test_plan ?? null,
  /** A freeze is a content hash with a database timestamp. It is not a chain commitment and does not prove the data was unseen. */
  chainCommitment: "none" as const,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

async function versions(tx: Tx, root: string): Promise<Row[]> {
  return (await tx.query<Row>("SELECT * FROM hypotheses WHERE root_id = $1 ORDER BY version", [root])).rows;
}
async function latest(tx: Tx, workspaceId: string, hid: string): Promise<{ all: Row[]; last: Row }> {
  if (!Uuid.safeParse(hid).success) throw notFound();
  const all = await versions(tx, hid);
  const last = all.at(-1);
  if (!last || last.workspace_id !== workspaceId) throw notFound();
  return { all, last };
}
const notFound = () => new KernelError("NOT_FOUND", "HYPOTHESIS_NOT_FOUND", "No such hypothesis.");
const frozenErr = () =>
  new KernelError("DOMAIN_INVARIANT", "HYPOTHESIS_FROZEN", "A frozen hypothesis is never edited.", {
    nextAction:
      "POST /hypotheses/:id/amend creates a new version; POST /hypotheses/:id/fork starts a new line.",
  });

async function links(tx: Tx, root: string) {
  const r = await tx.query<{ id: string; kind: string; ref: string; created_at: Date; created_by: string }>(
    "SELECT id, kind, ref, created_at, created_by FROM hypothesis_links WHERE root_id = $1 ORDER BY created_at, id",
    [root],
  );
  return r.rows.map((l) => ({
    linkId: l.id,
    kind: l.kind,
    ref: l.ref,
    createdAt: iso(l.created_at),
    createdBy: l.created_by,
  }));
}

/** Verdict and strength come from linked research runs only; none linked means null, not a default. */
function researchOutcome(ls: Array<{ kind: string; ref: string }>) {
  for (const l of ls) {
    if (l.kind !== "experiment") continue;
    const run = getResearchRun(l.ref);
    if (run && run.integrity === "verified")
      return {
        verdict: (run.run.status as string | undefined) ?? null,
        strength: (run.run.evidenceStrength as string | undefined) ?? null,
      };
  }
  return { verdict: null, strength: null };
}

/**
 * Creates a draft hypothesis (version 1) and its audit record inside the caller's transaction. Shared by the route above and the
 * assistant setup, so both validate and audit identically. `id` is for idempotent callers; the default is a fresh id.
 */
export async function insertDraftHypothesis(
  tx: Tx,
  s: Session,
  ws: { id: string; orgId: string },
  b: z.infer<typeof CreateBody>,
  id: string = randomUUID(),
  testPlan: unknown | null = null,
) {
  const r = await tx.query<Row>(
    `INSERT INTO hypotheses(id, org_id, workspace_id, root_id, version, proposition, target, predictor, benchmark, falsification, created_by, test_plan)
     VALUES ($1,$2,$3,$1,1,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      id,
      ws.orgId,
      ws.id,
      b.proposition,
      b.target,
      b.predictor,
      b.benchmark,
      b.falsification,
      s.userId,
      testPlan === null ? null : JSON.stringify(testPlan),
    ],
  );
  await audit(tx, s, "hypothesis.created", `hypothesis:${id}`, { version: 1 }, ws.id);
  return view(r.rows[0]!);
}

/**
 * Hypotheses (ch.02 preregistration protocol, ch.10 claims). Versions are rows: a frozen row is immutable in the database (trigger),
 * an amendment is a new row chained to the frozen hash, a fork starts a new line. Routes:
 *   GET  /v1/workspaces/:id/hypotheses                         latest version per hypothesis
 *   POST /v1/workspaces/:id/hypotheses                         create a draft
 *   GET  /v1/workspaces/:id/hypotheses/:hid                    latest + all versions + links
 *   PATCH /v1/workspaces/:id/hypotheses/:hid                   edit the open draft (422 HYPOTHESIS_FROZEN otherwise)
 *   POST /v1/workspaces/:id/hypotheses/:hid/freeze             hash and freeze the draft, optional preregistration link
 *   POST /v1/workspaces/:id/hypotheses/:hid/amend              new draft version from the latest frozen one
 *   POST /v1/workspaces/:id/hypotheses/:hid/fork               new hypothesis line copied from the latest version
 *   POST /v1/workspaces/:id/hypotheses/:hid/links              link an evidence-graph claim, a research run or a finding (append-only)
 *   GET  /v1/workspaces/:id/hypotheses/:hid/verify             recompute every frozen hash
 */
export const hypothesisRoutes: FastifyPluginAsync<ProductDeps> = async (app, { kernel, authenticate }) => {
  type P = { Params: { id: string } };
  type PH = { Params: { id: string; hid: string } };

  app.get<P>("/v1/workspaces/:id/hypotheses", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const rows = (
        await tx.query<Row>(
          `SELECT DISTINCT ON (root_id) * FROM hypotheses WHERE workspace_id = $1 ORDER BY root_id, version DESC`,
          [ws.id],
        )
      ).rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      const lk = (
        await tx.query<{ root_id: string; kind: string; ref: string }>(
          "SELECT root_id, kind, ref FROM hypothesis_links WHERE workspace_id = $1",
          [ws.id],
        )
      ).rows;
      return {
        workspaceId: ws.id,
        hypotheses: rows.map((r) => {
          const mine = lk.filter((l) => l.root_id === r.root_id);
          return {
            ...view(r),
            experimentCount: mine.filter((l) => l.kind === "experiment").length,
            claimCount: mine.filter((l) => l.kind === "claim").length,
            ...researchOutcome(mine),
          };
        }),
      };
    });
  });

  app.post<P>("/v1/workspaces/:id/hypotheses", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(CreateBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      return insertDraftHypothesis(tx, s, ws, b);
    });
    return reply.status(201).send(out);
  });

  app.get<PH>("/v1/workspaces/:id/hypotheses/:hid", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { all, last } = await latest(tx, req.params.id, req.params.hid);
      const ls = await links(tx, last.root_id);
      return { ...view(last), versions: all.map(view), links: ls, ...researchOutcome(ls) };
    });
  });

  app.patch<PH>("/v1/workspaces/:id/hypotheses/:hid", async (req) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(PatchBody, req.body);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { last } = await latest(tx, req.params.id, req.params.hid);
      if (last.status === "frozen") throw frozenErr();
      const m = {
        ...last,
        ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
      } as Row;
      const r = await tx.query<Row>(
        `UPDATE hypotheses SET proposition=$2, target=$3, predictor=$4, benchmark=$5, falsification=$6 WHERE id=$1 RETURNING *`,
        [last.id, m.proposition, m.target, m.predictor, m.benchmark, m.falsification],
      );
      await audit(
        tx,
        s,
        "hypothesis.edited",
        `hypothesis:${last.root_id}`,
        { version: last.version },
        req.params.id,
      );
      return view(r.rows[0]!);
    });
  });

  app.post<PH>("/v1/workspaces/:id/hypotheses/:hid/freeze", async (req) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(FreezeBody, req.body);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { all, last } = await latest(tx, req.params.id, req.params.hid);
      if (last.status === "frozen") throw frozenErr();
      if (b.expectedVersion !== undefined && b.expectedVersion !== last.version)
        throw new KernelError(
          "STALE_VERSION",
          "STALE_HYPOTHESIS_VERSION",
          "The hypothesis changed since it was read.",
          {
            retryable: true,
          },
        );
      const parent = last.parent_id ? all.find((v) => v.id === last.parent_id) : undefined;
      let pre: Row["preregistration"] = null;
      if (b.preregistrationHash) {
        const src = knownPreregistrations().get(b.preregistrationHash);
        pre = src
          ? {
              hash: b.preregistrationHash,
              verified: true,
              source: src,
              note: "Matches a preregistration document held by the platform.",
            }
          : {
              hash: b.preregistrationHash,
              verified: false,
              source: "user_supplied",
              note: "Hash not found among the platform's registered documents; recorded as supplied, not verified.",
            };
      }
      const hash = freezeHashOf(last, parent?.freeze_hash ?? null, pre?.hash ?? null);
      const r = await tx.query<Row>(
        `UPDATE hypotheses SET status='frozen', freeze_hash=$2, frozen_at=now(), frozen_by=$3, preregistration=$4 WHERE id=$1 RETURNING *`,
        [last.id, hash, s.userId, pre ? JSON.stringify(pre) : null],
      );
      await audit(
        tx,
        s,
        "hypothesis.frozen",
        `hypothesis:${last.root_id}`,
        { version: last.version, hash, preregistration: pre?.hash ?? null },
        req.params.id,
      );
      return view(r.rows[0]!);
    });
  });

  app.post<PH>("/v1/workspaces/:id/hypotheses/:hid/amend", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const { reason, ...changes } = parseBody(AmendBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { last } = await latest(tx, req.params.id, req.params.hid);
      if (last.status !== "frozen")
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "HYPOTHESIS_NOT_FROZEN",
          "Only a frozen hypothesis is amended; edit the draft instead.",
        );
      const m = {
        ...last,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      } as Row;
      const id = randomUUID();
      const r = await tx.query<Row>(
        `INSERT INTO hypotheses(id, org_id, workspace_id, root_id, version, parent_id, proposition, target, predictor, benchmark, falsification, created_by, test_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          id,
          last.org_id,
          last.workspace_id,
          last.root_id,
          last.version + 1,
          last.id,
          m.proposition,
          m.target,
          m.predictor,
          m.benchmark,
          m.falsification,
          s.userId,
          m.proposition === last.proposition && last.test_plan ? JSON.stringify(last.test_plan) : null,
        ],
      );
      await audit(
        tx,
        s,
        "hypothesis.amended",
        `hypothesis:${last.root_id}`,
        { fromVersion: last.version, toVersion: last.version + 1, reason },
        req.params.id,
      );
      return view(r.rows[0]!);
    });
    return reply.status(201).send(out);
  });

  app.post<PH>("/v1/workspaces/:id/hypotheses/:hid/fork", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const { reason, ...changes } = parseBody(ForkBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { last } = await latest(tx, req.params.id, req.params.hid);
      const m = {
        ...last,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      } as Row;
      const id = randomUUID();
      const r = await tx.query<Row>(
        `INSERT INTO hypotheses(id, org_id, workspace_id, root_id, version, forked_from_id, proposition, target, predictor, benchmark, falsification, created_by, test_plan)
         VALUES ($1,$2,$3,$1,1,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          last.org_id,
          last.workspace_id,
          last.id,
          m.proposition,
          m.target,
          m.predictor,
          m.benchmark,
          m.falsification,
          s.userId,
          m.proposition === last.proposition && last.test_plan ? JSON.stringify(last.test_plan) : null,
        ],
      );
      await audit(
        tx,
        s,
        "hypothesis.forked",
        `hypothesis:${id}`,
        { from: last.id, fromRoot: last.root_id, reason: reason ?? null },
        req.params.id,
      );
      return view(r.rows[0]!);
    });
    return reply.status(201).send(out);
  });

  app.post<PH>("/v1/workspaces/:id/hypotheses/:hid/links", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(LinkBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { last } = await latest(tx, req.params.id, req.params.hid);
      if (b.kind === "claim") {
        const n = Uuid.safeParse(b.ref).success
          ? (
              await tx.query(
                "SELECT 1 FROM evidence_nodes WHERE id=$1 AND workspace_id=$2 AND kind='claim' AND tombstone=false",
                [b.ref, last.workspace_id],
              )
            ).rows[0]
          : undefined;
        if (!n) throw new KernelError("NOT_FOUND", "CLAIM_NOT_FOUND", "No such claim in this workspace.");
      } else if (b.kind === "experiment") {
        const run = getResearchRun(b.ref);
        if (!run) throw new KernelError("NOT_FOUND", "EXPERIMENT_NOT_FOUND", "No such research run.");
        if (run.integrity !== "verified")
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "EXPERIMENT_INTEGRITY_FAILED",
            "The research run's artifacts fail their recorded hashes.",
          );
      } else {
        const f = Uuid.safeParse(b.ref).success
          ? await tx
              .query("SELECT 1 FROM runtime.run_findings WHERE id=$1 AND workspace_id=$2", [
                b.ref,
                last.workspace_id,
              ])
              .catch(() => ({ rows: [] }))
          : { rows: [] };
        if (!f.rows[0])
          throw new KernelError("NOT_FOUND", "FINDING_NOT_FOUND", "No such finding in this workspace.");
      }
      const id = randomUUID();
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO hypothesis_links(id, org_id, workspace_id, root_id, kind, ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (root_id, kind, ref) DO NOTHING RETURNING id`,
        [id, last.org_id, last.workspace_id, last.root_id, b.kind, b.ref, s.userId],
      );
      if (ins.rows[0] && b.kind === "claim") {
        // Mirror the link into the evidence graph so the graph view shows hypothesis -> claim.
        await tx.query(
          `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data) VALUES ($1,$2,$3,'hypothesis',$4,$5)
           ON CONFLICT (id) DO NOTHING`,
          [
            last.root_id,
            last.org_id,
            last.workspace_id,
            last.proposition.slice(0, 500),
            JSON.stringify({ hypothesisId: last.root_id }),
          ],
        );
        await tx.query(
          `INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation, created_by, reason)
           VALUES ($1,$2,$3,$4,$5,'references',$6,'hypothesis link') ON CONFLICT (workspace_id, from_node, to_node, relation) DO NOTHING`,
          [randomUUID(), last.org_id, last.workspace_id, last.root_id, b.ref, s.userId],
        );
      }
      if (ins.rows[0])
        await audit(
          tx,
          s,
          "hypothesis.linked",
          `hypothesis:${last.root_id}`,
          { kind: b.kind, ref: b.ref },
          req.params.id,
        );
      return { links: await links(tx, last.root_id) };
    });
    return reply.status(201).send(out);
  });

  app.get<PH>("/v1/workspaces/:id/hypotheses/:hid/verify", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      await assertWorkspace(tx, req.params.id);
      const { all, last } = await latest(tx, req.params.id, req.params.hid);
      const byId = new Map(all.map((v) => [v.id, v]));
      const checks = all
        .filter((v) => v.status === "frozen")
        .map((v) => {
          const recomputed = freezeHashOf(
            v,
            v.parent_id ? (byId.get(v.parent_id)?.freeze_hash ?? null) : null,
            v.preregistration?.hash ?? null,
          );
          return {
            version: v.version,
            stored: v.freeze_hash,
            recomputed,
            match: recomputed === v.freeze_hash,
          };
        });
      return { hypothesisId: last.root_id, intact: checks.every((c) => c.match), checks };
    });
  });
};
