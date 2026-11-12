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
import { publishRoutes } from "./publish-routes.ts";
import { integrityRoutes } from "./integrity-routes.ts";
import { gatewayRoutes } from "./gateway-routes.ts";
import { costRoutes } from "./cost-routes.ts";
import { entityRoutes } from "./entity-routes.ts";
import { realtimeRoutes } from "./realtime-routes.ts";
import { intentsRoutes } from "./intents-routes.ts";
import { accountRoutes } from "./account-routes.ts";
import { analyticsPanelRoutes } from "./analytics-panel-routes.ts";
import { CollabTicketStore } from "./collab-ticket.ts";
import { frontendRoutes } from "./frontend-routes.ts";
import { globalRoutes } from "./global-routes.ts";
import { oidcRoutes } from "./oidc-routes.ts";
import type { OidcClient } from "@nearesis/kernel";
import type { PanelDataPort } from "./panel-data.ts";
import type { SourceHealthPort } from "./source-health.ts";
import { metricRoutes } from "./metric-routes.ts";
import { createMetricCorrectionPort } from "./metric-correction.ts";
import type { AuthoringService } from "@nearesis/semantic-gateway";
import type { SloRecorder } from "@nearesis/workflow";
import type { GatewayCredentialConfig } from "./gateway-routes.ts";
import { OverloadError, SseConnectionLimiter, TenantAdmission, sseClientKey } from "./overload/index.ts";
import type { AdmissionOptions, SseLimits } from "./overload/index.ts";
import { requestGuards } from "./request-guards.ts";
import type { RequestGuardOptions } from "./request-guards.ts";

const Uuid = z.uuid();

