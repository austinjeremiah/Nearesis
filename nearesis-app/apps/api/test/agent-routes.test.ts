/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError } from "@nearesis/kernel";
import type { AssistantModelPort } from "@nearesis/workflow";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { injectApi } from "../src/agent/api-client.ts";
import type { AgentApi, AgentUser } from "../src/agent/api-client.ts";
import {
  CATALOG_DOC,
  PLAYBOOKS,
  consentFor,
  titleOf,
  validateOrder,
  validateStep,
} from "../src/agent/catalog.ts";
import type { PlannedStep } from "../src/agent/catalog.ts";
import { AGENT_PLANNER_SYSTEM, PlannerOutput, interpret } from "../src/agent/planner.ts";
import type { AgentService } from "../src/agent/service.ts";

// ---------------------------------------------------------------- pure: plan validation and consent
const out = (o: Partial<PlannerOutput>): PlannerOutput => ({
  route: "plan",
  text: "",
  title: "t",
  lookup: "none",
  workspaceId: "",
  steps: [],
  ...o,
});
const step = (key: string, params: unknown = {}) => ({ key, params: JSON.stringify(params) });

describe("plan validation against the catalog", () => {
  it("accepts the investigate playbook", () => {
    const d = interpret(
      out({
        steps: [
          step("workspace.create", { objective: "Why did swaps fall?" }),
          step("question.ask"),
          step("run.await"),
          step("setup.auto"),
        ],
      }),
      {},
    );
    expect(d.kind).toBe("plan");
    if (d.kind === "plan")
      expect(d.steps.map((s) => s.key)).toEqual([
        "workspace.create",
        "question.ask",
        "run.await",
        "setup.auto",
        // every investigation ends with a thesis; the server adds the capsule it is built from
        "capsule.build",
        "thesis.build",
      ]);
  });
  it("turns an unknown key, an unknown param, bad JSON and a broken order into a text reply", () => {
    for (const steps of [
      [step("wallet.transfer", { to: "x" })],
      [step("workspace.create", { objective: "o", extra: 1 })],
      [{ key: "workspace.create", params: "{not json" }],
      [step("question.ask")],
      [step("capsule.prove")],
      [],
    ]) {
      const d = interpret(out({ steps }), {});
      expect(d.kind).toBe("text");
    }
  });
  it("never trusts consent or costs from the model (the schema has no field for them)", () => {
    expect(PlannerOutput.safeParse({ ...out({}), consent: ["spend_credits"] }).success).toBe(false);
  });
});

describe("server-side consent", () => {
  const P = (key: string, params: Record<string, unknown> = {}): PlannedStep => validateStep(key, params);
  it("prove needs spend_credits capped at the current estimate", () => {
    const c = consentFor([P("capsule.prove", { capsuleId: "cap" })], "0.012346");
    expect(c).toEqual([expect.objectContaining({ key: "spend_credits", maxUsd: "0.012346" })]);
    expect(c[0]).not.toHaveProperty("maxYocto");
    // two proofs hold twice the estimate, exactly
    expect(
      consentFor(
        [P("capsule.prove", { capsuleId: "a" }), P("capsule.prove", { capsuleId: "b" })],
        "0.012346",
      )[0],
    ).toMatchObject({ maxUsd: "0.024692" });
  });
  it("prove with an unknown estimate still needs consent, with a null max", () => {
    expect(consentFor([P("capsule.prove", { capsuleId: "cap" })], null)[0]).toMatchObject({
      key: "spend_credits",
      maxUsd: null,
    });
  });
  it("publish needs publish_public plus spend_credits; freeze and archive need theirs", () => {
    const keys = (s: PlannedStep[]) =>
      consentFor(s, "1")
        .map((c) => c.key)
        .sort();
    expect(keys([P("capsule.publish", { capsuleId: "c" })])).toEqual(["publish_public", "spend_credits"]);
    expect(keys([P("hypothesis.freeze", { hypothesisId: crypto.randomUUID() })])).toEqual([
      "freeze_hypothesis",
    ]);
    expect(keys([P("workspace.archive", { workspaceId: crypto.randomUUID() })])).toEqual([
      "archive_workspace",
    ]);
    expect(keys([P("report.build", { workspaceId: crypto.randomUUID() })])).toEqual([]);
  });
  it("order check passes a full publish playbook", () => {
    const steps = [
      "workspace.create",
      "question.ask",
      "run.await",
      "capsule.build",
      "capsule.prove",
      "capsule.publish",
      "report.build",
    ].map((k) => P(k, k === "workspace.create" ? { objective: "o" } : {}));
    expect(() => validateOrder(steps, {})).not.toThrow();
  });
});

