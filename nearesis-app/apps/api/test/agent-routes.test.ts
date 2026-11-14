/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError } from "@nearesis/kernel";
import type { AssistantModelPort } from "@nearesis/workflow";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { injectApi } from "../src/agent/api-client.ts";
import type { AgentApi, AgentUser } from "../src/agent/api-client.ts";
import { consentFor, validateOrder, validateStep } from "../src/agent/catalog.ts";
import type { PlannedStep } from "../src/agent/catalog.ts";
import { PlannerOutput, interpret } from "../src/agent/planner.ts";
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
    const c = consentFor([P("capsule.prove", { capsuleId: "cap" })], "5000");
    expect(c).toEqual([expect.objectContaining({ key: "spend_credits", maxYocto: "5000" })]);
  });
  it("prove with an unknown estimate still needs consent, with a null max", () => {
    expect(consentFor([P("capsule.prove", { capsuleId: "cap" })], null)[0]).toMatchObject({
      key: "spend_credits",
      maxYocto: null,
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
    expect(costs.totals).toMatchObject({ modelUsd: "0.002100", modelCalls: 1, creditsChargedYocto: "0" });
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
    expect(task.steps).toHaveLength(5);
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
      creditsChargedYocto: "0",
      creditsHeldYocto: "0",
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
                  ? { proofId, state: "running", cost: { heldYocto: "900" } }
                  : {
                      proofId,
                      state: "verified",
                      job: { txHash: "TX1", explorerUrl: "https://testnet.nearblocks.io/txns/TX1" },
                      cost: { heldYocto: "900", chargedYocto: "400", gasYocto: "100", totalYocto: "500" },
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
                    amountYocto: "500",
                    refKind: "proof",
                    refId: proofId,
                    detail: { txHash: "TX1", chargedYocto: "400", tokensBurntYocto: "100" },
                  },
                  {
                    id: "e0",
                    kind: "hold",
                    amountYocto: "900",
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
    expect(t.steps[0].cost.creditsYocto).toBe("500");
    expect(t.steps[0].cost.entries).toEqual([
      expect.objectContaining({ unit: "yoctoNEAR", amount: "500", txHash: "TX1" }),
    ]);
    expect(t.cost).toMatchObject({ creditsChargedYocto: "500", creditsHeldYocto: "0" });
    expect(t.links.proofId).toBe(proofId);
    const costs = (await call(alice, "GET", `/v1/agent/costs?threadId=${tid}`)).json<any>();
    expect(costs.totals.creditsChargedYocto).toBe("500");
    expect(costs.items[0]).toMatchObject({
      taskId: id,
      stepIdx: 0,
      stepKey: "capsule.prove",
      unit: "yoctoNEAR",
      amount: "500",
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
