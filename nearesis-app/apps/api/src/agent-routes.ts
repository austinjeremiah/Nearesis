import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, workspaceNotFound, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { apiErrorOf, injectApi } from "./agent/api-client.ts";
import type { AgentApi, AgentUser } from "./agent/api-client.ts";
import { AgentService } from "./agent/service.ts";
import type { AgentServiceOptions } from "./agent/service.ts";
import { validateOrder, validateStep } from "./agent/catalog.ts";
import type { PlannedStep } from "./agent/catalog.ts";
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
  workspaceId: Uuid.nullable().optional(),
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
const ThesisId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const thesisNotFound = () => new KernelError("NOT_FOUND", "THESIS_NOT_FOUND", "Thesis not found.");
const REFERENCE_THESIS_ID = "reference-near-intents";
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
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
    return reply
      .status(202)
      .send(await svc.postMessage(userOf(s), req.params.id, b.text, b.workspaceId ?? undefined));
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
  /**
   * Reproduce a thesis in the caller's account: a thread and a PROPOSED task (nothing runs until the user presses Start, which
   * spends their credits). The thesis is read through the thesis route as the caller, so only a thesis they can see is reproducible.
   */
  app.post<{ Params: { id: string } }>("/v1/theses/:id/reproduce", async (req, reply) => {
    const s = await authenticate(req);
    if (!ThesisId.safeParse(req.params.id).success) throw thesisNotFound();
    const u = userOf(s);
    const r = await svc.api(u, "GET", `/v1/theses/${encodeURIComponent(req.params.id)}`);
    if (r.status === 404) throw thesisNotFound();
    if (r.status < 200 || r.status >= 300) {
      const x = apiErrorOf(r);
      throw new KernelError(
        r.status === 401 ? "UNAUTHENTICATED" : r.status === 403 ? "FORBIDDEN" : "UPSTREAM_DEGRADED",
        x.reasonCode,
        x.message,
        { retryable: x.retryable },
      );
    }
    const body = (r.body ?? {}) as { thesis?: Record<string, unknown>; doc?: Record<string, unknown> };
    const summary = body.thesis ?? {};
    const doc = body.doc ?? {};
    const origin = (doc.origin ?? {}) as Record<string, unknown>;
    if (
      req.params.id === REFERENCE_THESIS_ID ||
      summary.kind === "reference" ||
      summary.id === REFERENCE_THESIS_ID ||
      origin.kind === "reference"
    ) {
      const rep = (doc.reproduce ?? {}) as Record<string, unknown>;
      const commands = [
        text(rep.command) ?? "pnpm thesis:build",
        text(rep.check) ?? "pnpm thesis:verify",
        "pnpm thesis:data",
      ];
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "REFERENCE_THESIS_OFFLINE",
        "The reference thesis is rebuilt offline from its frozen data, not through the agent.",
        {
          retryable: false,
          nextAction: `From the repository root nearesis-app run: ${commands.join(" ; ")}`,
          detailsObject: { commands, folder: "nearesis-app" },
        },
      );
    }
    const title = text(summary.title) ?? text(doc.title) ?? req.params.id;
    const hypothesis = text(summary.hypothesis) ?? text(doc.hypothesis);
    if (!hypothesis)
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "THESIS_HAS_NO_HYPOTHESIS",
        "This thesis does not state a hypothesis, so there is nothing to reproduce.",
        { retryable: false },
      );
    // The original question: carried by the document, else read from the original run when the caller can see it, else the hypothesis.
    let question = text(origin.question) ?? text(doc.question);
    let source = "the thesis document";
    if (!question && typeof origin.workspaceId === "string" && typeof origin.runId === "string") {
      const rr = await svc.api(u, "GET", `/v1/workspaces/${encodeURIComponent(origin.workspaceId)}/runs`);
      if (rr.status === 200) {
        const runs = (rr.body as { runs?: Array<{ runId?: string; questionSummary?: string }> } | null)?.runs;
        const hit = Array.isArray(runs) ? runs.find((x) => x.runId === origin.runId) : undefined;
        question = text(hit?.questionSummary);
        if (question) source = "the original run";
      }
    }
    const fallback = !question;
    if (!question) question = hypothesis;
    question = question.slice(0, 2000);
    const planned: PlannedStep[] = [
      validateStep("workspace.create", { objective: `Reproduction of: ${hypothesis}`.slice(0, 2000) }),
      validateStep("question.ask", { question }),
      validateStep("run.await", {}),
      validateStep("capsule.build", {}),
      validateStep("thesis.build", {}),
      validateStep("thesis.compare", { against: req.params.id }),
    ];
    validateOrder(planned, {});
    const thread = await svc.store.createThread(ctxOf(u), `Reproduce: ${title}`.slice(0, 200), null);
    const taskId = await svc.createTask(u, thread.id, null, `Reproduce: ${title}`.slice(0, 200), planned, {
      1: fallback
        ? "The thesis does not carry its original question and the original run is not visible to you, so the hypothesis is used as the question. Starts a live investigation with the minimum budget (model spend is charged to your credits)."
        : `Starts a live investigation of the original question (read from ${source}) with the minimum budget (model spend is charged to your credits): "${question.slice(0, 160)}".`,
    });
    return reply.status(201).send({ threadId: thread.id, taskId });
  });
  app.get("/v1/agent/costs", async (req) => {
    const s = await authenticate(req);
    const q = parse(CostsQuery, req.query);
    const c = ctxOf(userOf(s));
    if (q.threadId && !(await svc.store.getThread(c, q.threadId))) throw threadNotFound();
    return svc.store.costs(c, q.threadId ?? null, q.limit);
  });
};
(agentRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