/** `exp` (ms) from a JWT payload, for timing only: the signature is verified by the identity policy, never here. */
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface AppOptions {
  /** Start the monitor scheduler and marker-task dispatcher inside this API process. */
  monitorBackground?: { intervalMs?: number };
  kernel: Kernel;
  /** Governed metric authoring service; when set, the /v1/workspaces/:id/metrics routes are served. */
  authoring?: AuthoringService;
  /** Model USD recorded outside Postgres (inference spend files); counted in the global ceiling view. */
  externalModelSpend?: () => Promise<number>;
  /** Independent time anchor for published manifests (NEAR testnet hash commit). Absent: log-only anchoring. */
  publishAnchorChain?: (manifestHash: string) => Promise<import("@nearesis/capsule").ChainCommitPayload>;
  /** Starts/signals investigation workflows (production: `temporalEngine()`). Without one, question/cancel/approval writes are 503. */
  engine?: InvestigationEngine;
  nodeEnv?: string | undefined;
  /** SSE journal poll interval (ms). */
  ssePollMs?: number;
  /** How often an open event stream re-validates its session token and membership (ms). Default 5000. */
  sseAuthRecheckMs?: number;
  /** Cross-origin, content-type and rate-limit guards for mutating requests. */
  guards?: RequestGuardOptions;
  /**
   * Overload protection (ch.13 Backpressure). `admission: false` switches the per-tenant investigation cap off (tests and
   * the PERF09 negative control only). Defaults: 6 running and 16 queued per tenant, 128 queued overall, 5 s queue
   * timeout; 6 event streams per browser.
   */
  overload?: {
    admission?: Omit<AdmissionOptions, "occupancy"> | false;
    sse?: SseLimits;
  };
  /** Enables `GET /v1/gateway/runs/:id` for the MCP gateway's audience-constrained credential. Absent: route does not exist. */
  gatewayCredential?: GatewayCredentialConfig;
  /** Test seams for the frontend routes (panel data, source health, OIDC client, collaboration ticket lifetime). */
  frontend?: {
    panelData?: PanelDataPort;
    sources?: SourceHealthPort;
    oidc?: OidcClient | null;
    capsuleRoot?: () => string;
    collabTicketTtlMs?: number;
  };
  /** Feeds the api_availability SLO from every response (cost-routes.ts). Absent: SLO recording is off. */
  sloRecorder?: SloRecorder;
}

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    session?: Session;
  }
  interface FastifyInstance {
    /** Live overload counters (queue depth, running per tenant, stream counts); read by the PERF09 harness and ops. */
    overload: {
      admission: TenantAdmission | undefined;
      sse: SseConnectionLimiter;
    };
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
  const admission =
    opts.overload?.admission === false
      ? undefined
      : new TenantAdmission({ ...(opts.overload?.admission ?? {}), occupancy: runs.occupancyOf });
  runs.admission = admission;
  const sseLimiter = new SseConnectionLimiter(opts.overload?.sse);
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, genReqId: () => randomUUID() });
  app.decorate("overload", { admission, sse: sseLimiter });
  app.addHook("onClose", async () => admission?.close());

  app.decorate("collabTickets", new CollabTicketStore(opts.frontend?.collabTicketTtlMs));
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
    if (e instanceof OverloadError) {
      void reply.header("retry-after", String(e.retryAfterS));
      void reply.status(status).send({ ...body, retryAfterSeconds: e.retryAfterS });
      return;
    }
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

  // Sign-out / incident response: the presented token stops working on the next request.
  app.post("/v1/session/revoke", async (req, reply) => {
    await authenticate(req);
    const h = req.headers.authorization as string;
    await kernel.identity.revoke(h.slice(7).trim());
    return reply.status(204).send();
  });

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
      // Per-browser stream limit: refused as 429 + Retry-After before the response is hijacked.
      const releaseStream = sseLimiter.acquire(
        sseClientKey(req.headers.authorization, req.headers["x-client-id"]),
      );
      reply.raw.once("close", releaseStream);
      req.raw.once("close", releaseStream);
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
      let slow = false;
      let lastBeat = Date.now();
      /**
       * Backpressure: a client whose socket is blocked is "slow". It is not fed the backlog event by event (the next read
       * coalesces anything beyond `slowMaxLag` into one aggregate), the unflushed bytes stay bounded by one journal
       * batch, and a client that stays blocked past `slowDrainTimeoutMs` is disconnected (it resumes via Last-Event-ID).
       * Returns false when the client was dropped.
       */
      const settle = async (): Promise<boolean> => {
        sseLimiter.noteBuffered(res.writableLength);
        if (!res.writableNeedDrain) {
          slow = false;
          return true;
        }
        // A write that fills the socket buffer is normal flow control; only a client that stays blocked is slow.
        const waitedMs = Date.now();
        const drained = await new Promise<boolean>((resolve) => {
          const done = (v: boolean) => {
            clearTimeout(t);
            res.off("drain", onDrain);
            res.off("close", onClose);
            resolve(v);
          };
          const onDrain = () => done(true);
          const onClose = () => done(true);
          const t = setTimeout(() => done(false), sseLimiter.slowDrainTimeoutMs);
          res.once("drain", onDrain);
          res.once("close", onClose);
        });
        if (!drained) {
          sseLimiter.noteDropped();
          res.destroy();
          return false;
        }
        const slowNow = Date.now() - waitedMs >= sseLimiter.slowAfterMs;
        if (slowNow && !slow) sseLimiter.noteSlow();
        slow = slowNow;
        return true;
      };
      // Token lifetime: the stream must not outlive the session (expiry) or the membership behind it (revocation).
      const bearerToken = (req.headers.authorization ?? "").slice(7).trim();
      const tokenExpMs = jwtExpiryMs(bearerToken);
      const recheckMs = opts.sseAuthRecheckMs ?? 5000;
      let lastAuthCheck = Date.now();
      /** Returns the reason the session lapsed, or null while it is still valid. */
      const sessionLapse = async (): Promise<"TOKEN_EXPIRED" | "SESSION_REVOKED" | null> => {
        if (tokenExpMs !== null && Date.now() >= tokenExpMs) return "TOKEN_EXPIRED";
        if (Date.now() - lastAuthCheck < recheckMs) return null;
        lastAuthCheck = Date.now();
        try {
          await kernel.identity.resolveSession(bearerToken);
          return null;
        } catch (e) {
          if (e instanceof KernelError && e.code === "UNAUTHENTICATED")
            return e.reasonCode === "NO_MEMBERSHIP" || e.reasonCode === "SESSION_REVOKED"
              ? "SESSION_REVOKED"
              : "TOKEN_EXPIRED";
          return null; // transient infrastructure error: do not drop the stream on a blip
        }
      };
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
          const lapse = await sessionLapse();
          if (lapse) {
            frame("session_expired", null, {
              reason: lapse,
              nextAction: "Re-authenticate and reconnect with Last-Event-ID set to the last applied seq.",
              lastSeq: cursor,
            });
            break;
          }
          const r = await kernel.stream.read(
            session,
            req.params.id,
            cursor,
            first,
            slow ? { maxLag: sseLimiter.slowMaxLag } : {},
          );
          first = false;
          if (r.status === "reload_required") {
            frame("reload_required", r.head, {
              reason: "CURSOR_EXPIRED",
              currentSeq: r.head,
              workspaceVersion: r.workspaceVersion,
            });
            break;
          }
          if (r.status === "coalesced") {
            frame("coalesced", r.aggregate.toSeq, r.aggregate);
            sseLimiter.noteCoalesced();
            cursor = r.aggregate.toSeq;
          } else if (r.events.length) {
            for (const ev of r.events) {
              frame(ev.type, ev.seq, ev);
              cursor = ev.seq;
            }
          } else {
            if (Date.now() - lastBeat > 15_000) {
              res.write(": ping\n\n");
              lastBeat = Date.now();
            }
            if (!(await settle())) break;
            await sleep(pollMs);
            continue;
          }
          if (!closed && !(await settle())) break;
        }
      } catch {
        // A read failing mid-stream is most often auth lost (membership revoked): say so instead of a silent close.
        try {
          lastAuthCheck = 0;
          const lapse = await sessionLapse();
          if (lapse && !closed)
            frame("session_expired", null, {
              reason: lapse,
              nextAction: "Re-authenticate and reconnect with Last-Event-ID set to the last applied seq.",
              lastSeq: cursor,
            });
        } catch {
          /* connection torn down: just end the stream */
        }
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

  await app.register(historyRoutes, { kernel, ...(opts.authoring ? { authoring: opts.authoring } : {}) });
  await app.register(capsuleRoutes, { kernel, ...(opts.authoring ? { authoring: opts.authoring } : {}) });
  await app.register(publishRoutes, {
    kernel,
    ...(opts.authoring ? { authoring: opts.authoring } : {}),
    ...(opts.publishAnchorChain ? { anchorChain: opts.publishAnchorChain } : {}),
  });
  await app.register(integrityRoutes, { kernel });
  if (opts.gatewayCredential)
    await app.register(gatewayRoutes, { kernel, credential: opts.gatewayCredential });
  await app.register(monitoringRoutes, { kernel, runs, authenticate, background: opts.monitorBackground });
  await app.register(costRoutes, {
    kernel,
    authenticate,
    slo: opts.sloRecorder,
    ...(opts.externalModelSpend ? { externalModelSpend: opts.externalModelSpend } : {}),
  });
  await app.register(entityRoutes, { authenticate });
  await app.register(realtimeRoutes, { authenticate });
  await app.register(intentsRoutes, { authenticate });
  await app.register(accountRoutes, { authenticate });
  await app.register(analyticsPanelRoutes, { authenticate });
  if (opts.authoring)
    await app.register(metricRoutes, {
      kernel,
      authenticate,
      authoring: opts.authoring,
      onCorrection: createMetricCorrectionPort(kernel),
    });

  await app.register(frontendRoutes, {
    kernel,
    authenticate,
    engineAvailable: opts.engine !== undefined,
    ...(opts.frontend?.panelData ? { panelData: opts.frontend.panelData } : {}),
  });
  await app.register(globalRoutes, {
    kernel,
    authenticate,
    runs,
    authoring: opts.authoring,
    ...(opts.frontend?.sources ? { sources: opts.frontend.sources } : {}),
    ...(opts.frontend?.capsuleRoot ? { capsuleRoot: opts.frontend.capsuleRoot } : {}),
  });
  await app.register(oidcRoutes, {
    kernel,
    ...(opts.frontend?.oidc !== undefined ? { client: opts.frontend.oidc } : {}),
  });

  // Reference HTTP_STATUS_FOR so the status table is the single source of truth for error mapping.
  void HTTP_STATUS_FOR;
  return app;
}
