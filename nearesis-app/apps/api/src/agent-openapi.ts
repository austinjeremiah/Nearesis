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
  R(
    "get",
    "/v1/agent/tasks/:id",
    "A task with its steps (each with a one-line `why`), test plan (`testPlan`, null when the plan has no investigation), consent, estimate, costs and links",
    {
      ok: "Task",
    },
  ),
  R(
    "patch",
    "/v1/agent/tasks/:id/test-plan",
    "Edit the test plan of a PROPOSED task (owner only). Any of statement, xLabel, yLabel, relation, lagDays, expectedSign, windowDays, wouldCountAsWrong; each is validated (plain text, no numbers in the sentences, no causal or bullish wording, the two labels name different series) and a bad field is a 422 INVALID_TEST_PLAN with details [{ path, issue }]. `statement: null` clears the plan. editedByUser becomes true. 409 TEST_PLAN_LOCKED once the task has started (Start locks the plan: lockedAt and sha256 are set and never change)",
    {
      body: z.strictObject({
        statement: z.string().nullable().optional(),
        xLabel: z.string().optional(),
        yLabel: z.string().optional(),
        relation: z.enum(["moves_with", "leads"]).optional(),
        lagDays: z.number().optional(),
        expectedSign: z.enum(["positive", "negative", "either"]).optional(),
        windowDays: z.number().optional(),
        wouldCountAsWrong: z.string().optional(),
      }),
      ok: "Task (testPlan: { statement, xLabel, yLabel, relation, lagDays, expectedSign, windowDays, wouldCountAsWrong, editedByUser, lockedAt, sha256 })",
    },
  ),
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
  R(
    "post",
    "/v1/theses/:id/reproduce",
    'Reproduce a thesis the caller can see: creates an agent thread titled "Reproduce: <title>" and a PROPOSED task (nothing runs): workspace.create, question.ask, run.await, capsule.build, thesis.build, thesis.compare against the original. The user presses Start on the Agent page (their credits). 404 THESIS_NOT_FOUND when the thesis is not visible; 422 REFERENCE_THESIS_OFFLINE (details.commands) for the reference thesis',
    { status: "201", ok: "{ threadId, taskId }" },
  ),
  R(
    "get",
    "/v1/agent/costs",
    "Model USD and on-chain (OutLayer / anchor) USD per step and per message, with totals",
    {
      query: z.strictObject({
        threadId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      ok: "{ totals: { modelUsd, modelCalls, onChainUsd, totalUsd }, items: [{ ..., unit: usd, category: model|onchain, amount, detail? }] }",
    },
  ),
];
