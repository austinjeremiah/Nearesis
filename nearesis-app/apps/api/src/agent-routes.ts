import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, workspaceNotFound, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { injectApi } from "./agent/api-client.ts";
import type { AgentApi, AgentUser } from "./agent/api-client.ts";
import { AgentService } from "./agent/service.ts";
import type { AgentServiceOptions } from "./agent/service.ts";
import { CONSENT_KEYS } from "./agent/types.ts";

export interface AgentRoutesOptions extends Partial<
  Pick<
    AgentServiceOptions,
    "model" | "inference" | "externalModelSpend" | "executor" | "now" | "messagesPerWindow" | "windowMs"
  >
> {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam: replaces the in-process calls (default: app.inject with a session minted for the task's user). */
  api?: AgentApi;
  /** Exposes the service to tests. */
  onService?: (s: AgentService) => void;
}

const Uuid = z.uuid();
const Title = z.string().trim().min(1).max(200);
const CreateThread = z.strictObject({ title: Title.optional(), workspaceId: Uuid.nullable().optional() });
const PatchThread = z.strictObject({ title: Title.optional(), workspaceId: Uuid.nullable().optional() });
const PostMessage = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  workspaceId: Uuid.optional(),
});
const StartBody = z.strictObject({ consent: z.array(z.enum(CONSENT_KEYS as [string, ...string[]])).max(8) });
const RetryBody = z.strictObject({ acknowledge: z.array(z.string().min(1).max(100)).max(20).optional() });
const ApprovalBody = z.strictObject({ decision: z.enum(["approve", "reject"]) });
const CostsQuery = z.strictObject({
  threadId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function parse<S extends z.ZodType>(schema: S, v: unknown): z.infer<S> {
  const r = schema.safeParse(v ?? {});
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request.", {
      details: zodDetails(r.error),
    });
  return r.data;
}
const threadNotFound = () => new KernelError("NOT_FOUND", "THREAD_NOT_FOUND", "Thread not found.");
const taskNotFound = () => new KernelError("NOT_FOUND", "TASK_NOT_FOUND", "Task not found.");

/**
 * Agent v2: user-tied threads, messages, planned tasks with live steps and per-step costs. Everything is scoped to the
 * signed-in user (row-level security); another user's thread or task is a 404. Tasks act through the public routes as the user.
 */
