import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MarkerAssignPayload, MarkerCreatePayload, WatermarkEvent } from "@nearesis/contracts";
import { KernelError, canWrite, workspaceNotFound, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { runsPort } from "./marker-run-port.ts";
import type { RunsService } from "./runs.ts";

export interface MonitoringRoutesOptions {
  kernel: Kernel;
  runs: RunsService;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Run the lease-gated scheduler and the marker-task dispatcher in this process (off by default; the lead starts them). */
  background?: { intervalMs?: number } | undefined;
}

const Uuid = z.uuid();
const ReplayBody = z.strictObject({
  sourceId: z.string().min(1).max(200),
  events: z
    .array(z.strictObject({ watermark: WatermarkEvent.shape.watermark, values: WatermarkEvent.shape.values }))
    .min(1)
    .max(500),
});
const PostMarkerBody = MarkerCreatePayload.extend({
  /** Optional explicit task: saves the marker (ACTIVE) and assigns agents in one request. */
  task: MarkerAssignPayload.omit({ markerId: true }).optional(),
});

/**
 * P06 HTTP surface (ch.11): reads are workspace-scoped tenant reads (foreign and unknown workspaces are one 404);
 * writes go through the kernel command bus (`POST /commands`) or the two composite routes below. Domain events
 * (`marker.*`, `lens.changed`, `monitor.*`, `notification.*`) arrive on the existing `/events` SSE stream.
 */
export const monitoringRoutes: FastifyPluginAsync<MonitoringRoutesOptions> = async (app, opts) => {
  const { kernel, runs, authenticate } = opts;
  const tasks = kernel.markerTasks(runsPort(runs));
  const scheduler = kernel.monitorScheduler();
  if (opts.background) {
    const every = opts.background.intervalMs ?? 2000;
    scheduler.start(every);
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      tasks
        .dispatchOpen()
        .catch(() => undefined)
        .finally(() => (busy = false));
    }, every);
    app.addHook("onClose", async () => {
      clearInterval(timer);
      await scheduler.stop();
    });
  }

  /** Resolve session + workspace id; hide existence behind 404 for any ACL failure. */
  async function scoped<T>(
    req: FastifyRequest<{ Params: { id: string } }>,
    fn: (s: Session, ws: string) => Promise<T>,
  ): Promise<T> {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    try {
      return await fn(s, req.params.id);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN" && e.reasonCode === "ACCESS_DENIED")
        throw workspaceNotFound();
      throw e;
    }
  }
  type R = FastifyRequest<{ Params: { id: string } }>;
  const get = <Q = Record<string, string | undefined>>(
    path: string,
    fn: (
      s: Session,
      ws: string,
      req: FastifyRequest<{ Params: { id: string; mid?: string; lid?: string }; Querystring: Q }>,
    ) => Promise<unknown>,
  ) =>
    app.get<{ Params: { id: string; mid?: string; lid?: string }; Querystring: Q }>(
      `/v1/workspaces/:id${path}`,
      (req) => scoped(req as unknown as R, (s, ws) => fn(s, ws, req)),
    );

  get("/markers", async (s, ws) => ({ markers: await kernel.monitoring.listMarkers(s, ws) }));
  get("/markers/:mid", async (s, ws, req) => {
    if (!Uuid.safeParse(req.params.mid).success) throw workspaceNotFound();
    const m = (await kernel.monitoring.listMarkers(s, ws, req.params.mid!))[0];
    if (!m) throw workspaceNotFound();
    return m;
  });
  get("/markers/:mid/tasks", async (s, ws, req) => {
    if (!Uuid.safeParse(req.params.mid).success) throw workspaceNotFound();
    return { tasks: await kernel.monitoring.listTasks(s, ws, req.params.mid!) };
  });
  get("/marker-tasks", async (s, ws) => ({ tasks: await kernel.monitoring.listTasks(s, ws) }));
  get("/lenses", async (s, ws) => ({ lenses: await kernel.monitoring.listLenses(s, ws) }));
  get("/lenses/:lid/resolution", async (s, ws, req) => {
    if (!Uuid.safeParse(req.params.lid).success) throw workspaceNotFound();
    const r = await kernel.monitoring.resolveLens(s, ws, req.params.lid!);
    if (!r) throw workspaceNotFound();
    return r;
  });
  get("/monitors", async (s, ws) => ({ rules: await kernel.monitoring.listRules(s, ws) }));
  get<{ ruleId?: string }>("/monitors/triggers", async (s, ws, req) => {
    const ruleId = req.query.ruleId;
    if (ruleId !== undefined && !Uuid.safeParse(ruleId).success) throw workspaceNotFound();
    return { triggers: await kernel.monitoring.listTriggers(s, ws, ruleId) };
  });
  get<{ unread?: string }>("/notifications", async (s, ws, req) => ({
    notifications: await kernel.monitoring.listNotifications(
      s,
      ws,
      req.query.unread === "1" || req.query.unread === "true",
    ),
  }));

  get<{ ruleId?: string }>("/monitors/evaluations", async (s, ws, req) => {
    const ruleId = req.query.ruleId;
    if (ruleId !== undefined && !Uuid.safeParse(ruleId).success) throw workspaceNotFound();
    return { evaluations: await kernel.monitoring.listEvaluations(s, ws, ruleId) };
  });
  /** Newest watermark per source the workspace's rules listen to (live and replay kept apart). */
  get("/monitors/watermarks", async (s, ws) => ({
    watermarks: await kernel.monitoring.listWatermarks(s, ws),
  }));
  get("/monitors/counters", async (s, ws) => kernel.monitoring.triggerCounters(s, ws));
  /** Trigger history export: replay rows are labelled REPLAY and the report text says so. */
  get<{ format?: string }>("/monitors/export", async (s, ws, req) => {
    const e = await kernel.monitoring.exportTriggerHistory(s, ws);
    return req.query.format === "csv" ? { csv: e.csv } : { rows: e.rows, report: e.report };
  });
  get("/markers/:mid/delegations", async (s, ws, req) => {
    if (!Uuid.safeParse(req.params.mid).success) throw workspaceNotFound();
    return { delegations: await kernel.monitoring.listDelegations(s, ws, req.params.mid!) };
  });
  /** Owner/admin only: what a member may delegate to agents (ch.11 delegation scope). */
  app.put<{ Params: { id: string } }>("/v1/workspaces/:id/delegation-scopes", (req, reply) =>
    scoped(req, async (s, ws) => {
      await kernel.delegation.set(s, ws, req.body);
      return reply.status(204).send();
    }),
  );

  /** Composite: create a marker, and with an explicit `task` activate it and start the scoped child investigation. */
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/markers", async (req, reply) => {
    const body = PostMarkerBody.safeParse(req.body);
    if (!body.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
        details: zodDetails(body.error),
      });
    return scoped(req, async (s, ws) => {
      const { task, ...create } = body.data;
      const markerId = create.markerId ?? randomUUID();
      const version = async () => (await kernel.workspaces.get(s, ws)).version;
      const run = async (
        commandType: "marker.create" | "marker.transition" | "marker.assign",
        payload: Record<string, unknown>,
      ) =>
        kernel.commands.execute(
          s,
          ws,
          {
            apiVersion: "v1",
            commandId: randomUUID(),
            commandType,
            payload,
            expectedVersion: await version(),
          },
          { traceId: req.traceId },
        );
      await run("marker.create", { ...create, markerId });
      let taskId: string | null = null;
      if (task) {
        await run("marker.transition", { markerId, to: "ACTIVE" });
        await run("marker.assign", { markerId, ...task });
        taskId = (await kernel.monitoring.listTasks(s, ws, markerId))[0]?.taskId ?? null;
        // Starting the run is the dispatcher's job; kick it now so the caller sees a RUNNING task promptly.
        void tasks.dispatchOpen().catch(() => undefined);
      }
      return reply.status(201).send({ markerId, taskId });
    });
  });

  /** Dispatch pending marker tasks and reconcile finished runs now (the background loop does the same). */
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/marker-tasks/dispatch", (req, reply) =>
    scoped(req, async (s, ws) => {
      if (!canWrite(s.role)) throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted.");
      await kernel.monitoring.listTasks(s, ws); // ACL probe
      return reply.status(202).send(await tasks.dispatchOpen());
    }),
  );

  /**
   * Replay recorded events against THIS workspace's rules only. Events are flagged `replay` end to end (trigger rows,
   * notifications, domain events, tasks) and never touch other tenants' rules or the live inbox.
   */
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/monitors/replay", (req, reply) =>
    scoped(req, async (s, ws) => {
      if (!canWrite(s.role)) throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role not permitted.");
      await kernel.monitoring.listTasks(s, ws); // ACL probe
      const body = ReplayBody.safeParse(req.body);
      if (!body.success)
        throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
          details: zodDetails(body.error),
        });
      const sorted = [...body.data.events].sort((a, b) => Date.parse(a.watermark) - Date.parse(b.watermark));
      const results = [];
      for (const e of sorted)
        results.push(
          ...(await scheduler.processEvent(
            { sourceId: body.data.sourceId, mode: "replay", ...e },
            { workspaceId: ws },
          )),
        );
      return reply.status(200).send({ mode: "replay", processed: sorted.length, results });
    }),
  );
};

export type { FastifyInstance };