// ---------------------------------------------------------------- app fixture
let f: ApiFixture;
let svc: AgentService;
let real: AgentApi;
let stub: AgentApi | null = null;
let plan: PlannerOutput = out({ route: "text", text: "hello" });
let modelFail: unknown = null;
const model: AssistantModelPort = {
  generate: async <T>(a: { schema: { parse(v: unknown): T } }) => {
    if (modelFail) throw modelFail;
    return a.schema.parse(plan);
  },
  usage: () => ({ usd: 0.0021, modelCalls: 1 }),
};
let alice: string;
let bob: string;
let aliceU: AgentUser;
let bobU: AgentUser;
const call = (tok: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  f.app.inject({
    method,
    url,
    headers: bearer(tok),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

beforeAll(async () => {
  f = await apiFixture({
    runtime: true,
    appOptions: {
      agent: {
        model: async () => model,
        api: (u, m, url, p, h) => (stub ?? real)(u, m, url, p, h),
        onService: (s) => {
          svc = s;
        },
        executor: { sleep: async () => undefined, limits: { settleWaitMs: 0, runVisibleGraceMs: 0 } },
        messagesPerWindow: 1000,
      },
    },
  });
  real = injectApi(f.app, (u) => f.kernel.devAuth!.issueSessionFor(u.userId, u.orgId));
  const a = await seedOrg(f.db.admin, "ag", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "ag-b", { bob: "owner" });
  alice = await login(f.app, a.users.alice!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  aliceU = { userId: a.users.alice!.userId, orgId: a.orgId };
  bobU = { userId: b.users.bob!.userId, orgId: b.orgId };
}, 60_000);
afterAll(async () => f?.close());

const newThread = async (tok = alice) =>
  (await call(tok, "POST", "/v1/agent/threads", {})).json<{ id: string }>().id;
async function waitFor<T>(fn: () => Promise<T | null | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const taskOf = async (id: string, tok = alice) =>
  (await call(tok, "GET", `/v1/agent/tasks/${id}`)).json<any>();
const settle = async (id: string, states: string[]) =>
  waitFor(async () => {
    const t = await taskOf(id);
    return states.includes(t.state) ? t : null;
  });
/** Creates a proposed task through the service (the planner path is covered separately). */
const propose = async (steps: PlannedStep[], threadId?: string, workspaceId: string | null = null) =>
  svc.createTask(aliceU, threadId ?? (await newThread()), workspaceId, "Test task", steps);
const S = (key: string, params: Record<string, unknown> = {}) => validateStep(key, params);

type Handler = (p: {
  method: string;
  url: string;
  body: any;
  headers?: Record<string, string>;
}) => { status: number; body: unknown } | null;
function stubWith(handlers: Handler[], log: string[] = []): AgentApi {
  return async (u, method, url, body, headers) => {
    log.push(`${method} ${url}`);
    for (const h of handlers) {
      const r = h({ method, url, body, ...(headers ? { headers } : {}) });
      if (r) return r;
    }
    return real(u, method, url, body, headers);
  };
}
const is =
  (method: string, re: RegExp): ((p: { method: string; url: string }) => boolean) =>
  (p) =>
    p.method === method && re.test(p.url);

describe("messages and planning", () => {
  it("answers a text reply, records the planner cost on the message and the costs endpoint", async () => {
    stub = null;
    plan = out({ route: "text", text: "I cannot post to Twitter." });
    const tid = await newThread();
    const r = await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "tweet this" });
    expect(r.statusCode).toBe(202);
    const { userMessage, reply } = r.json<any>();
    expect(userMessage.role).toBe("user");
    expect(reply.state).toBe("pending");
    await svc.idle();
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    const m = th.messages.find((x: any) => x.id === reply.id);
    expect(m).toMatchObject({
      state: "ready",
      kind: "text",
      text: "I cannot post to Twitter.",
      cost: { modelUsd: "0.002100", modelCalls: 1 },
    });
    expect(th.thread.title).toBe("tweet this");
    const costs = (await call(alice, "GET", `/v1/agent/costs?threadId=${tid}`)).json<any>();
    expect(costs.totals).toEqual({
      modelUsd: "0.002100",
      modelCalls: 1,
      onChainUsd: "0.000000",
      totalUsd: "0.002100",
    });
    expect(costs.items[0]).toMatchObject({ label: "Planner", unit: "usd", amount: "0.002100", taskId: null });
  });

  it("a plan reply carries a proposed task with server-side consent; start refuses without it (422 CONSENT_MISSING)", async () => {
    stub = null;
    plan = out({
      title: "Verify it",
      steps: [
        step("workspace.create", { objective: "o" }),
        step("question.ask"),
        step("run.await"),
        step("capsule.build"),
        step("capsule.prove"),
      ],
    });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "build and prove a capsule" });
    await svc.idle();
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    const reply = th.messages.find((x: any) => x.role === "assistant");
    expect(reply.kind).toBe("plan");
    const task = th.tasks[0];
    expect(task.id).toBe(reply.taskId);
    expect(task).toMatchObject({ state: "proposed", consent: { given: [] } });
    expect(task.consent.required.map((c: any) => c.key)).toEqual(["spend_credits"]);
    expect(task.estimate.modelUsdMax).toBe("3.000000");
    expect(task.steps).toHaveLength(6);
    expect(task.steps.map((x: any) => x.key).at(-1)).toBe("thesis.build");
    const bad = await call(alice, "POST", `/v1/agent/tasks/${task.id}/start`, { consent: [] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<any>().reasonCode).toBe("CONSENT_MISSING");
    expect(bad.json<any>().details[0].issue).toBe("spend_credits");
    expect((await taskOf(task.id)).state).toBe("proposed");
  });

  it("an invalid plan from the model becomes a text reply", async () => {
    plan = out({ steps: [step("shell.exec", { cmd: "rm -rf /" })] });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "do it" });
    await svc.idle();
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    expect(th.messages[1]).toMatchObject({ kind: "text", state: "ready" });
    expect(th.messages[1].text).toContain("not something I can do");
    expect(th.tasks).toHaveLength(0);
  });

  it("refuses with the budget error when the ceiling is reached", async () => {
    modelFail = new KernelError(
      "BUDGET_EXCEEDED",
      "GLOBAL_CEILING",
      "The global model-spend ceiling is reached.",
    );
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "hello" });
    await svc.idle();
    modelFail = null;
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    expect(th.messages[1]).toMatchObject({ state: "failed", error: { reasonCode: "GLOBAL_CEILING" } });
  });

  it("a direct lookup returns rows", async () => {
    plan = out({ route: "direct", lookup: "workspaces" });
    const ws = await call(alice, "POST", "/v1/workspaces", {
      objective: "Lookup me",
      networkScope: "fixture-only",
      idempotencyKey: "agent-test-lookup",
    });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "list my workspaces" });
    await svc.idle();
    const m = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>().messages[1];
    expect(m.kind).toBe("result");
    expect(m.rows).toEqual(
      expect.arrayContaining([
        { label: "Lookup me", value: ws.json<any>().workspaceId, href: `/w/${ws.json<any>().workspaceId}` },
      ]),
    );
  });
});

describe("isolation between users", () => {
  it("another user's thread, task, messages and costs are 404", async () => {
    stub = null;
    plan = out({ route: "text", text: "ok" });
    const tid = await newThread();
    const taskId = await propose([S("report.build", { workspaceId: crypto.randomUUID() })], tid);
    expect((await call(bob, "GET", `/v1/agent/threads/${tid}`)).statusCode).toBe(404);
    expect((await call(bob, "PATCH", `/v1/agent/threads/${tid}`, { title: "x" })).statusCode).toBe(404);
    expect((await call(bob, "DELETE", `/v1/agent/threads/${tid}`)).statusCode).toBe(404);
    expect((await call(bob, "POST", `/v1/agent/threads/${tid}/messages`, { text: "hi" })).statusCode).toBe(
      404,
    );
    expect((await call(bob, "GET", `/v1/agent/tasks/${taskId}`)).statusCode).toBe(404);
    expect((await call(bob, "POST", `/v1/agent/tasks/${taskId}/start`, { consent: [] })).statusCode).toBe(
      404,
    );
    expect((await call(bob, "POST", `/v1/agent/tasks/${taskId}/cancel`)).statusCode).toBe(404);
    expect((await call(bob, "GET", `/v1/agent/costs?threadId=${tid}`)).statusCode).toBe(404);
    const bobList = (await call(bob, "GET", "/v1/agent/threads")).json<any>().items;
    expect(bobList.find((t: any) => t.id === tid)).toBeUndefined();
    expect(bobU.userId).not.toBe(aliceU.userId);
  });
});

const runId = "11111111-1111-4111-8111-111111111111";
const run = (r: Record<string, unknown>) => ({
  runId,
  version: 3,
  terminal: false,
  children: [{ status: "DONE" }, { status: "RUNNING" }],
  budget: { spent: { usd: 0.0123, toolCalls: 4 } },
  findings: [],
  interpretation: { state: "none", reason: null, findingCount: 0 },
  ...r,
});
const questionStub: Handler = (p) =>
  is("POST", /\/questions$/)(p) ? { status: 202, body: { runId, workflowId: "w" } } : null;