export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  const mint = async (u: AgentUser): Promise<string> => {
    const auth = kernel.devAuth;
    if (!auth)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "SESSION_ISSUER_UNAVAILABLE",
        "Sessions cannot be issued here.",
      );
    return auth.issueSessionFor(u.userId, u.orgId);
  };
  const svc = new AgentService({
    db: kernel.db,
    api: opts.api ?? injectApi(app, mint),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.inference ? { inference: opts.inference } : {}),
    ...(opts.externalModelSpend ? { externalModelSpend: opts.externalModelSpend } : {}),
    ...(opts.executor ? { executor: opts.executor } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.messagesPerWindow ? { messagesPerWindow: opts.messagesPerWindow } : {}),
    ...(opts.windowMs ? { windowMs: opts.windowMs } : {}),
  });
  opts.onService?.(svc);
  const userOf = (s: Session): AgentUser => ({ userId: s.userId, orgId: s.principal.orgId });
  const ctxOf = (u: AgentUser) => ({ orgId: u.orgId, userId: u.userId });

  // Tasks left running by the previous process (the tables may not be migrated in some test fixtures).
  try {
    await svc.executor.recover();
  } catch {
    /* routes fail on first use with a clear error */
  }
  app.addHook("onClose", async () => {
    await svc.idle();
  });

  app.get("/v1/agent/threads", async (req) => {
    const s = await authenticate(req);
    return { items: await svc.store.listThreads(ctxOf(userOf(s))) };
  });
  app.post("/v1/agent/threads", async (req, reply) => {
    const s = await authenticate(req);
    const b = parse(CreateThread, req.body);
    const u = userOf(s);
    if (b.workspaceId) {
      const r = await svc.api(u, "GET", `/v1/workspaces/${b.workspaceId}`);
      if (r.status !== 200) throw workspaceNotFound();
    }
    return reply.status(201).send(await svc.store.createThread(ctxOf(u), b.title, b.workspaceId ?? null));
  });
  app.get<{ Params: { id: string } }>("/v1/agent/threads/:id", async (req) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw threadNotFound();
    const c = ctxOf(userOf(s));
    const thread = await svc.store.getThread(c, req.params.id);
    if (!thread) throw threadNotFound();
    const [messages, tasks] = await Promise.all([
      svc.store.listMessages(c, thread.id),
      svc.store.tasksOfThread(c, thread.id),
    ]);
    return { thread, messages, tasks };
  });
  app.patch<{ Params: { id: string } }>("/v1/agent/threads/:id", async (req) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw threadNotFound();
    const b = parse(PatchThread, req.body);
    const u = userOf(s);
    if (b.workspaceId) {
      const r = await svc.api(u, "GET", `/v1/workspaces/${b.workspaceId}`);
      if (r.status !== 200) throw workspaceNotFound();
    }
    const t = await svc.store.patchThread(ctxOf(u), req.params.id, {
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.workspaceId !== undefined ? { workspaceId: b.workspaceId } : {}),
    });
    if (!t) throw threadNotFound();
    return t;
  });
  app.delete<{ Params: { id: string } }>("/v1/agent/threads/:id", async (req, reply) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw threadNotFound();
    if (!(await svc.store.deleteThread(ctxOf(userOf(s)), req.params.id))) throw threadNotFound();
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>("/v1/agent/threads/:id/messages", async (req, reply) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw threadNotFound();
    const b = parse(PostMessage, req.body);
    return reply.status(202).send(await svc.postMessage(userOf(s), req.params.id, b.text, b.workspaceId));
  });

  const taskOr404 = async (s: Session, id: string) => {
    if (!Uuid.safeParse(id).success) throw taskNotFound();
    const t = await svc.store.getTask(ctxOf(userOf(s)), id);
    if (!t) throw taskNotFound();
    return t;
  };
  app.get<{ Params: { id: string } }>("/v1/agent/tasks/:id", async (req) =>
    taskOr404(await authenticate(req), req.params.id),
  );
  app.post<{ Params: { id: string } }>("/v1/agent/tasks/:id/start", async (req) => {
    const s = await authenticate(req);
    await taskOr404(s, req.params.id);
    const b = parse(StartBody, req.body);
    await svc.executor.start(userOf(s), req.params.id, b.consent as never);
    return taskOr404(s, req.params.id);
  });
  app.post<{ Params: { id: string } }>("/v1/agent/tasks/:id/cancel", async (req) => {
    const s = await authenticate(req);
    await taskOr404(s, req.params.id);
    await svc.executor.cancel(userOf(s), req.params.id);
    return taskOr404(s, req.params.id);
  });
  app.post<{ Params: { id: string } }>("/v1/agent/tasks/:id/retry", async (req) => {
    const s = await authenticate(req);
    await taskOr404(s, req.params.id);
    const b = parse(RetryBody, req.body);
    await svc.executor.retry(userOf(s), req.params.id, b.acknowledge);
    return taskOr404(s, req.params.id);
  });
  app.post<{ Params: { id: string; idx: string } }>(
    "/v1/agent/tasks/:id/steps/:idx/approval",
    async (req) => {
      const s = await authenticate(req);
      await taskOr404(s, req.params.id);
      if (!/^\d{1,3}$/.test(req.params.idx)) throw taskNotFound();
      const b = parse(ApprovalBody, req.body);
      await svc.executor.decide(userOf(s), req.params.id, Number(req.params.idx), b.decision);
      return taskOr404(s, req.params.id);
    },
  );
  app.get("/v1/agent/costs", async (req) => {
    const s = await authenticate(req);
    const q = parse(CostsQuery, req.query);
    const c = ctxOf(userOf(s));
    if (q.threadId && !(await svc.store.getThread(c, q.threadId))) throw threadNotFound();
    return svc.store.costs(c, q.threadId ?? null, q.limit);
  });
};
(agentRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
