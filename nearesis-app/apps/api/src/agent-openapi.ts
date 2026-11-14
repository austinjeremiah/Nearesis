import { z } from "zod";
import type { HttpMethod, ResponseSpec, RouteSpec } from "@nearesis/contracts";

const R = (
  method: HttpMethod,
  path: string,
  summary: string,
  extra: Partial<RouteSpec> & { ok?: ResponseSpec | string; status?: string } = {},
): RouteSpec => {
  const { ok, status, ...rest } = extra;
  const okResp: ResponseSpec =
    typeof ok === "string" || ok === undefined ? { description: ok ?? "OK", untyped: true } : ok;
  return {
    method,
    path,
    tag: "agent",
    summary,
    auth: "bearer",
    responses: { [status ?? "200"]: okResp },
    ...rest,
  };
};

const Consent = z.enum(["spend_credits", "publish_public", "freeze_hypothesis", "archive_workspace"]);

/** Agent v2 routes (apps/api/src/agent-routes.ts). Spread into ROUTES by openapi-routes.ts. */
export const AGENT_ROUTES: RouteSpec[] = [
  R("get", "/v1/agent/threads", "The caller's agent threads, newest first", {
    ok: "{ items: [{ id, title, workspaceId, updatedAt, preview, activeTaskId }] }",
  }),
  R("post", "/v1/agent/threads", "Create a thread", {
    body: z.strictObject({
      title: z.string().min(1).max(200).optional(),
      workspaceId: z.uuid().nullable().optional(),
    }),
    status: "201",
    ok: "Thread",
  }),
  R("get", "/v1/agent/threads/:id", "A thread with its messages and tasks (another user's thread is 404)", {
    ok: "{ thread, messages: Message[], tasks: Task[] }",
  }),
  R("patch", "/v1/agent/threads/:id", "Rename a thread or switch its workspace", {
    body: z.strictObject({
      title: z.string().min(1).max(200).optional(),
      workspaceId: z.uuid().nullable().optional(),
    }),
    ok: "Thread",
  }),
  R("delete", "/v1/agent/threads/:id", "Delete a thread (soft)", { status: "204", ok: "Deleted" }),
  R(
    "post",
    "/v1/agent/threads/:id/messages",
    "Send a message. 202 with the user message and a pending reply that is filled in the background (answer, plan, clarify or direct lookup); poll the thread every 2 s",
    {
      body: z.strictObject({ text: z.string().min(1).max(2000), workspaceId: z.uuid().optional() }),
      status: "202",
      ok: "{ userMessage: Message, reply: Message }",
    },
  ),
  R("get", "/v1/agent/tasks/:id", "A task with its steps, consent, estimate, costs and links", {
    ok: "Task",
  }),
  R(
    "post",
    "/v1/agent/tasks/:id/start",
    "Start a proposed task. 422 CONSENT_MISSING lists the consent keys not given; 409 TASK_ALREADY_RUNNING when the user already has an active task",
    { body: z.strictObject({ consent: z.array(Consent) }), ok: "Task (running)" },
  ),
  R("post", "/v1/agent/tasks/:id/cancel", "Cancel a task; its run is cancelled through the run route", {
    ok: "Task",
  }),
  R(
    "post",
    "/v1/agent/tasks/:id/retry",
    "Resume a failed task at the failed step (done steps are never repeated). publish steps accept `acknowledge`",
    { body: z.strictObject({ acknowledge: z.array(z.string()).optional() }).optional(), ok: "Task" },
  ),
  R(
    "post",
    "/v1/agent/tasks/:id/steps/:idx/approval",
    "Decide the run approval a waiting step shows; forwarded to the run approval route as the user",
    { body: z.strictObject({ decision: z.enum(["approve", "reject"]) }), ok: "Task" },
  ),
  R("get", "/v1/agent/costs", "Model USD and credits per step and per message, with totals", {
    query: z.strictObject({
      threadId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    ok: "{ totals: { modelUsd, modelCalls, creditsChargedYocto }, items: [...] }",
  }),
];
