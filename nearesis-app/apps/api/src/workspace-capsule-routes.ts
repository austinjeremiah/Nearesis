import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PanelDataResponse } from "@nearesis/contracts";
import { KernelError, canWrite, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  APP_ROOT,
  NotCapsulable,
  SERIES_RULE,
  buildWorkspaceRunCapsule,
  isCapsulePublic,
  readCapsuleOwnership,
  readCapsulePublicationState,
  readManifest,
  verifyCapsule,
  workspaceRunCapsuleId,
  writeCapsuleOwnership,
} from "@nearesis/capsule";
import type { RunFinding, RunPanel, TestPlan, TestRequest } from "@nearesis/capsule";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { analyticsPanel, createPanelDataPort, semanticPanel } from "./panel-data.ts";
import type { PanelDataPort } from "./panel-data.ts";
import { PROOF_COLUMNS, rowToProof } from "./proof-view.ts";
import type { ProofRow } from "./proof-view.ts";
import { describePublications, loadAnchors, publishRoot } from "./publication-trust.ts";
import { Uuid, audit, ctxOf, parseBody } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";
import type { RunsService } from "./runs.ts";

/**
 * Capsule from a workspace run (agent v2 contract, part B):
 *   POST /v1/workspaces/:id/capsules  { runId }   editor+, idempotent per (workspace, run) -> 201 new / 200 existing
 *   GET  /v1/workspaces/:id/capsules              the workspace's capsules with proof and publication status
 * The capsule is built by `buildWorkspaceRunCapsule` (packages/capsule/src/workspace-run.ts, which documents the series rule)
 * from the COMPLETE run's panel result tables exactly as `GET /v1/workspaces/:id/panels/:hash/data` returns them.
 */
export interface WorkspaceCapsuleRoutesOptions extends ProductDeps {
  runs: RunsService;
  /** Test seam; default: the guarded semantic gateway and analytics capabilities, created on first use. */
  panelData?: PanelDataPort;
  /** Test seam: capsule root (default NEARESIS_CAPSULE_DIR or <app>/.data/capsules). */
  capsuleRoot?: () => string;
  /** Test seam: the pinned verifier wasm. */
  wasmPath?: string;
}

const Pair = z.strictObject({
  panelHash: z.string().regex(/^[0-9a-f]{64}$/),
  column: z.string().min(1).max(200),
});
/** An explicit test: used instead of the rule; the selection record says the person chose it. */
export const TestBody = z.strictObject({
  x: Pair,
  y: Pair,
  lagDays: z.number().int().min(0).max(30).optional(),
  expectedSign: z.enum(["positive", "negative", "either"]).optional(),
  /** Recorded with a plan the server drafted (default: the person chose the pair). */
  chosenBy: z.enum(["user", "planner", "rule"]).optional(),
  statement: z
    .string()
    .max(300)
    .regex(/^[\x20-\x7e]*$/)
    .optional(),
});
const Body = z.strictObject({ runId: z.uuid(), test: TestBody.optional() });
const defaultRoot = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");

/** How the pair of a stored capsule was chosen, read from its own record (`legacy`: the original longest-overlap rule). */
export interface SelectionView {
  rule: string;
  chosenBy: "planner" | "user" | "rule" | "legacy";
  namedForQuestion: boolean;
  plan: TestPlan | null;
  rounding: unknown;
}
export interface WorkspaceCapsuleView {
  capsuleId: string;
  capsuleHash: string;
  label: string;
  title: string;
  verifier: {
    x: { name: string; unit: string; points: number };
    y: { name: string; unit: string; points: number };
    window: { from: string; to: string };
    metrics: string[];
  };
}

