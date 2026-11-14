import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CollabTicketRequest,
  MIN_QUESTION_BUDGET,
  QuestionPreviewRequest,
  type CanvasPreviewResponse,
  type CollabTicketResponse,
  type PanelDataResponse,
  type QuestionPreviewResponse,
} from "@nearesis/contracts";
import { KernelError, canWrite, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { previewHash, validateCanvasPatchSemantics } from "@nearesis/canvas-schema";
import { composerBudget } from "@nearesis/workflow";
import { CollabTicketStore } from "./collab-ticket.ts";
import {
  analyticsPanel,
  createPanelDataPort,
  semanticPanel,
  type PanelDataPort,
} from "./panel-data.ts";

export interface FrontendRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam. Default: the guarded semantic gateway and analytics capabilities, created on first use. */
  panelData?: PanelDataPort;
  /** True when a workflow engine is wired: otherwise a question cannot start (reported by the plan preview). */
  engineAvailable: boolean;
}

const Uuid = z.uuid();
const Hash = /^[0-9a-f]{64}$/;
const SourceQ = z.object({ source: z.enum(["fixture", "live"]).optional() });
const gatewaySession = (s: Session, workspaceId: string) => ({
  tenantId: s.principal.orgId,
  workspaceId,
  principalId: s.userId,
  aclClasses: ["human"],
});

/** The plan a live question runs: one composer branch, then an approval-gated canvas apply (see workflow `planTask`). */
const LIVE_COMPOSER_CAPABILITIES = [
  "canvas.preview@1",
  "intents.analyze@1",
  "entities.analyze@1",
  "accounts.analyze@1",
];
const SCRIPTED = /\[scenario=(?!none\])/;

/**
 * The routes a standalone frontend needs on top of the kernel API (contracts 1.9.0):
 *   GET  /v1/workspaces/:id/panels/:hash/data       one route for semantic and analytics panels (dispatch on the stored kind)
 *   POST /v1/workspaces/:id/canvas/preview          pure patch validation + query cost estimate (no write, event, run or spend)
 *   POST /v1/workspaces/:id/questions/preview       plan without starting a run (deterministic; zero model calls, zero spend)
 *   POST /v1/workspaces/:id/collab/ticket           single-use WebSocket ticket (30 s)
 * Foreign and unknown workspaces are one 404 everywhere. Reads and previews are open to every member (viewers included);
 * the plan preview tells a viewer `canStart: false`.
 */