const runGet = (states: Array<Record<string, unknown>>): Handler => {
  let i = 0;
  return (p) =>
    is("GET", new RegExp(`^/v1/runs/${runId}$`))(p)
      ? { status: 200, body: states[Math.min(i++, states.length - 1)] }
      : null;
};
const investigate = () => [
  S("workspace.create", { objective: "Why?" }),
  S("question.ask"),
  S("run.await"),
  S("setup.auto"),
];

describe("executor", () => {
  it("runs the investigate flow through the public routes, auto-approves only the zero-cost canvas patch, records costs and posts a result", async () => {
    const log: string[] = [];
    const headers: Array<Record<string, string> | undefined> = [];
    stub = stubWith(
      [
        (p) => (headers.push(p.headers), null),
        questionStub,
        runGet([
          run({ state: "RUNNING" }),
          run({ state: "APPROVAL_NEEDED" }),
          run({
            state: "COMPLETE",
            terminal: true,
            findings: [{ statement: "s", status: "supported" }],
            interpretation: { state: "ready", reason: null, findingCount: 1 },
          }),
        ]),
        (p) =>
          is("GET", new RegExp(`/v1/runs/${runId}/approvals$`))(p)
            ? {
                status: 200,
                body: {
                  runId,
                  state: "APPROVAL_NEEDED",
                  approvals: [
                    {
                      approvalId: "7",
                      actionHash: "h7",
                      status: "pending",
                      kind: "canvas.apply_patch",
                      costLimit: 0,
                    },
                  ],
                },
              }
            : null,
        (p) =>
          is("POST", new RegExp(`/v1/runs/${runId}/approvals/7$`))(p)
            ? { status: 202, body: { ok: true } }
            : null,
        (p) =>
          is("POST", /\/assistant\/setup$/)(p)
            ? {
                status: 200,
                body: {
                  markers: [{ id: "m", title: "Peak", reason: "r" }],
                  monitors: [],
                  hypothesis: { id: "11111111-2222-4333-8444-555555555555", title: "H" },
                  skipped: [],
                  cost: { usd: 0.004, modelCalls: 2 },
                },
              }
            : null,
      ],
      log,
    );
    const tid = await newThread();
    const id = await svc.createTask(aliceU, tid, null, "Investigate", investigate());
    const started = await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    expect(started.statusCode).toBe(200);
    expect(started.json<any>().state).toBe("running");
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(t.steps.map((s: any) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(t.links.runId).toBe(runId);
    expect(t.links.workspaceId).toBe(t.steps[0].result.items[0].value);
    expect(t.steps[1].result.items[0].href).toMatch(/^\/w\/.+\/investigate\?run=/);
    expect(log.filter((l) => l.startsWith("POST /v1/runs") && l.includes("/approvals/"))).toEqual([
      `POST /v1/runs/${runId}/approvals/7`,
    ]);
    // idempotency keys derive from the task id and step index
    expect(headers.filter((h) => h?.["idempotency-key"]).map((h) => h!["idempotency-key"])).toEqual(
      expect.arrayContaining([`agent:${id}:0`, `agent:${id}:1`, `agent:${id}:3`]),
    );
    // costs: run spend (0.012300) on step 2, setup spend (0.004000) on step 3; totals on the task
    expect(t.steps[2].cost).toMatchObject({ modelUsd: "0.012300", modelCalls: 4 });
    expect(t.steps[3].cost).toMatchObject({ modelUsd: "0.004000", modelCalls: 2 });
    expect(t.cost).toMatchObject({
      modelUsd: "0.016300",
      modelCalls: 6,
      creditsUsd: "0.000000",
      creditsHeldUsd: "0.000000",
    });
    expect(t.steps[2].cost.entries[0]).toMatchObject({ unit: "usd", amount: "0.012300" });
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    const msg = th.messages.find((m: any) => m.kind === "result");
    expect(msg.taskId).toBe(id);
    expect(msg.rows.length).toBeGreaterThan(0);
    expect(msg.rows.every((r: any) => r.href === null || r.href.startsWith("/"))).toBe(true);
    expect(th.thread.workspaceId).toBe(t.links.workspaceId);
    stub = null;
  });

  it("pauses on any other approval (waiting_user) and resumes after the user's decision", async () => {
    let pending = true;
    stub = stubWith([
      questionStub,
      (p) =>
        is("GET", new RegExp(`^/v1/runs/${runId}$`))(p)
          ? {
              status: 200,
              body: pending
                ? run({ state: "APPROVAL_NEEDED" })
                : run({
                    state: "COMPLETE",
                    terminal: true,
                    interpretation: { state: "unavailable", reason: "x", findingCount: 0 },
                  }),
            }
          : null,
      (p) =>
        is("GET", new RegExp(`/v1/runs/${runId}/approvals$`))(p)
          ? {
              status: 200,
              body: {
                runId,
                approvals: pending
                  ? [
                      {
                        approvalId: "9",
                        actionHash: "h9",
                        status: "pending",
                        kind: "egress.paid",
                        costLimit: 2,
                      },
                    ]
                  : [],
              },
            }
          : null,
      (p) =>
        is("POST", new RegExp(`/v1/runs/${runId}/approvals/9$`))(p)
          ? ((pending = false), { status: 202, body: {} })
          : null,
    ]);
    const id = await propose(investigate().slice(0, 3));
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const w = await settle(id, ["waiting_user", "failed", "completed"]);
    expect(w.state).toBe("waiting_user");
    expect(w.steps[2]).toMatchObject({
      state: "waiting_user",
      waiting: { kind: "approval", runId, approvalId: "9", approvalKind: "egress.paid", costLimit: "2" },
    });
    await svc.idle();
    // a second decision on a non-waiting step is refused
    expect(
      (await call(alice, "POST", `/v1/agent/tasks/${id}/steps/0/approval`, { decision: "approve" }))
        .statusCode,
    ).toBe(409);
    const ok = await call(alice, "POST", `/v1/agent/tasks/${id}/steps/2/approval`, { decision: "approve" });
    expect(ok.statusCode).toBe(200);
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(t.steps[2].state).toBe("done");
    stub = null;
  });

  it("a failed step stops the task with the API's reason; retry resumes at that step and never repeats done steps", async () => {
    const log: string[] = [];
    let fail = true;
    stub = stubWith(
      [
        questionStub,
        runGet([
          run({
            state: "COMPLETE",
            terminal: true,
            interpretation: { state: "ready", reason: null, findingCount: 1 },
            findings: [{}],
          }),
        ]),
        (p) =>
          is("POST", /\/assistant\/setup$/)(p)
            ? fail
              ? {
                  status: 503,
                  body: {
                    reasonCode: "MODEL_UNAVAILABLE",
                    message: "The model could not answer just now.",
                    retryable: true,
                  },
                }
              : {
                  status: 200,
                  body: {
                    markers: [],
                    monitors: [],
                    hypothesis: null,
                    skipped: [],
                    cost: { usd: 0, modelCalls: 0 },
                  },
                }
            : null,
      ],
      log,
    );
    const id = await propose(investigate());
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["failed", "completed"]);
    expect(t.state).toBe("failed");
    expect(t.steps[3]).toMatchObject({
      state: "failed",
      error: { reasonCode: "MODEL_UNAVAILABLE", retryable: true },
    });
    expect(t.steps.slice(0, 3).map((s: any) => s.state)).toEqual(["done", "done", "done"]);
    const creates = log.filter((l) => l === "POST /v1/workspaces").length;
    const asks = log.filter((l) => l.endsWith("/questions")).length;
    fail = false;
    const r = await call(alice, "POST", `/v1/agent/tasks/${id}/retry`);
    expect(r.statusCode).toBe(200);
    const t2 = await settle(id, ["completed", "failed"]);
    expect(t2.state).toBe("completed");
    expect(log.filter((l) => l === "POST /v1/workspaces").length).toBe(creates);
    expect(log.filter((l) => l.endsWith("/questions")).length).toBe(asks);
    // retry only for a failed task
    expect((await call(alice, "POST", `/v1/agent/tasks/${id}/retry`)).statusCode).toBe(409);
    stub = null;
  });

  it("a route that does not exist yet is an honest failed step", async () => {
    stub = null;
    const ws = (
      await call(alice, "POST", "/v1/workspaces", {
        objective: "x",
        networkScope: "fixture-only",
        idempotencyKey: "agent-test-404",
      })
    ).json<any>().workspaceId;
    const id = await propose([S("workspace.use", { workspaceId: ws }), S("report.build")], undefined, null);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["failed", "completed"]);
    // either the report route exists (completed) or the failure carries the API's reason code
    if (t.state === "failed") expect(t.steps[1].error.reasonCode).toBeTruthy();
    expect(t.steps[0].state).toBe("done");
  });

  it("allows one active task per user (409 TASK_ALREADY_RUNNING) and cancel frees it and cancels the run", async () => {
    const log: string[] = [];
    stub = stubWith(
      [
        questionStub,
        (p) =>
          is("GET", new RegExp(`^/v1/runs/${runId}$`))(p)
            ? { status: 200, body: run({ state: "APPROVAL_NEEDED" }) }
            : null,
        (p) =>
          is("GET", new RegExp(`/v1/runs/${runId}/approvals$`))(p)
            ? {
                status: 200,
                body: {
                  runId,
                  approvals: [
                    {
                      approvalId: "3",
                      actionHash: "h",
                      status: "pending",
                      kind: "plugin.enable",
                      costLimit: null,
                    },
                  ],
                },
              }
            : null,
        (p) => (is("POST", new RegExp(`/v1/runs/${runId}/cancel$`))(p) ? { status: 202, body: {} } : null),
      ],
      log,
    );
    const a = await propose(investigate().slice(0, 3));
    const b = await propose([S("report.build", { workspaceId: crypto.randomUUID() })]);
    await call(alice, "POST", `/v1/agent/tasks/${a}/start`, { consent: [] });
    await settle(a, ["waiting_user"]);
    const second = await call(alice, "POST", `/v1/agent/tasks/${b}/start`, { consent: [] });
    expect(second.statusCode).toBe(409);
    expect(second.json<any>().reasonCode).toBe("TASK_ALREADY_RUNNING");
    const c = await call(alice, "POST", `/v1/agent/tasks/${a}/cancel`);
    expect(c.statusCode).toBe(200);
    expect(c.json<any>().state).toBe("cancelled");
    expect(c.json<any>().steps[2].state).toBe("skipped");
    expect(log).toContain(`POST /v1/runs/${runId}/cancel`);
    expect((await call(alice, "POST", `/v1/agent/tasks/${a}/cancel`)).statusCode).toBe(409);
    // the user's slot is free again
    stub = stubWith([
      (p) =>
        is("GET", /\/report$/)(p)
          ? { status: 404, body: { reasonCode: "WORKSPACE_NOT_FOUND", message: "nf" } }
          : null,
    ]);
    expect((await call(alice, "POST", `/v1/agent/tasks/${b}/start`, { consent: [] })).statusCode).toBe(200);
    await svc.idle();
    stub = null;
  });

  it("records the credits charged for a proof (ledger entries, tx link) per step and in the costs endpoint", async () => {
    let polls = 0;
    const proofId = "22222222-2222-4222-8222-222222222222";
    stub = stubWith([
      (p) =>
        is("POST", /\/capsules\/cap-1\/proofs$/)(p)
          ? { status: 202, body: { proofId, state: "running" } }
          : null,
      (p) =>
        is("GET", new RegExp(`/v1/proofs/${proofId}$`))(p)
          ? {
              status: 200,
              body:
                polls++ < 1
                  ? { proofId, state: "running", cost: { heldUsd: "0.003150" } }
                  : {
                      proofId,
                      state: "verified",
                      job: { txHash: "TX1", explorerUrl: "https://testnet.nearblocks.io/txns/TX1" },
                      cost: { heldUsd: "0.003150", chargedUsd: "0.001750", totalUsd: "0.001750" },
                    },
            }
          : null,
      (p) =>
        is("GET", /^\/v1\/credits$/)(p)
          ? {
              status: 200,
              body: {
                entries: [
                  {
                    id: "e1",
                    kind: "charge",
                    category: "outlayer",
                    amountUsd: "0.001750",
                    refKind: "proof",
                    refId: proofId,
                    detail: {
                      txHash: "TX1",
                      chargedYocto: "400000000000000000000",
                      tokensBurntYocto: "100000000000000000000",
                      nearUsdRate: "3.5",
                      rateDate: "2026-11-13",
                    },
                  },
                  {
                    id: "e0",
                    kind: "hold",
                    category: "outlayer",
                    amountUsd: "0.003150",
                    refKind: "proof",
                    refId: proofId,
                    detail: {},
                  },
                ],
              },
            }
          : null,
    ]);
    const tid = await newThread();
    const id = await svc.createTask(aliceU, tid, null, "Prove", [S("capsule.prove", { capsuleId: "cap-1" })]);
    const bad = await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: ["publish_public"] });
    expect(bad.statusCode).toBe(422);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: ["spend_credits"] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(t.steps[0].cost.creditsUsd).toBe("0.001750");
    expect(t.steps[0].cost.modelUsd).toBe("0.000000");
    expect(t.steps[0].cost.entries).toEqual([
      expect.objectContaining({
        unit: "usd",
        amount: "0.001750",
        txHash: "TX1",
        detail: expect.objectContaining({
          chargedNear: "0.0004",
          gasNear: "0.0001",
          nearUsdRate: "3.5",
          rateDate: "2026-11-13",
        }),
      }),
    ]);
    expect(t.cost).toMatchObject({
      creditsUsd: "0.001750",
      creditsHeldUsd: "0.000000",
      modelUsd: "0.000000",
    });
    expect(t.links.proofId).toBe(proofId);
    const costs = (await call(alice, "GET", `/v1/agent/costs?threadId=${tid}`)).json<any>();
    expect(costs.totals).toMatchObject({
      modelUsd: "0.000000",
      onChainUsd: "0.001750",
      totalUsd: "0.001750",
    });
    expect(costs.items[0]).toMatchObject({
      taskId: id,
      stepIdx: 0,
      stepKey: "capsule.prove",
      unit: "usd",
      category: "onchain",
      amount: "0.001750",
      txHash: "TX1",
    });
    stub = null;
  });
});