/** The response view of a stored capsule, read from its own files (so a repeat call answers exactly like the first). */
export function capsuleViewOf(
  dir: string,
): (WorkspaceCapsuleView & { runId: string | null; selection: SelectionView }) | null {
  const m = readManifest(dir);
  if (!m) return null;
  const input = JSON.parse(readFileSync(join(dir, m.computation.inputFile.path), "utf8")) as {
    series: Record<"x" | "y", { name: string; unit: string; points: Array<[string, string]> }>;
  };
  const pts = input.series.x.points;
  let runId: string | null;
  let selection: SelectionView = {
    rule: SERIES_RULE,
    chosenBy: "legacy",
    namedForQuestion: false,
    plan: null,
    rounding: null,
  };
  try {
    const rp = JSON.parse(readFileSync(join(dir, "snapshot", "raw", "run-panels.json"), "utf8")) as {
      runId?: string;
      selection?: {
        chosenBy?: SelectionView["chosenBy"];
        namedForQuestion?: boolean;
        plan?: TestPlan | null;
        rounding?: unknown;
      };
    };
    runId = rp.runId ?? null;
    selection = {
      rule: SERIES_RULE,
      chosenBy: rp.selection?.chosenBy ?? "legacy",
      namedForQuestion: rp.selection?.namedForQuestion === true,
      plan: rp.selection?.plan ?? null,
      rounding: rp.selection?.rounding ?? null,
    };
  } catch {
    runId = null;
  }
  return {
    capsuleId: m.capsuleId,
    capsuleHash: m.capsuleHash,
    label: m.label,
    title: m.title,
    verifier: {
      x: { name: input.series.x.name, unit: input.series.x.unit, points: pts.length },
      y: { name: input.series.y.name, unit: input.series.y.unit, points: input.series.y.points.length },
      window: { from: pts[0]![0], to: pts[pts.length - 1]![0] },
      metrics: m.computation.metrics,
    },
    runId,
    selection,
  };
}

const gatewaySession = (s: Session, workspaceId: string) => ({
  tenantId: s.principal.orgId,
  workspaceId,
  principalId: s.userId,
  aclClasses: ["human"],
});

/** One panel's response, exactly as the panel-data route builds it (same dispatch on the stored query kind). */
export async function readPanel(
  port: PanelDataPort,
  s: Session,
  workspaceId: string,
  hash: string,
): Promise<Record<string, unknown>> {
  const stored = await port.stored(hash);
  if (!stored) throw new KernelError("NOT_FOUND", "QUERY_UNKNOWN", "No stored query has this hash.");
  let body: Omit<PanelDataResponse, "workspaceId">;
  if (stored.kind === "analytics") {
    const r = await port.analytics(hash);
    if (r.status === 404) throw new KernelError("NOT_FOUND", r.body.reasonCode, r.body.message);
    if (r.status === 422) throw new KernelError("DOMAIN_INVARIANT", r.body.reasonCode, r.body.message);
    if (r.status !== 200)
      throw new KernelError("UPSTREAM_DEGRADED", r.body.reasonCode, r.body.message, { retryable: true });
    body = analyticsPanel(hash, r.body);
  } else {
    const r = await port.query(gatewaySession(s, workspaceId), stored.ast, stored.source);
    if (!r.ok)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        r.error.reasonCode ?? "PANEL_DATA_UNAVAILABLE",
        "Panel data unavailable.",
        {
          retryable: true,
        },
      );
    body = semanticPanel(r.envelope, stored.ast, port.registry(stored.source), stored.source);
  }
  return JSON.parse(JSON.stringify({ workspaceId, ...body })) as Record<string, unknown>;
}

interface ComposerPanel {
  hash: string;
  title: string;
  /** First y of the panel's canvas encoding. */
  primaryColumn?: string;
}
/** The panels the run's composer put on the canvas, in canvas order, one per query hash. */
function panelsOfProposal(proposal: unknown): ComposerPanel[] {
  const ops =
    (proposal as { patch?: { operations?: Array<Record<string, unknown>> } } | null)?.patch?.operations ?? [];
  const seen = new Set<string>();
  const out: ComposerPanel[] = [];
  for (const op of ops) {
    if (op.op !== "addPanel") continue;
    const sp = op.panel as
      { title?: string; queryRef?: { hash?: string }; encoding?: { y?: unknown } } | undefined;
    const hash = sp?.queryRef?.hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const y0 = Array.isArray(sp?.encoding?.y) ? (sp!.encoding!.y as unknown[])[0] : undefined;
    out.push({
      hash,
      title: sp?.title ?? "Panel",
      ...(typeof y0 === "string" && y0 ? { primaryColumn: y0 } : {}),
    });
  }
  return out;
}