export const frontendRoutes: FastifyPluginAsync<FrontendRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  let port: PanelDataPort | null = opts.panelData ?? null;
  const data = () => (port ??= createPanelDataPort());
  app.addHook("onClose", async () => {
    if (!opts.panelData) await port?.close();
  });

  async function member(
    req: FastifyRequest<{ Params: { id: string } }>,
  ): Promise<{ s: Session; id: string }> {
    const s = await authenticate(req);
    const id = req.params.id;
    if (!Uuid.safeParse(id).success) throw workspaceNotFound();
    try {
      await kernel.workspaces.get(s, id);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
    return { s, id };
  }

  // ---- panel data ----------------------------------------------------------------------------------------------------
  app.get<{ Params: { id: string; hash: string }; Querystring: { source?: string } }>(
    "/v1/workspaces/:id/panels/:hash/data",
    async (req, reply) => {
      const { s, id } = await member(req as never);
      if (!Hash.test(req.params.hash))
        throw new KernelError(
          "VALIDATION_FAILED",
          "INVALID_QUERY_HASH",
          "The query hash must be 64 lowercase hex characters.",
        );
      const q = SourceQ.safeParse(req.query);
      if (!q.success)
        throw new KernelError("VALIDATION_FAILED", "INVALID_SOURCE", "source must be fixture or live.");
      const p = data();
      const stored = await p.stored(req.params.hash, q.data.source);
      if (!stored) throw new KernelError("NOT_FOUND", "QUERY_UNKNOWN", "No stored query has this hash.");
      let body: Omit<PanelDataResponse, "workspaceId">;
      if (stored.kind === "analytics") {
        const r = await p.analytics(req.params.hash);
        if (r.status === 404) throw new KernelError("NOT_FOUND", r.body.reasonCode, r.body.message);
        if (r.status === 422) throw new KernelError("DOMAIN_INVARIANT", r.body.reasonCode, r.body.message);
        if (r.status !== 200)
          throw new KernelError("UPSTREAM_DEGRADED", r.body.reasonCode, r.body.message, { retryable: true });
        body = analyticsPanel(req.params.hash, r.body);
      } else {
        const r = await p.query(gatewaySession(s, id), stored.ast, stored.source);
        if (!r.ok) return reply.status(r.status).send({ ...r.error, traceId: req.traceId });
        body = semanticPanel(r.envelope, stored.ast, p.registry(stored.source), stored.source);
      }
      return { workspaceId: id, ...body } satisfies PanelDataResponse;
    },
  );

  // ---- canvas patch preview ------------------------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/canvas/preview", async (req, reply) => {
    const { s, id } = await member(req);
    let doc;
    try {
      doc = await kernel.canvas.get(s, id);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
    const report = validateCanvasPatchSemantics(doc, req.body);
    if (!report.ok)
      throw new KernelError(
        "VALIDATION_FAILED",
        "PATCH_REJECTED",
        "The patch was rejected; nothing was changed.",
        {
          details: report.issues.slice(0, 100).map((i) => ({ path: i.path, issue: i.message })),
          lastStableRevision: doc.documentRevision,
        },
      );
    const ops = (req.body as { operations: Parameters<typeof previewHash>[1] }).operations;
    const p = data();
    const session = gatewaySession(s, id);
    type Q = CanvasPreviewResponse["estimate"]["queries"][number];
    const targets: Array<{
      panelId: string;
      op: "addPanel" | "updatePanel";
      hash: string | null;
      analytics: boolean;
    }> = [];
    const removed: string[] = [];
    for (const op of ops) {
      if (op.op === "addPanel" || op.op === "updatePanel") {
        const panel = op.panel;
        targets.push({
          panelId: op.op === "addPanel" ? panel.panelId : op.panelId,
          op: op.op,
          hash: panel.queryRef.hash,
          analytics: panel.queryRef.resultKind === "analytics_result",
        });
      } else if (op.op === "removePanel") removed.push(op.panelId);
    }
    const estimateOne = async (t: (typeof targets)[number]): Promise<Q> => {
      const base = { panelId: t.panelId, op: t.op, queryHash: t.hash } as const;
      const none = (reasonCode: string, kind: Q["kind"] = "none"): Q => ({
        ...base,
        kind,
        status: "not_estimable",
        estimatedRows: null,
        bytesEstimated: null,
        withinCap: null,
        cached: null,
        reasonCode,
      });
      if (!t.hash) return none("NO_QUERY");
      const stored = await p.stored(t.hash).catch(() => null);
      if (!stored) return none("QUERY_UNKNOWN");
      if (stored.kind === "analytics" || t.analytics)
        return none("ANALYTICS_COST_NOT_ESTIMATED", "analytics");
      const e = await p.estimate(session, stored.ast, stored.source);
      if (!e.ok) return none(e.error.reasonCode ?? "ESTIMATE_REFUSED", "semantic");
      return {
        ...base,
        kind: "semantic",
        status: "estimated",
        estimatedRows: e.estimatedRows,
        bytesEstimated: e.cached ? 0 : e.bytesEstimated,
        withinCap: e.withinCap,
        cached: e.cached,
        reasonCode: e.withinCap ? null : "COST_CAP",
      };
    };
    const queries: Q[] = [];
    for (let i = 0; i < targets.length; i += 4)
      queries.push(...(await Promise.all(targets.slice(i, i + 4).map(estimateOne))));
    const atRisk = queries
      .filter(
        (q) =>
          (q.status === "not_estimable" &&
            q.reasonCode !== "NO_QUERY" &&
            q.reasonCode !== "ANALYTICS_COST_NOT_ESTIMATED") ||
          q.withinCap === false,
      )
      .map((q) => q.panelId);
    void reply;
    const body: CanvasPreviewResponse = {
      previewHash: previewHash(doc, ops),
      baseRevision: doc.documentRevision,
      operations: report.operations as unknown as Array<Record<string, unknown>>,
      estimate: {
        queryCount: queries.filter((q) => q.status === "estimated").length,
        estimatedRows: queries.reduce((a, q) => a + (q.estimatedRows ?? 0), 0),
        bytesEstimated: queries.reduce((a, q) => a + (q.bytesEstimated ?? 0), 0),
        estimatedCostUsd: 0,
        costBasis:
          "Semantic and analytics queries read the local ClickHouse and Cube layer, which has no per-query charge; billed bytes are 0. Sizes are row estimates times 200 bytes, as in the result envelope. Model spend is not part of a canvas patch.",
        atRiskPanelIds: [...new Set(atRisk)],
        removedPanelIds: [...new Set(removed)],
        queries,
      },
    };
    return body;
  });

  // ---- question plan preview -----------------------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/questions/preview", async (req) => {
    const { s } = await member(req);
    const parsed = QuestionPreviewRequest.safeParse(req.body ?? {});
    if (!parsed.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
        details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), issue: i.message })),
      });
    const b = parsed.data;
    const min = MIN_QUESTION_BUDGET;
    const requested = b.budget ?? { tokens: min.tokens, toolCalls: min.toolCalls, usd: min.usd };
    const meetsMinimum =
      requested.tokens >= min.tokens && requested.toolCalls >= min.toolCalls && requested.usd >= min.usd;
    const blockers: QuestionPreviewResponse["blockers"] = [];
    if (!canWrite(s.role))
      blockers.push({
        reasonCode: "INSUFFICIENT_ROLE",
        message: "Your role cannot ask questions in this workspace.",
      });
    if (!meetsMinimum)
      blockers.push({
        reasonCode: "BUDGET_BELOW_MINIMUM",
        message: `Budget is below the minimum the runtime must reserve (${min.tokens} tokens, ${min.toolCalls} tool calls, USD ${min.usd}).`,
      });
    if (!opts.engineAvailable)
      blockers.push({
        reasonCode: "ENGINE_UNAVAILABLE",
        message: "No investigation engine is configured on this API.",
      });
    const deterministic = b.source === "live" && !SCRIPTED.test(b.question);
    const text = b.question.replace(/^\[scenario=none\]\s*/, "");
    const body: QuestionPreviewResponse = {
      planKind: deterministic ? "deterministic_composer" : "director_model",
      deterministic,
      modelCalls: 0,
      spendUsd: 0,
      plan: deterministic
        ? {
            stages: [
              [
                {
                  task: "compose canvas",
                  role: "composer",
                  objective: text.slice(0, 3900),
                  capabilities: LIVE_COMPOSER_CAPABILITIES,
                  budget: { ...composerBudget },
                },
              ],
            ],
            privilegedAction: {
              kind: "canvas.apply_patch",
              requiresApproval: true,
              network: "fixture-only",
              costLimit: 0,
            },
          }
        : null,
      note: deterministic
        ? "This is the exact plan the run executes: one composer task, then a canvas change that waits for your approval. Previewing made no model call and spent nothing."
        : "Fixture-source questions are planned by the director model, so a plan cannot be shown without a model call. Nothing was spent. The run stops at an approval before any canvas change.",
      budget: { requested, minimum: { ...min }, meetsMinimum },
      canStart: blockers.length === 0,
      blockers,
    };
    return body;
  });

  // ---- collaboration ticket ------------------------------------------------------------------------------------------
  const tickets: CollabTicketStore = app.collabTickets;
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/collab/ticket", async (req, reply) => {
    const { s, id } = await member(req);
    const b = CollabTicketRequest.safeParse(req.body ?? {});
    if (!b.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "scope must be layout or notes.");
    const scope = b.data.scope ?? null;
    const t = tickets.issue(s, id, scope);
    const out: CollabTicketResponse = {
      ticket: t.ticket,
      expiresAt: new Date(t.expiresAt).toISOString(),
      ttlSeconds: Math.round(tickets.ttlMs / 1000),
      workspaceId: id,
      scope,
      wsPath: `/v1/workspaces/${id}/collab/${scope ?? "{scope}"}/ws`,
      subprotocol: `nearesis.ticket.${t.ticket}`,
    };
    return reply.status(201).send(out);
  });
};

(frontendRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