describe("startup recovery", () => {
  it("fails the running step with INTERRUPTED (retryable) and the pending reply, and leaves waiting tasks alone", async () => {
    stub = null;
    const tid = await newThread();
    const running = await svc.createTask(aliceU, tid, null, "Interrupted", [
      S("report.build", { workspaceId: crypto.randomUUID() }),
    ]);
    await f.db.admin.query("UPDATE agent_tasks SET state='running' WHERE id=$1", [running]);
    await f.db.admin.query("UPDATE agent_task_steps SET state='running', started_at=now() WHERE task_id=$1", [
      running,
    ]);
    const pend = await svc.store.addMessage(aliceU, {
      threadId: tid,
      role: "assistant",
      state: "pending",
      kind: "text",
    });
    const r = await svc.executor.recover();
    expect(r.tasks).toBeGreaterThanOrEqual(1);
    const t = await taskOf(running);
    expect(t.state).toBe("failed");
    expect(t.steps[0]).toMatchObject({
      state: "failed",
      error: { reasonCode: "INTERRUPTED", retryable: true },
    });
    const m = await svc.store.getMessage(aliceU, pend.id);
    expect(m).toMatchObject({ state: "failed", error: { reasonCode: "INTERRUPTED" } });
  });
});

describe("USD credits in the agent", () => {
  let tok: string;
  let user: AgentUser;
  const credits = async () => (await call(tok, "GET", "/v1/credits")).json<any>();
  beforeAll(async () => {
    const o = await seedOrg(f.db.admin, "ag-credits", { dina: "owner" });
    tok = await login(f.app, o.users.dina!.subject);
    user = { userId: o.users.dina!.userId, orgId: o.orgId };
  });

  it("charges the planner's actual spend to the user once per reply, as a model entry keyed by the reply", async () => {
    stub = null;
    plan = out({ route: "text", text: "Nothing to do." });
    const tid = await newThread(tok);
    const r = await call(tok, "POST", `/v1/agent/threads/${tid}/messages`, { text: "hello there" });
    const { reply } = r.json<any>();
    await svc.idle();
    const c = await credits();
    const e = c.entries.find((x: any) => x.refKind === "agent_message");
    expect(e).toMatchObject({ kind: "charge", category: "model", refId: reply.id, amountUsd: "0.002100" });
    expect(c.byCategory.modelUsd).toBe("0.002100");
    expect(c.spentUsd).toBe("0.002100");
  });

  it("with no credits left the reply fails with CREDITS_EXHAUSTED (and its details) and the model is never called", async () => {
    const { UsdCreditsService } = await import("@nearesis/kernel");
    const k = new UsdCreditsService(f.db.app);
    const left = await k.account(user);
    await k.charge(user, left.availableMicro, { refKind: "run", refId: "drain", category: "model" });
    plan = out({ route: "text", text: "should not be produced" });
    const tid = await newThread(tok);
    const r = await call(tok, "POST", `/v1/agent/threads/${tid}/messages`, { text: "hello again" });
    await svc.idle();
    const th = (await call(tok, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    const m = th.messages.find((x: any) => x.id === r.json<any>().reply.id);
    expect(m).toMatchObject({
      state: "failed",
      kind: "notice",
      error: {
        reasonCode: "CREDITS_EXHAUSTED",
        message: "You have used your credits. Write to connect@kaushikh.xyz to request more access.",
        details: {
          allowanceUsd: "3.000000",
          availableUsd: "0.000000",
          requiredUsd: null,
          contactEmail: "connect@kaushikh.xyz",
        },
      },
      cost: { modelUsd: "0.000000", modelCalls: 0 },
    });
  });

  it("an agent step refused for credits fails with CREDITS_EXHAUSTED, not retryable, with the same details", async () => {
    stub = null;
    const tid = await newThread(tok);
    const id = await svc.createTask(user, tid, null, "Investigate", [
      S("workspace.create", { objective: "Why did swaps fall?" }),
      S("question.ask"),
    ]);
    expect((await call(tok, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] })).statusCode).toBe(200);
    const t = await waitFor(async () => {
      const x = (await call(tok, "GET", `/v1/agent/tasks/${id}`)).json<any>();
      return ["failed", "completed"].includes(x.state) ? x : null;
    });
    expect(t.state).toBe("failed");
    expect(t.steps[0].state).toBe("done");
    expect(t.steps[1]).toMatchObject({
      state: "failed",
      error: {
        reasonCode: "CREDITS_EXHAUSTED",
        retryable: false,
        details: {
          allowanceUsd: "3.000000",
          spentUsd: "3.000000",
          availableUsd: "0.000000",
          requiredUsd: null,
          contactEmail: "connect@kaushikh.xyz",
        },
      },
    });
  });
});