export interface BuildDeps {
  kernel: Kernel;
  runs: RunsService;
  panelData: PanelDataPort;
  root: string;
  wasmPath?: string;
}
export interface BuildResult {
  created: boolean;
  view: WorkspaceCapsuleView & { runId: string | null; selection: SelectionView };
  verification: {
    local: "reproduced";
    wasm: "crosschecked" | "skipped_wasmtime_unavailable";
    checks: string[];
    notes: string[];
  };
  selection: SelectionView;
}

const inflight = new Map<string, Promise<BuildResult>>();

/**
 * Builds (or finds) the capsule of a COMPLETE run. Also called directly by scripts and the agent executor.
 * Errors: 404 workspace/run, 403 viewer, 422 RUN_NOT_COMPLETE / INTERPRETATION_NOT_READY / RUN_NOT_CAPSULABLE.
 */
export async function createWorkspaceCapsule(
  deps: BuildDeps,
  s: Session,
  workspaceId: string,
  runId: string,
  test?: TestRequest,
): Promise<BuildResult> {
  const { kernel } = deps;
  if (!Uuid.safeParse(workspaceId).success) throw workspaceNotFound();
  let objective: string | null;
  try {
    objective =
      ((await kernel.workspaces.get(s, workspaceId)) as { objective?: string | null }).objective ?? null;
  } catch (e) {
    if (e instanceof KernelError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND"))
      throw workspaceNotFound();
    throw e;
  }
  if (!canWrite(s.role))
    throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
  let run: Awaited<ReturnType<RunsService["getRun"]>>;
  try {
    run = await deps.runs.getRun(s, runId);
  } catch (e) {
    if (e instanceof KernelError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN"))
      throw new KernelError("NOT_FOUND", "RUN_NOT_IN_WORKSPACE", "No such run in this workspace.");
    throw e;
  }
  if (run.workspaceId !== workspaceId)
    throw new KernelError("NOT_FOUND", "RUN_NOT_IN_WORKSPACE", "No such run in this workspace.");
  if (run.state !== "COMPLETE")
    throw new KernelError("VALIDATION_FAILED", "RUN_NOT_COMPLETE", `The run is ${run.state}, not COMPLETE.`);
  if (run.interpretation.state !== "ready" || !run.findings.length)
    throw new KernelError(
      "VALIDATION_FAILED",
      "INTERPRETATION_NOT_READY",
      "The run has no ready interpretation to build a capsule from.",
    );

  const capsuleId = workspaceRunCapsuleId(workspaceId, runId, test);
  const existing = (): BuildResult | null => {
    const d = resolveCapsuleDir(deps.root, capsuleId);
    const owner = d ? readCapsuleOwnership(d) : null;
    if (!d || !owner) return null;
    if (owner.orgId !== s.principal.orgId || owner.workspaceId !== workspaceId) return null;
    const view = capsuleViewOf(d);
    return view
      ? {
          created: false,
          view,
          verification: { local: "reproduced", wasm: "crosschecked", checks: [], notes: [] },
          selection: view.selection,
        }
      : null;
  };
  const have = existing();
  if (have) {
    // A repeat reports the real current state of the local verification, not a remembered one.
    const d = resolveCapsuleDir(deps.root, capsuleId)!;
    const rep = await verifyCapsule(d, {
      research: "skip",
      wasm: "crosscheck",
      ...(deps.wasmPath ? { wasmPath: deps.wasmPath } : {}),
    });
    return { ...have, verification: verificationOf(rep) };
  }
  const key = `${s.principal.orgId}:${capsuleId}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = buildNew(deps, s, workspaceId, runId, capsuleId, run, test, objective).finally(() =>
    inflight.delete(key),
  );
  inflight.set(key, job);
  return job;
}

function verificationOf(rep: Awaited<ReturnType<typeof verifyCapsule>>): BuildResult["verification"] {
  if (rep.status !== "reproduced")
    throw new KernelError(
      "INTERNAL",
      "CAPSULE_NOT_REPRODUCED",
      `Local verification of the capsule failed: ${rep.failures.map((f) => f.kind).join(", ")}.`,
    );
  const crossed = rep.checks.includes("wasmtimeLocalCrossCheck");
  return {
    local: "reproduced",
    wasm: crossed ? "crosschecked" : "skipped_wasmtime_unavailable",
    checks: rep.checks,
    notes: rep.notes,
  };
}

async function buildNew(
  deps: BuildDeps,
  s: Session,
  workspaceId: string,
  runId: string,
  capsuleId: string,
  run: Awaited<ReturnType<RunsService["getRun"]>>,
  test: TestRequest | undefined,
  objective: string | null,
): Promise<BuildResult> {
  const { kernel } = deps;
  const proposal = await kernel.db.tx(ctxOf(s), async (tx) => {
    const r = await tx.query<{ proposal: unknown }>(
      "SELECT result->'result'->'proposal' AS proposal FROM runtime.tasks WHERE run_id=$1 AND role='composer' AND status='DONE' ORDER BY created_at LIMIT 1",
      [runId],
    );
    return r.rows[0]?.proposal ?? null;
  });
  const composed = panelsOfProposal(proposal);
  if (!composed.length)
    throw new KernelError(
      "VALIDATION_FAILED",
      "RUN_NOT_CAPSULABLE",
      "The run has no result panels to build a capsule from.",
    );
  const panels: RunPanel[] = [];
  for (const p of composed) {
    try {
      panels.push({
        hash: p.hash,
        title: p.title,
        body: await readPanel(deps.panelData, s, workspaceId, p.hash),
        ...(p.primaryColumn ? { primaryColumn: p.primaryColumn } : {}),
      });
    } catch (e) {
      if (e instanceof KernelError)
        throw new KernelError(
          "UPSTREAM_DEGRADED",
          "PANEL_DATA_UNAVAILABLE",
          `Panel "${p.title}" could not be read (${e.reasonCode}); nothing was built.`,
          { retryable: true },
        );
      throw e;
    }
  }
  const tmpRoot = join(deps.root, `.build-${randomUUID()}`);
  mkdirSync(deps.root, { recursive: true });
  try {
    let built: ReturnType<typeof buildWorkspaceRunCapsule>;
    const question = await questionOf(deps, s, workspaceId, runId);
    try {
      built = buildWorkspaceRunCapsule(
        {
          workspaceId,
          runId,
          source: run.source,
          frozenAt: run.updatedAt,
          question,
          panels,
          findings: run.findings as unknown as RunFinding[],
          ...(test ? { test } : {}),
          chooserText: [objective, question]
            .filter(
              (x): x is string => !!x && !/^Investigation [0-9a-f]{8}$/.test(x) && x !== "investigation",
            )
            .join(". "),
        },
        tmpRoot,
        deps.wasmPath ? { wasmPath: deps.wasmPath } : {},
      );
    } catch (e) {
      if (e instanceof NotCapsulable && e.reason.startsWith("TEST_PAIR_NOT_FOUND"))
        throw new KernelError(
          "VALIDATION_FAILED",
          "TEST_PAIR_UNAVAILABLE",
          e.reason.replace(/^TEST_PAIR_NOT_FOUND: /, ""),
          {
            details: [{ path: "test", issue: e.reason }],
          },
        );
      if (e instanceof NotCapsulable)
        throw new KernelError("VALIDATION_FAILED", "RUN_NOT_CAPSULABLE", e.reason, {
          details: [{ path: "runId", issue: e.reason }],
        });
      throw e;
    }
    writeCapsuleOwnership(tmpRoot, { orgId: s.principal.orgId, workspaceId });
    const rep = await verifyCapsule(tmpRoot, {
      research: "skip",
      wasm: "crosscheck",
      ...(deps.wasmPath ? { wasmPath: deps.wasmPath } : {}),
    });
    const verification = verificationOf(rep);
    const target = join(deps.root, capsuleId);
    try {
      renameSync(tmpRoot, target);
    } catch (e) {
      // lost a race with another process building the same capsule: that one is the capsule
      if (!existsSync(join(target, "manifest.json"))) throw e;
    }
    await kernel.db.tx(ctxOf(s), (tx) =>
      audit(
        tx,
        s,
        "capsule.build",
        `capsule:${capsuleId}`,
        { runId, capsuleHash: built.manifest.capsuleHash },
        workspaceId,
      ),
    );
    const view = capsuleViewOf(target);
    if (!view)
      throw new KernelError("INTERNAL", "CAPSULE_UNREADABLE", "The built capsule could not be read back.");
    return { created: true, view, verification, selection: view.selection };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function questionOf(
  deps: BuildDeps,
  s: Session,
  workspaceId: string,
  runId: string,
): Promise<string | null> {
  const list = await deps.runs.listRuns(s, workspaceId);
  return list.runs.find((r) => r.runId === runId)?.questionSummary ?? null;
}

export const workspaceCapsuleRoutes: FastifyPluginAsync<WorkspaceCapsuleRoutesOptions> = async (
  app,
  opts,
) => {
  const { kernel, authenticate, runs } = opts;
  let port: PanelDataPort | null = opts.panelData ?? null;
  const data = () => (port ??= createPanelDataPort());
  app.addHook("onClose", async () => {
    if (!opts.panelData) await port?.close();
  });
  const root = (): string => (opts.capsuleRoot ?? defaultRoot)();

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/capsules", async (req, reply) => {
    const s = await authenticate(req);
    const body = parseBody(Body, req.body);
    const r = await createWorkspaceCapsule(
      {
        kernel,
        runs,
        panelData: data(),
        root: root(),
        ...(opts.wasmPath ? { wasmPath: opts.wasmPath } : {}),
      },
      s,
      req.params.id,
      body.runId,
      body.test ? ({ ...body.test, chosenBy: body.test.chosenBy ?? "user" } as TestRequest) : undefined,
    );
    const { runId: _runId, ...view } = r.view;
    return reply.status(r.created ? 201 : 200).send({
      ...view,
      runId: body.runId,
      created: r.created,
      verification: r.verification,
      selection: r.selection,
    });
  });

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/capsules", async (req) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    try {
      await kernel.workspaces.get(s, req.params.id);
    } catch (e) {
      if (e instanceof KernelError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND"))
        throw workspaceNotFound();
      throw e;
    }
    const dir = root();
    const names = existsSync(dir) ? readdirSync(dir).sort() : [];
    const mine: Array<{ d: string; v: NonNullable<ReturnType<typeof capsuleViewOf>> }> = [];
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const d = join(dir, n);
      const owner = readCapsuleOwnership(d);
      if (!owner || owner.orgId !== s.principal.orgId || owner.workspaceId !== req.params.id) continue;
      const v = capsuleViewOf(d);
      if (v) mine.push({ d, v });
    }
    const ids = mine.map((x) => x.v.capsuleId);
    const proofs = ids.length
      ? await kernel.db.tx(ctxOf(s), async (tx) => {
          const r = await tx.query<ProofRow>(
            `SELECT ${PROOF_COLUMNS} FROM outlayer_proofs WHERE capsule_id = ANY($1::text[]) ORDER BY created_at DESC, id`,
            [ids],
          );
          return r.rows.map(rowToProof);
        })
      : [];
    const anchors = mine.length ? await loadAnchors(kernel) : [];
    const items = mine.map(({ d, v }) => {
      const state = readCapsulePublicationState(d);
      return {
        ...v,
        createdAt: readManifest(d)!.createdAt,
        proofs: proofs.filter((p) => p.capsuleId === v.capsuleId),
        publication: {
          state: state?.state ?? "none",
          public: isCapsulePublic(d),
          at: state?.at ?? null,
          badge: state?.badge ?? null,
          versions: describePublications(join(publishRoot(), v.capsuleId), anchors).map((p) => ({
            version: p.version,
            manifestHash: p.manifestHash,
            capsuleHash: p.capsuleHash,
            signedAt: p.signature.signedAt,
            anchor: p.anchor,
          })),
        },
      };
    });
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.capsuleId.localeCompare(b.capsuleId));
    return { workspaceId: req.params.id, capsules: items };
  });
};
