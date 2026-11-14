import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { CollabPresenceRequest, CollabScope, CollabUpdateRequest } from "@nearesis/contracts";
import { KernelError, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { historyService } from "@nearesis/kernel";
import { attachCollabWebSocket } from "./collab-ws.ts";
import "./collab-ticket.ts";
import { pinHistorySnapshot, principalOf } from "./metric-publish-guard.ts";
import type { PublishAuthoring } from "./metric-publish-guard.ts";

export interface HistoryRoutesOptions {
  kernel: Kernel;
  /** Governed metric authoring: certified authored metric versions a snapshot rests on are pinned when it is taken. */
  authoring?: PublishAuthoring;
}

const Uuid = z.uuid();

/**
 * Evidence graph writes, time machine (snapshots, historical views, timeline), branches, merge proposals and scoped
 * Yjs collaboration. Foreign and unknown workspaces/objects both answer 404. Mutations take `expectedVersion` in the
 * body (or `If-Match: "<n>"`) and an optional `Idempotency-Key` header; a retry replays and returns `replayed: true`.
 */
export const historyRoutes: FastifyPluginAsync<HistoryRoutesOptions> = async (app, { kernel, authoring }) => {
  const svc = historyService(kernel);
  // Yjs over WebSocket: a transport for svc.collab (same authorisation, validation and persistence as the REST routes)
  const ws = attachCollabWebSocket(app.server, kernel, svc.collab, {
    ...(app.collabTickets ? { tickets: app.collabTickets } : {}),
  });
  app.addHook("onClose", async () => ws.closeAll());

  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  }

  /** Authenticate, validate path ids, hide existence of other tenants' objects. */
  async function guard<T>(req: FastifyRequest, ids: string[], fn: (s: Session) => Promise<T>): Promise<T> {
    const session = await authenticate(req);
    for (const id of ids) if (!Uuid.safeParse(id).success) throw workspaceNotFound();
    try {
      return await fn(session);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN" && e.reasonCode === "ACCESS_DENIED")
        throw workspaceNotFound();
      throw e;
    }
  }

  /** Fold `If-Match` into the body and surface the idempotency key. */
  function mut(req: FastifyRequest): { body: Record<string, unknown>; opts: { idempotencyKey?: string } } {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const im = req.headers["if-match"];
    if (typeof im === "string" && body.expectedVersion === undefined) {
      const n = /^"?(\d+)"?$/.exec(im.trim());
      if (n) body.expectedVersion = Number(n[1]);
    }
    const k = req.headers["idempotency-key"];
    return {
      body,
      opts: typeof k === "string" && k.length >= 8 && k.length <= 200 ? { idempotencyKey: k } : {},
    };
  }

  type P1 = { Params: { id: string } };
  type P2 = { Params: { id: string; sid: string } };
  type PB = { Params: { id: string; bid: string } };
  type PP = { Params: { id: string; pid: string } };
  type PC = { Params: { id: string; scope: string } };

  // ---- evidence graph writes ------------------------------------------------------------------------------------
  app.post<P1>("/v1/workspaces/:id/graph/nodes", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.graphOps.addNode(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.post<P1>("/v1/workspaces/:id/graph/edges", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.graphOps.addEdge(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  /** Impact analysis: record a semantic version change and flag dependents for recheck. */
  app.post<P1>("/v1/workspaces/:id/graph/semantic-changes", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.graphOps.changeSemanticVersion(s, req.params.id, body, opts);
    }),
  );
  app.post<P1>("/v1/workspaces/:id/graph/rechecks/resolve", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.graphOps.resolveRecheck(s, req.params.id, body, opts);
    }),
  );
  app.get<P1>("/v1/workspaces/:id/graph/rechecks", async (req) =>
    guard(req, [req.params.id], async (s) => ({ flags: await svc.recheckFlags(s, req.params.id) })),
  );

  app.post<P1>("/v1/workspaces/:id/graph/nodes/data", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.graphOps.updateNodeData(s, req.params.id, body, opts);
    }),
  );
  app.post<P1>("/v1/workspaces/:id/graph/corrections", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.graphOps.correctNode(s, req.params.id, body, opts);
    }),
  );
  app.post<P1>("/v1/workspaces/:id/graph/restrictions", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.graphOps.setRestriction(s, req.params.id, body, opts);
    }),
  );
  /** Read-only impact analysis of a metric's current version, ACL-filtered for the caller. */
  app.get<{ Params: { id: string; metric: string }; Querystring: { maxDepth?: string } }>(
    "/v1/workspaces/:id/impact/:metric",
    async (req) =>
      guard(req, [req.params.id], (s) =>
        svc.impact.impact(s, req.params.id, {
          metricId: req.params.metric,
          ...(req.query.maxDepth
            ? { maxDepth: Math.min(Math.max(Number(req.query.maxDepth) || 1, 1), 1000) }
            : {}),
        }),
      ),
  );
  app.get<P1>("/v1/workspaces/:id/revalidation", async (req) =>
    guard(req, [req.params.id], (s) => svc.impact.revalidationStatus(s, req.params.id)),
  );
  /** Supported-publication eligibility: unsupported claims are listed apart, with their missing provenance. */
  app.get<P1>("/v1/workspaces/:id/publication-eligibility", async (req) =>
    guard(req, [req.params.id], (s) => svc.publicationEligibility(s, req.params.id)),
  );
  app.post<P1>("/v1/workspaces/:id/comments", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.reviews.add(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { nodeId?: string } }>(
    "/v1/workspaces/:id/comments",
    async (req) =>
      guard(req, [req.params.id, ...(req.query.nodeId ? [req.query.nodeId] : [])], async (s) => ({
        comments: await svc.reviews.list(s, req.params.id, req.query.nodeId),
      })),
  );
  app.post<P1>("/v1/workspaces/:id/summaries", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.summaries.create(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.get<P1>("/v1/workspaces/:id/summaries", async (req) =>
    guard(req, [req.params.id], async (s) => ({ summaries: await svc.summaries.recall(s, req.params.id) })),
  );
  app.post<P1>("/v1/workspaces/:id/claims/tier", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.summaries.setClaimTier(s, req.params.id, body, opts);
    }),
  );
  app.post<P1>("/v1/workspaces/:id/retention/delete", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.retention.deletePayload(s, req.params.id, body, opts);
    }),
  );
  /** Dereference an evidence item: tombstones answer with metadata only; ACL denials answer 404 and are audited. */
  app.get<{ Params: { id: string; nid: string } }>("/v1/workspaces/:id/evidence/:nid", async (req) =>
    guard(req, [req.params.id, req.params.nid], (s) =>
      svc.retention.dereference(s, req.params.id, req.params.nid),
    ),
  );

  // ---- snapshots / time machine ---------------------------------------------------------------------------------
  app.get<P1>("/v1/workspaces/:id/snapshots", async (req) =>
    guard(req, [req.params.id], async (s) => ({ snapshots: await svc.snapshots.list(s, req.params.id) })),
  );
  app.post<P1>("/v1/workspaces/:id/snapshots", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.snapshots.create(s, req.params.id, body, opts);
      if (authoring && !r.replayed) {
        const id = (r.result as { snapshotId?: string } | undefined)?.snapshotId;
        const row = id ? (await svc.snapshots.list(s, req.params.id)).find((x) => x.id === id) : undefined;
        if (id && row)
          await pinHistorySnapshot(
            authoring,
            principalOf(s, req.params.id),
            id,
            row.dataVintage.semanticPins,
          );
      }
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { a?: string; b?: string } }>(
    "/v1/workspaces/:id/snapshots/compare",
    async (req) =>
      guard(req, [req.params.id, req.query.a ?? "", req.query.b ?? ""], (s) =>
        svc.snapshots.compare(s, req.params.id, req.query.a!, req.query.b!),
      ),
  );
  for (const part of ["canvas", "graph", "layout"] as const) {
    app.get<P2>(`/v1/workspaces/:id/snapshots/:sid/${part}`, async (req) =>
      guard(req, [req.params.id, req.params.sid], (s) =>
        svc.snapshots.view(s, req.params.id, req.params.sid, part),
      ),
    );
  }
  app.get<P2>("/v1/workspaces/:id/snapshots/:sid", async (req) =>
    guard(req, [req.params.id, req.params.sid], (s) =>
      svc.snapshots.view(s, req.params.id, req.params.sid, "all"),
    ),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/v1/workspaces/:id/timeline",
    async (req) =>
      guard(req, [req.params.id], async (s) => ({
        entries: await svc.snapshots.timeline(
          s,
          req.params.id,
          Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000),
        ),
      })),
  );

  /** Event-log reconstruction at a revision (= journal sequence number), and its verifiable export. */
  app.get<{ Params: { id: string; rev: string } }>("/v1/workspaces/:id/revisions/:rev", async (req) =>
    guard(req, [req.params.id], async (s) => {
      const r = await svc.reconstruct.reconstruct(s, req.params.id, Number(req.params.rev));
      const { objects: _o, ...rest } = r;
      void _o;
      return rest;
    }),
  );
  app.get<{ Params: { id: string; rev: string } }>("/v1/workspaces/:id/revisions/:rev/export", async (req) =>
    guard(req, [req.params.id], (s) => svc.reconstruct.exportFile(s, req.params.id, Number(req.params.rev))),
  );
  app.post<P1>("/v1/workspaces/:id/snapshots/purge", async (req) =>
    guard(req, [req.params.id], (s) => {
      const { body, opts } = mut(req);
      return svc.snapshots.purge(s, req.params.id, body, opts);
    }),
  );
  app.get<PB>("/v1/workspaces/:id/branches/:bid/memory", async (req) =>
    guard(req, [req.params.id, req.params.bid], async (s) => ({
      items: await svc.branches.memory(s, req.params.id, req.params.bid),
    })),
  );

  // ---- branches and merges --------------------------------------------------------------------------------------
  app.get<P1>("/v1/workspaces/:id/branches", async (req) =>
    guard(req, [req.params.id], async (s) => ({ branches: await svc.branches.list(s, req.params.id) })),
  );
  app.post<P1>("/v1/workspaces/:id/branches", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.branches.create(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.get<PB>("/v1/workspaces/:id/branches/:bid", async (req) =>
    guard(req, [req.params.id, req.params.bid], (s) => svc.branches.view(s, req.params.id, req.params.bid)),
  );
  app.get<{ Params: { id: string; bid: string }; Querystring: { against?: string } }>(
    "/v1/workspaces/:id/branches/:bid/diff",
    async (req) =>
      guard(
        req,
        [
          req.params.id,
          req.params.bid,
          ...(req.query.against && req.query.against !== "base" ? [req.query.against] : []),
        ],
        (s) => svc.branches.diff(s, req.params.id, req.params.bid, req.query.against),
      ),
  );
  app.post<PB>("/v1/workspaces/:id/branches/:bid/changes", async (req) =>
    guard(req, [req.params.id, req.params.bid], (s) => {
      const { body, opts } = mut(req);
      return svc.branches.change(s, req.params.id, req.params.bid, body, opts);
    }),
  );
  app.get<P1>("/v1/workspaces/:id/merge-proposals", async (req) =>
    guard(req, [req.params.id], async (s) => ({
      proposals: await svc.branches.listProposals(s, req.params.id),
    })),
  );
  app.post<P1>("/v1/workspaces/:id/merge-proposals", async (req, reply) =>
    guard(req, [req.params.id], async (s) => {
      const { body, opts } = mut(req);
      const r = await svc.branches.proposeMerge(s, req.params.id, body, opts);
      return reply.status(r.replayed ? 200 : 201).send(r);
    }),
  );
  app.get<PP>("/v1/workspaces/:id/merge-proposals/:pid", async (req) =>
    guard(req, [req.params.id, req.params.pid], (s) =>
      svc.branches.getProposal(s, req.params.id, req.params.pid),
    ),
  );
  app.post<PP>("/v1/workspaces/:id/merge-proposals/:pid/resolve", async (req) =>
    guard(req, [req.params.id, req.params.pid], (s) => {
      const { body, opts } = mut(req);
      return svc.branches.resolveConflict(s, req.params.id, req.params.pid, body, opts);
    }),
  );
  app.post<PP>("/v1/workspaces/:id/merge-proposals/:pid/accept", async (req) =>
    guard(req, [req.params.id, req.params.pid], (s) => {
      const { body, opts } = mut(req);
      return svc.branches.acceptMerge(s, req.params.id, req.params.pid, body, opts);
    }),
  );
  app.post<PP>("/v1/workspaces/:id/merge-proposals/:pid/reject", async (req) =>
    guard(req, [req.params.id, req.params.pid], (s) => {
      const { body, opts } = mut(req);
      return svc.branches.rejectMerge(s, req.params.id, req.params.pid, body, opts);
    }),
  );

  // ---- scoped Yjs collaboration (layout, notes) -----------------------------------------------------------------
  const scopeOf = (v: string): z.infer<typeof CollabScope> => {
    const p = CollabScope.safeParse(v);
    if (!p.success) throw workspaceNotFound();
    return p.data;
  };
  app.get<PC>("/v1/workspaces/:id/collab/:scope/state", async (req) =>
    guard(req, [req.params.id], (s) => svc.collab.state(s, req.params.id, scopeOf(req.params.scope))),
  );
  app.post<PC>("/v1/workspaces/:id/collab/:scope/updates", async (req) =>
    guard(req, [req.params.id], (s) => {
      const b = CollabUpdateRequest.safeParse(req.body);
      if (!b.success) throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.");
      return svc.collab.applyUpdate(s, req.params.id, scopeOf(req.params.scope), b.data.update);
    }),
  );
  app.get<P1>("/v1/workspaces/:id/collab/layout/reconcile", async (req) =>
    guard(req, [req.params.id], (s) => svc.collab.reconcileLayout(s, req.params.id)),
  );
  app.get<PC>("/v1/workspaces/:id/collab/:scope/presence", async (req) =>
    guard(req, [req.params.id], (s) => svc.collab.listPresence(s, req.params.id, scopeOf(req.params.scope))),
  );
  app.put<{ Params: { id: string; scope: string }; Querystring: { clientId?: string } }>(
    "/v1/workspaces/:id/collab/:scope/presence",
    async (req) =>
      guard(req, [req.params.id], (s) => {
        const b = CollabPresenceRequest.safeParse(req.body ?? {});
        if (!b.success) throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.");
        return svc.collab.setPresence(
          s,
          req.params.id,
          scopeOf(req.params.scope),
          req.query.clientId ?? "default",
          b.data.state,
        );
      }),
  );
};