// ---------------------------------------------------------------- user theses (agent integration)
describe("thesis steps: plan rules", () => {
  const P = (key: string, params: Record<string, unknown> = {}): PlannedStep => validateStep(key, params);
  it("thesis.build needs a workspace with a finished run or an earlier run step; publish and compare need a thesis", () => {
    expect(() => validateOrder([P("thesis.build")], {})).toThrow(/needs a workspace/);
    expect(() => validateOrder([P("workspace.create", { objective: "o" }), P("thesis.build")], {})).toThrow(
      /finished run/,
    );
    expect(() => validateOrder([P("thesis.build")], { workspaceId: crypto.randomUUID() })).not.toThrow();
    expect(() =>
      validateOrder(
        [P("workspace.create", { objective: "o" }), P("question.ask"), P("run.await"), P("thesis.build")],
        {},
      ),
    ).not.toThrow();
    expect(() => validateOrder([P("thesis.publish")], {})).toThrow(/needs a thesis/);
    expect(() => validateOrder([P("thesis.compare", { against: "t-1" })], {})).toThrow(/needs a thesis/);
    expect(() => validateOrder([P("thesis.publish", { thesisId: "t-1" })], {})).not.toThrow();
    expect(() => validateOrder([P("thesis.build"), P("thesis.publish")], { workspaceId: "w" })).not.toThrow();
    expect(() => validateStep("thesis.compare", {})).toThrow();
  });
  it("capsule.build is inserted before thesis.build server-side only when the plan has none", () => {
    const ws = crypto.randomUUID();
    const d = interpret(
      out({ steps: [step("workspace.use", { workspaceId: ws }), step("thesis.build")] }),
      {},
    );
    expect(d.kind === "plan" && d.steps.map((s) => s.key)).toEqual([
      "workspace.use",
      "capsule.build",
      "thesis.build",
    ]);
    const full = interpret(
      out({
        steps: [
          step("workspace.use", { workspaceId: ws }),
          step("capsule.build"),
          step("capsule.prove"),
          step("thesis.build"),
        ],
      }),
      {},
    );
    expect(full.kind === "plan" && full.steps.map((s) => s.key)).toEqual([
      "workspace.use",
      "capsule.build",
      "capsule.prove",
      "thesis.build",
    ]);
    // a capsule already in context counts
    const ctx = interpret(out({ steps: [step("thesis.build")] }), { workspaceId: ws, capsuleId: "cap" });
    expect(ctx.kind === "plan" && ctx.steps.map((s) => s.key)).toEqual(["thesis.build"]);
    // the run named on thesis.build is passed on to the inserted capsule step
    const run = crypto.randomUUID();
    const named = interpret(out({ steps: [step("thesis.build", { runId: run })] }), { workspaceId: ws });
    expect(named.kind === "plan" && named.steps[0]).toMatchObject({
      key: "capsule.build",
      params: { runId: run },
    });
  });
  it("thesis.publish needs publish_public and nothing else", () => {
    const c = consentFor([P("thesis.publish", { thesisId: "t-1" })], "1");
    expect(c.map((x) => x.key)).toEqual(["publish_public"]);
    expect(c[0]!.detail).toMatch(/thesis/);
    expect(c[0]!.detail).not.toMatch(/capsule/);
    expect(consentFor([P("thesis.build", { runId: crypto.randomUUID() })], "1")).toEqual([]);
  });
});

