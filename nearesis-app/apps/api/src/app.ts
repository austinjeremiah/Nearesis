import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HTTP_STATUS_FOR } from "@nearesis/contracts";
import { KernelError, noWorkspaceAccess, toErrorResponse, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { RunsService } from "./runs.ts";
import type { InvestigationEngine } from "./runs.ts";
import { historyRoutes } from "./history-routes.ts";
import { monitoringRoutes } from "./monitoring-routes.ts";
import { capsuleRoutes } from "./capsule-routes.ts";
import { requestGuards } from "./request-guards.ts";
import type { RequestGuardOptions } from "./request-guards.ts";

const Uuid = z.uuid();

export interface AppOptions {
  /** Start the monitor scheduler and marker-task dispatcher inside this API process. */
  monitorBackground?: { intervalMs?: number };
  kernel: Kernel;
  /** Starts/signals investigation workflows (production: `temporalEngine()`). Without one, question/cancel/approval writes are 503. */
  engine?: InvestigationEngine;
  nodeEnv?: string | undefined;
  /** SSE journal poll interval (ms). */
  ssePollMs?: number;
  /** Cross-origin, content-type and rate-limit guards for mutating requests. */
  guards?: RequestGuardOptions;
}

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    session?: Session;
  }
}

/**
 * HTTP adapter over the kernel. No business logic here: parse, authenticate, delegate, map errors.
 *
 * Existence-leak policy (K01/K04): a workspace the caller cannot access and a workspace that does not exist yield the
 * same status and body (modulo traceId): GET -> 404 NOT_FOUND, commands -> 403 ACCESS_DENIED. Both are produced from
 * one code path that cannot tell the two cases apart (RLS hides foreign rows).
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { kernel } = opts;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const BODY_LIMIT_BYTES = 1_000_000;
  const unavailableEngine: InvestigationEngine = {
    start: () => Promise.reject(new Error("no investigation engine configured")),
    signal: () => Promise.reject(new Error("no investigation engine configured")),
  };
  const runs = new RunsService(kernel, opts.engine ?? unavailableEngine);
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, genReqId: () => randomUUID() });

  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["x-trace-id"];
    req.traceId =
      typeof incoming === "string" && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    void reply.header("x-trace-id", req.traceId);
  });

  requestGuards(app, opts.guards);

  app.setErrorHandler(async (err, req, reply) => {
    const fe = err as { statusCode?: number; validation?: unknown; code?: string };
    let e: unknown = err;
    if (fe.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      // Oversized bodies are a validation failure with an error path (C09), not a generic "malformed" error.
      const rev = await lastStableRevision(req);
      e = new KernelError("VALIDATION_FAILED", "PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.", {
        details: [{ path: "body", issue: `payload exceeds ${BODY_LIMIT_BYTES} bytes` }],
        ...(rev !== undefined ? { lastStableRevision: rev } : {}),
        nextAction: "Reduce the request body size and resubmit.",
      });
    } else if (
      !(err instanceof KernelError) &&
      typeof fe.statusCode === "number" &&
      fe.statusCode >= 400 &&
      fe.statusCode < 500
    ) {
      e = new KernelError("VALIDATION_FAILED", "BAD_REQUEST", "Malformed request.");
    }
    const { status, body } = toErrorResponse(e, req.traceId);
    void reply.status(status).send(body);
  });
  /** Best effort: the workspace version for /v1/workspaces/:id/* requests from an authenticated member. */
  async function lastStableRevision(req: FastifyRequest): Promise<number | undefined> {
    try {
      const id = /^\/v1\/workspaces\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(req.url)?.[1];
      if (!id || !Uuid.safeParse(id).success) return undefined;
      const h = req.headers.authorization;
      const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
      const session = await kernel.identity.resolveSession(token);
      return (await kernel.workspaces.get(session, id)).version;
    } catch {
      return undefined;
    }
  }
  app.setNotFoundHandler((req, reply) => {
    const { status, body } = toErrorResponse(
      new KernelError("NOT_FOUND", "NOT_FOUND", "Not found."),
      req.traceId,
    );
    void reply.status(status).send(body);
  });

  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    const s = await kernel.identity.resolveSession(token);
    req.session = s;
    return s;
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    if (await kernel.db.ping()) return { status: "ready" };
    return reply.status(503).send({ status: "unavailable" });
  });

  // Dev-only login (non-production). In production the route does not exist.
  if (nodeEnv !== "production") {
    app.post("/v1/dev/login", async (req) => {
      const body = z.strictObject({ oidcSubject: z.string().min(1).max(255) }).safeParse(req.body);
      if (!body.success) throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.");
      return { token: await kernel.devAuth!.login(body.data.oidcSubject) };
    });
  }

  app.post("/v1/workspaces", async (req, reply) => {
    const session = await authenticate(req);
    const hdr = req.headers["idempotency-key"];
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof hdr === "string") {
      if (raw.idempotencyKey !== undefined && raw.idempotencyKey !== hdr) {
        throw new KernelError(
          "VALIDATION_FAILED",
          "IDEMPOTENCY_KEY_MISMATCH",
          "Idempotency-Key header and body disagree.",
        );
      }
      raw.idempotencyKey = hdr;
    }
    const res = await kernel.workspaces.create(session, raw);
    return reply.status(201).send(res);
  });

  app.get("/v1/workspaces", async (req) => runs.listWorkspaces(await authenticate(req)));

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id", async (req) => {
    const session = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    return kernel.workspaces.get(session, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/canvas", async (req) => {
    const session = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    try {
      return await kernel.canvas.get(session, req.params.id);
    } catch (e) {
      // Same outcome as GET /v1/workspaces/:id for inaccessible and unknown workspaces.
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
  });

  /** Evidence graph projection (C16). Same existence-hiding as the canvas: outsiders get 404. */
  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/graph", async (req) => {
    const session = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    try {
      return await kernel.graph.get(session, req.params.id);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
  });

  /**
   * SSE: ordered committed events from the journal. `Last-Event-ID` (or ?cursor=) is the last applied seq.
   * Frames carry id=seq so clients dedupe by id. Expired/invalid cursor => reload_required. Lagging subscribers get a
   * coalesced aggregate; the server never buffers more than one batch per subscriber (reads are cursor-driven).
   */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/v1/workspaces/:id/events",
    async (req, reply) => {
      const session = await authenticate(req);
      if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
      try {
        await kernel.stream.authorize(session, req.params.id);
      } catch (e) {
        if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
        throw e;
      }
      const rawCursor = (req.headers["last-event-id"] as string | undefined) ?? req.query.cursor ?? "0";
      const parsedCursor = /^\d+$/.test(rawCursor) ? Number(rawCursor) : Number.NaN;
      const res = reply.raw;
      reply.hijack();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-trace-id": req.traceId,
      });
      let closed = false;
      req.raw.on("close", () => (closed = true));
      const frame = (event: string, id: number | null, data: unknown) =>
        res.write(`${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const pollMs = opts.ssePollMs ?? 250;
      let cursor = Number.isNaN(parsedCursor) ? -1 : parsedCursor;
      let first = true;
      let lastBeat = Date.now();
      try {
        if (cursor < 0) {
          const r = await kernel.stream.read(session, req.params.id, 0, true);
          frame("reload_required", r.head, {
            reason: "INVALID_CURSOR",
            currentSeq: r.head,
            workspaceVersion: "workspaceVersion" in r ? r.workspaceVersion : null,
          });
          return res.end();
        }
        while (!closed) {
          const r = await kernel.stream.read(session, req.params.id, cursor, first);
          first = false;
          if (r.status === "reload_required") {
            frame("reload_required", r.head, {
              reason: "CURSOR_EXPIRED",
              currentSeq: r.head,
              workspaceVersion: r.workspaceVersion,
            });
            break;
          }
          let ok = true;
          if (r.status === "coalesced") {
            ok = frame("coalesced", r.aggregate.toSeq, r.aggregate);
            cursor = r.aggregate.toSeq;
          } else if (r.events.length) {
            for (const ev of r.events) {
              ok = frame(ev.type, ev.seq, ev) && ok;
              cursor = ev.seq;
            }
          } else {
            if (Date.now() - lastBeat > 15_000) {
              res.write(": ping\n\n");
              lastBeat = Date.now();
            }
            await sleep(pollMs);
            continue;
          }
          if (!ok && !closed)
            await new Promise<void>((resolve) => {
              res.once("drain", resolve);
              res.once("close", resolve);
            });
        }
      } catch {
        /* connection torn down or auth lost: just end the stream */
      }
      if (!res.writableEnded) res.end();
    },
  );

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/commands", async (req) => {
    const session = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw noWorkspaceAccess();
    const ifMatch = req.headers["if-match"];
    const idem = req.headers["idempotency-key"];
    let expectedVersion: number | undefined;
    if (typeof ifMatch === "string") {
      const n = /^"?(\d+)"?$/.exec(ifMatch.trim());
      if (!n)
        throw new KernelError(
          "VALIDATION_FAILED",
          "INVALID_IF_MATCH",
          "If-Match must be a workspace version number.",
        );
      expectedVersion = Number(n[1]);
      const bodyV = (req.body as { expectedVersion?: unknown } | null)?.expectedVersion;
      if (bodyV !== undefined && bodyV !== expectedVersion) {
        throw new KernelError(
          "VALIDATION_FAILED",
          "VERSION_MISMATCH",
          "If-Match and body expectedVersion disagree.",
        );
      }
    }
    const res = await kernel.commands.execute(session, req.params.id, req.body, {
      ...(typeof idem === "string" ? { idempotencyKey: idem } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      traceId: req.traceId,
    });
    return res;
  });

  // ---- Investigation API (ch.11): outsiders and unknown ids are the same 404 everywhere below. ----
  const uuidOr404 = (id: string) => {
    if (!Uuid.safeParse(id).success) throw workspaceNotFound();
  };
  const ifMatchVersion = (h: unknown): number | undefined => {
    if (typeof h !== "string") return undefined;
    const n = /^"?(\d+)"?$/.exec(h.trim());
    if (!n)
      throw new KernelError("VALIDATION_FAILED", "INVALID_IF_MATCH", "If-Match must be a version number.");
    return Number(n[1]);
  };

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/questions", async (req, reply) => {
    const session = await authenticate(req);
    uuidOr404(req.params.id);
    const idem = req.headers["idempotency-key"];
    const res = await runs.submitQuestion(session, req.params.id, req.body, {
      ...(typeof idem === "string" ? { idempotencyKey: idem } : {}),
    });
    return reply.status(202).send(res);
  });

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/runs", async (req) => {
    const session = await authenticate(req);
    uuidOr404(req.params.id);
    return runs.listRuns(session, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/sources", async (req) => {
    const session = await authenticate(req);
    uuidOr404(req.params.id);
    return runs.listSources(session, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req) => {
    const session = await authenticate(req);
    uuidOr404(req.params.id);
    return runs.getRun(session, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/v1/runs/:id/cancel", async (req, reply) => {
    const session = await authenticate(req);
    uuidOr404(req.params.id);
    const res = await runs.cancel(session, req.params.id, req.body, ifMatchVersion(req.headers["if-match"]));
    return reply.status(202).send(res);
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/v1/runs/:id/approvals",
    async (req) => {
      const session = await authenticate(req);
      uuidOr404(req.params.id);
      return runs.listApprovals(session, req.params.id, req.query.status === "all" ? "all" : "pending");
    },
  );

  app.post<{ Params: { id: string; approvalId: string } }>(
    "/v1/runs/:id/approvals/:approvalId",
    async (req, reply) => {
      const session = await authenticate(req);
      uuidOr404(req.params.id);
      const res = await runs.decide(session, req.params.id, req.params.approvalId, req.body);
      return reply.status(202).send(res);
    },
  );

  await app.register(historyRoutes, { kernel });
  await app.register(capsuleRoutes, { kernel });
  await app.register(monitoringRoutes, { kernel, runs, authenticate, background: opts.monitorBackground });

  // Reference HTTP_STATUS_FOR so the status table is the single source of truth for error mapping.
  void HTTP_STATUS_FOR;
  return app;
}