describe("every report is a thesis", () => {
  it("an investigation plan without a thesis gets capsule.build and thesis.build at its end; report.build stays available", () => {
    const d = interpret(
      out({ steps: [step("workspace.create", { objective: "o" }), step("question.ask"), step("run.await")] }),
      {},
    );
    expect(d.kind).toBe("plan");
    if (d.kind === "plan")
      expect(d.steps.map((s) => s.key)).toEqual([
        "workspace.create",
        "question.ask",
        "run.await",
        "capsule.build",
        "thesis.build",
      ]);
    expect(CATALOG_DOC["report.build"]).toMatch(/^Workspace summary \(older format\)/);
    expect(titleOf(S("report.build"))).toBe("Workspace summary (older format)");
    expect(titleOf(S("thesis.build"))).toBe("Build the thesis");
    const [investigate, fullFlow] = PLAYBOOKS.split("\n");
    expect(investigate).toMatch(/capsule\.build, thesis\.build/);
    expect(fullFlow).toMatch(
      /capsule\.build, capsule\.prove \(only when asked.*thesis\.build, thesis\.publish \(only when asked/,
    );
    expect(`${investigate}${fullFlow}`).not.toMatch(/report\.build/);
  });
  it("the planner prompt says every report is a thesis that tests the asked relationship, and routes challenges", () => {
    expect(AGENT_PLANNER_SYSTEM).toMatch(/Every report is a thesis/);
    expect(AGENT_PLANNER_SYSTEM).toMatch(/tests the relationship the user asked about/);
    expect(AGENT_PLANNER_SYSTEM).toMatch(/literally asks for the old workspace summary PDF/);
    expect(AGENT_PLANNER_SYSTEM).toMatch(/workspace\.use then thesis\.challenge/);
  });
  it("thesis.challenge takes the thesis from context or the workspace's newest, and refuses a plan with neither", () => {
    expect(() => validateOrder([S("thesis.challenge")], {})).toThrow();
    expect(() =>
      validateOrder([S("workspace.use", { workspaceId: crypto.randomUUID() }), S("thesis.challenge")], {}),
    ).not.toThrow();
    expect(consentFor([S("thesis.challenge")], "1")).toEqual([]);
  });
});

describe("thesis steps: executor", () => {
  const thesisId = "thesis-aaa";
  let wsId = "";
  beforeAll(async () => {
    wsId = (
      await call(alice, "POST", "/v1/workspaces", {
        objective: "Do swaps lead usage?",
        networkScope: "fixture-only",
        idempotencyKey: "agent-test-thesis",
      })
    ).json<any>().workspaceId;
  });
  const run0 = "44444444-4444-4444-8444-444444444444";
  const runsStub: Handler = (p) =>
    is("GET", new RegExp(`^/v1/workspaces/${wsId}/runs$`))(p)
      ? { status: 200, body: { runs: [{ runId: run0, state: "COMPLETE" }] } }
      : null;
  const capsuleStub: Handler = (p) =>
    is("POST", /\/capsules$/)(p) ? { status: 201, body: { capsuleId: "cap-9", title: "T" } } : null;

  it("build, publish and compare call the thesis routes with the contract shapes and expose their ids and links", async () => {
    const log: string[] = [];
    const bodies: Record<string, unknown> = {};
    stub = stubWith(
      [
        runsStub,
        capsuleStub,
        (p) => {
          bodies[`${p.method} ${p.url}`] = p.body;
          return null;
        },
        (p) =>
          is("POST", new RegExp(`/v1/workspaces/${wsId}/theses$`))(p)
            ? {
                status: 201,
                body: {
                  thesisId,
                  version: "v-1",
                  status: "draft",
                  verdict: { status: "MIXED", headline: "Same-day link is weak" },
                },
              }
            : null,
        (p) =>
          is("POST", new RegExp(`/v1/theses/${thesisId}/publish$`))(p)
            ? { status: 200, body: { shareSlug: "abc123", publicUrlPath: "/t/abc123" } }
            : null,
        (p) =>
          is("POST", new RegExp(`/v1/theses/${thesisId}/compare$`))(p)
            ? {
                status: 200,
                body: {
                  outcome: "drift",
                  rows: [
                    { what: "n", original: 90, reproduced: 91, delta: 1 },
                    { what: "verdict", original: "MIXED", reproduced: "MIXED", delta: null },
                  ],
                },
              }
            : null,
      ],
      log,
    );
    const id = await propose(
      [
        S("workspace.use", { workspaceId: wsId }),
        S("capsule.build"),
        S("thesis.build"),
        S("thesis.publish"),
        S("thesis.compare", { against: "thesis-orig" }),
      ],
      undefined,
      null,
    );
    const task0 = await taskOf(id);
    expect(task0.consent.required.map((c: any) => c.key)).toEqual(["publish_public"]);
    expect((await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] })).statusCode).toBe(422);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: ["publish_public"] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(bodies[`POST /v1/workspaces/${wsId}/theses`]).toEqual({});
    expect(bodies[`POST /v1/theses/${thesisId}/compare`]).toEqual({ against: "thesis-orig" });
    expect(t.steps[2].result).toMatchObject({
      summary: expect.stringMatching(/^The thesis is ready\. Verdict MIXED/),
      items: [
        { label: "Thesis", value: thesisId, href: `/thesis/${thesisId}` },
        { label: "PDF", value: "Download the thesis PDF", href: `/api/thesis/${thesisId}/pdf` },
        { label: "Verdict", value: "MIXED: Same-day link is weak", href: null },
        { label: "Version", value: "v-1", href: null },
      ],
      refs: { thesisId, workspaceId: wsId },
    });
    expect(t.steps[3].result.items[0]).toEqual({
      label: "Public page",
      value: "/t/abc123",
      href: "/t/abc123",
    });
    expect(t.steps[3].result.refs.thesisId).toBe(thesisId);
    expect(t.steps[4].result.summary).toContain("drift");
    expect(t.steps[4].result.items).toEqual([
      { label: "n", value: "original 90; reproduced 91; delta 1", href: null },
      { label: "verdict", value: "original MIXED; reproduced MIXED", href: null },
    ]);
    expect(t.links.thesisId).toBe(thesisId);
    expect(log).toContain(`POST /v1/theses/${thesisId}/publish`);
    stub = null;
  });

  it("INVALID_TEST is a completed step with a clear summary, not a failed one; the finished task message leads with the thesis", async () => {
    stub = stubWith([
      runsStub,
      capsuleStub,
      (p) =>
        is("POST", new RegExp(`/v1/workspaces/${wsId}/theses$`))(p)
          ? {
              status: 201,
              body: {
                thesisId,
                version: "v-2",
                status: "draft",
                verdict: { status: "INVALID_TEST", headline: "The series are mechanically related" },
              },
            }
          : null,
    ]);
    const id = await propose(
      [S("workspace.use", { workspaceId: wsId }), S("capsule.build"), S("thesis.build")],
      undefined,
      null,
    );
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(t.steps[2].state).toBe("done");
    expect(t.steps[2].result.summary).toMatch(/^The thesis is ready\. Verdict INVALID_TEST/);
    expect(t.steps[2].result.summary).toMatch(/mechanically related/);
    expect(t.steps[2].title).toBe("Build the thesis");
    stub = null;
  });

  it("a run that cannot become a capsule ends the task completed, and the thesis step says why there is no thesis", async () => {
    stub = stubWith([
      runsStub,
      (p) =>
        is("POST", /\/capsules$/)(p)
          ? {
              status: 422,
              body: {
                reasonCode: "RUN_NOT_CAPSULABLE",
                message: "The run has fewer than two daily numeric series in its panels (found 1).",
                retryable: false,
              },
            }
          : null,
    ]);
    const id = await propose(
      [S("workspace.use", { workspaceId: wsId }), S("capsule.build"), S("thesis.build")],
      undefined,
      null,
    );
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(t.steps[1].state).toBe("done");
    expect(t.steps[2].state).toBe("done");
    expect(t.steps[2].result.summary).toMatch(
      /There is no thesis for this run: .*fewer than two daily numeric series/,
    );
    expect(t.steps[2].result.summary).toMatch(/two daily series over the same days/);
    expect(t.links.thesisId).toBeNull();
    stub = null;
  });

  it("thesis.build passes the test plan the setup step drafted, as ids only", async () => {
    const bodies: any[] = [];
    stub = stubWith([
      runsStub,
      (p) =>
        is("POST", /\/assistant\/setup$/)(p)
          ? {
              status: 200,
              body: {
                markers: [],
                monitors: [],
                skipped: [],
                cost: { usd: 0, modelCalls: 0 },
                hypothesis: {
                  id: "5c9d5f90-4709-4c0c-8709-d9b671c1e1e4",
                  title: "Days with higher swaps have higher refund rate.",
                  testPlan: {
                    x: { panel: "a".repeat(64), panelTitle: "P", column: "swaps", label: "P: swaps" },
                    y: {
                      panel: "a".repeat(64),
                      panelTitle: "P",
                      column: "refundRate",
                      label: "P: refundRate",
                    },
                    relation: "moves_with",
                    lagDays: 0,
                    expectedSign: "positive",
                    statement: "Days with higher swaps have higher refund rate.",
                    chosenBy: "rule",
                    why: "w",
                  },
                },
              },
            }
          : null,
      (p) =>
        is("POST", /\/theses$/)(p)
          ? (bodies.push(p.body),
            {
              status: 201,
              body: {
                thesisId,
                version: "v",
                status: "draft",
                verdict: { status: "SUPPORTED", headline: "h" },
              },
            })
          : null,
    ]);
    const id = await propose(
      [
        S("workspace.use", { workspaceId: wsId }),
        S("setup.auto", { runId: run0 }),
        S("thesis.build", { runId: run0 }),
      ],
      undefined,
      null,
    );
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    expect((await settle(id, ["completed", "failed"])).state).toBe("completed");
    expect(bodies).toEqual([
      {
        runId: run0,
        test: {
          x: { panelHash: "a".repeat(64), column: "swaps" },
          y: { panelHash: "a".repeat(64), column: "refundRate" },
          lagDays: 0,
          expectedSign: "positive",
          chosenBy: "rule",
        },
      },
    ]);
    stub = null;
  });

  it("thesis.challenge needs no consent, posts with no body, and reports the outcome in plain words with the kept notes", async () => {
    const bodies: unknown[] = [];
    stub = stubWith([
      (p) =>
        is("POST", new RegExp(`/v1/theses/${thesisId}/challenge$`))(p)
          ? (bodies.push(p.body),
            {
              status: 200,
              body: {
                challengeId: "c1",
                outcome: "weakened",
                notes: [{ text: "The pair may share a trend.", group: "alternative", severity: "material" }],
                droppedNotes: 0,
              },
            })
          : null,
    ]);
    const id = await propose([S("thesis.challenge", { thesisId })], undefined, null);
    expect((await taskOf(id)).consent.required).toEqual([]);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("completed");
    expect(bodies).toEqual([undefined]);
    expect(t.steps[0].result.summary).toBe("The thesis is weakened by the challenge.");
    expect(t.steps[0].result.items).toEqual([
      { label: "Thesis", value: thesisId, href: `/thesis/${thesisId}` },
      { label: "alternative (material)", value: "The pair may share a trend.", href: null },
    ]);
    stub = null;
  });

  it("a challenge refused for credits is a non-retryable failed step", async () => {
    stub = stubWith([
      (p) =>
        is("POST", new RegExp(`/v1/theses/${thesisId}/challenge$`))(p)
          ? {
              status: 402,
              body: { reasonCode: "CREDITS_EXHAUSTED", message: "No credits left.", retryable: false },
            }
          : null,
    ]);
    const id = await propose([S("thesis.challenge", { thesisId })], undefined, null);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("failed");
    expect(t.steps[0]).toMatchObject({
      state: "failed",
      error: { reasonCode: "CREDITS_EXHAUSTED", retryable: false },
    });
    stub = null;
  });

  it("with a run named, thesis.build sends it; with none and no context the route chooses the newest run", async () => {
    const bodies: unknown[] = [];
    stub = stubWith([
      (p) =>
        is("POST", /\/theses$/)(p)
          ? (bodies.push(p.body),
            { status: 201, body: { thesisId, version: "v", status: "draft", verdict: null } })
          : null,
    ]);
    const id = await propose(
      [S("workspace.use", { workspaceId: wsId }), S("thesis.build", { runId: run0 })],
      undefined,
      null,
    );
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    expect((await settle(id, ["completed", "failed"])).state).toBe("completed");
    expect(bodies).toEqual([{ runId: run0 }]);
    stub = null;
  });

  it("fails honestly with the API's reason code when the thesis route answers 404", async () => {
    stub = stubWith([
      (p) =>
        is("POST", /\/theses$/)(p)
          ? { status: 404, body: { reasonCode: "NOT_FOUND", message: "No such route.", retryable: false } }
          : null,
    ]);
    const id = await propose([S("workspace.use", { workspaceId: wsId }), S("thesis.build")], undefined, null);
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["completed", "failed"]);
    expect(t.state).toBe("failed");
    expect(t.steps[0].state).toBe("done");
    expect(t.steps[1]).toMatchObject({ state: "failed", error: { reasonCode: "NOT_FOUND" } });
    expect(t.links.thesisId).toBeNull();
    stub = null;
  });

  it("a plan with thesis.publish and a thesis id from the planner is a proposed task that asks for publish_public", async () => {
    stub = null;
    plan = out({ title: "Share it", steps: [step("thesis.publish", { thesisId: "thesis-xyz" })] });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "publish my thesis thesis-xyz" });
    await svc.idle();
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    expect(th.tasks[0].consent.required.map((c: any) => c.key)).toEqual(["publish_public"]);
    expect(th.tasks[0].steps.map((s: any) => s.key)).toEqual(["thesis.publish"]);
  });
});

describe("POST /v1/theses/:id/reproduce", () => {
  const origWs = "55555555-5555-4555-8555-555555555555";
  const origRun = "66666666-6666-4666-8666-666666666666";
  const docOf = (extra: Record<string, unknown> = {}) => ({
    thesis: {
      id: "thesis-orig",
      title: "Swaps vs usage",
      kind: "workspace",
      hypothesis: "Swaps lead usage.",
    },
    doc: {
      hypothesis: "Swaps lead usage.",
      origin: { kind: "workspace", workspaceId: origWs, runId: origRun, ...extra },
    },
    receipts: [],
  });
  /** Visible to alice only; the original run list is visible to alice only. */
  const visible =
    (extraOrigin: Record<string, unknown> = {}): AgentApi =>
    async (u, method, url) => {
      const mine = u.userId === aliceU.userId;
      if (method === "GET" && url === "/v1/theses/thesis-orig")
        return mine
          ? { status: 200, body: docOf(extraOrigin) }
          : { status: 404, body: { reasonCode: "NOT_FOUND", message: "nf" } };
      if (method === "GET" && url === "/v1/theses/reference-near-intents")
        return {
          status: 200,
          body: {
            thesis: {
              id: "reference-near-intents",
              title: "NEAR Intents",
              kind: "reference",
              hypothesis: "H",
            },
            doc: {
              hypothesis: "H",
              origin: { kind: "reference" },
              reproduce: { command: "pnpm thesis:build", check: "pnpm thesis:verify" },
            },
            receipts: [],
          },
        };
      if (method === "GET" && url === `/v1/workspaces/${origWs}/runs`)
        return mine
          ? {
              status: 200,
              body: { runs: [{ runId: origRun, questionSummary: "Do swaps lead usage on NEAR?" }] },
            }
          : { status: 404, body: { reasonCode: "NOT_FOUND", message: "nf" } };
      return real(u, method, url);
    };

  it("creates a thread and a proposed task with the six steps; nothing runs", async () => {
    stub = visible();
    const r = await call(alice, "POST", "/v1/theses/thesis-orig/reproduce");
    expect(r.statusCode).toBe(201);
    const { threadId, taskId } = r.json<any>();
    const th = (await call(alice, "GET", `/v1/agent/threads/${threadId}`)).json<any>();
    expect(th.thread.title).toBe("Reproduce: Swaps vs usage");
    expect(th.tasks).toHaveLength(1);
    const t = await taskOf(taskId);
    expect(t.state).toBe("proposed");
    expect(t.steps.map((s: any) => s.key)).toEqual([
      "workspace.create",
      "question.ask",
      "run.await",
      "capsule.build",
      "thesis.build",
      "thesis.compare",
    ]);
    expect(t.steps.every((s: any) => s.state === "pending")).toBe(true);
    expect(t.steps[0].detail).toContain("Reproduction of: Swaps lead usage.");
    expect(t.steps[1].detail).toContain("Do swaps lead usage on NEAR?");
    expect(t.steps[5].detail).toContain("thesis-orig");
    expect(t.estimate.modelUsdMax).toBe("3.000000");
    expect(t.consent.required).toEqual([]);
    const cost = await call(alice, "GET", `/v1/agent/costs?threadId=${threadId}`);
    expect(cost.json<any>().items).toEqual([]);
    stub = null;
  });

  it("uses the question carried by the document when it has one", async () => {
    stub = visible({ question: "Carried question?" });
    const r = await call(alice, "POST", "/v1/theses/thesis-orig/reproduce");
    const t = await taskOf(r.json<any>().taskId);
    expect(t.steps[1].detail).toContain("Carried question?");
    stub = null;
  });

  it("falls back to the hypothesis and says so when the original run is not readable", async () => {
    stub = async (u, method, url) =>
      method === "GET" && url === `/v1/workspaces/${origWs}/runs`
        ? { status: 404, body: { reasonCode: "NOT_FOUND", message: "nf" } }
        : visible()(u, method, url);
    const r = await call(alice, "POST", "/v1/theses/thesis-orig/reproduce");
    expect(r.statusCode).toBe(201);
    const t = await taskOf(r.json<any>().taskId);
    expect(t.steps[1].detail).toContain("hypothesis is used as the question");
    stub = null;
  });

  it("refuses the reference thesis with 422 REFERENCE_THESIS_OFFLINE and the offline commands", async () => {
    stub = visible();
    const r = await call(alice, "POST", "/v1/theses/reference-near-intents/reproduce");
    expect(r.statusCode).toBe(422);
    const b = r.json<any>();
    expect(b.reasonCode).toBe("REFERENCE_THESIS_OFFLINE");
    expect(b.details.commands).toEqual(["pnpm thesis:build", "pnpm thesis:verify", "pnpm thesis:data"]);
    expect(
      (await call(alice, "GET", "/v1/agent/threads"))
        .json<any>()
        .items.some((x: any) => x.title.startsWith("Reproduce: NEAR")),
    ).toBe(false);
    stub = null;
  });

  it("is 404 for a thesis the caller cannot see, creates nothing for them, and needs a session", async () => {
    stub = visible();
    const before = (await call(bob, "GET", "/v1/agent/threads")).json<any>().items.length;
    const r = await call(bob, "POST", "/v1/theses/thesis-orig/reproduce");
    expect(r.statusCode).toBe(404);
    expect(r.json<any>().reasonCode).toBe("THESIS_NOT_FOUND");
    expect((await call(bob, "GET", "/v1/agent/threads")).json<any>().items.length).toBe(before);
    expect((await call(alice, "POST", "/v1/theses/bad%20id/reproduce")).statusCode).toBe(404);
    const anon = await f.app.inject({ method: "POST", url: "/v1/theses/thesis-orig/reproduce" });
    expect(anon.statusCode).toBe(401);
    stub = null;
  });
});
