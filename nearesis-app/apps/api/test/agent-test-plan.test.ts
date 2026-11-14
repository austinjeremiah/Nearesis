/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantModelPort } from "@nearesis/workflow";
import { matchLabel } from "@nearesis/capsule";
import type { Candidate } from "@nearesis/capsule";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { injectApi } from "../src/agent/api-client.ts";
import type { AgentApi, AgentUser } from "../src/agent/api-client.ts";
import { validateStep } from "../src/agent/catalog.ts";
import type { PlannedStep } from "../src/agent/catalog.ts";
import { PlannerOutput, interpret } from "../src/agent/planner.ts";
import type { AgentService } from "../src/agent/service.ts";
import {
  FALLBACK_WHY,
  applyPatch,
  emptyPlan,
  fallbackWhy,
  instructionFor,
  planFromPlanner,
  questionWithPlan,
  sanitizeWhy,
  testPlanSha,
} from "../src/agent/test-plan.ts";
import type { TaskTestPlan } from "../src/agent/test-plan.ts";

// ------------------------------------------------------------------------------------------------------ pure: sanitising
const good = {
  statement: "Days with more swaps have a higher refund rate.",
  xLabel: "daily swaps",
  yLabel: "refund rate",
  relation: "moves_with" as const,
  lagDays: 0,
  expectedSign: "positive" as const,
  windowDays: 90,
  wouldCountAsWrong: "No relation, or a lower refund rate on days with more swaps.",
};

describe("the planner's test plan is sanitised server-side", () => {
  it("keeps a valid plan, unlocked and not edited", () => {
    expect(planFromPlanner(good)).toEqual({ ...good, editedByUser: false, lockedAt: null, sha256: null });
  });
  it("coerces the relation to the lag instead of rejecting the plan", () => {
    expect(planFromPlanner({ ...good, relation: "leads", lagDays: 0 }).relation).toBe("moves_with");
    const lead = planFromPlanner({ ...good, relation: "moves_with", lagDays: 3 });
    expect(lead).toMatchObject({ relation: "leads", lagDays: 3 });
  });
  it.each([
    ["a number in the sentence", { statement: "Days with 5 more swaps have a higher refund rate." }],
    ["a number in a label", { xLabel: "swaps 24h" }],
    ["a number in the wrong-rule", { wouldCountAsWrong: "A correlation below 0.2 counts as wrong." }],
    ["causal wording", { statement: "More swaps cause a higher refund rate." }],
    ["bullish wording", { statement: "A bullish swap count lifts the refund rate." }],
    ["x equal to y", { yLabel: "Daily swaps" }],
    ["x with the same words as y", { yLabel: "swaps (daily)" }],
    [
      "a sentence over 200 characters",
      { statement: `Days with more swaps ${"really ".repeat(30)}have a higher refund rate.` },
    ],
    ["a label over 60 characters", { xLabel: "s".repeat(61) }],
    ["a window out of range", { windowDays: 10 }],
    ["a lag out of range", { lagDays: 31 }],
    ["non-ASCII text", { statement: "Days with more swaps have a higher refund rate — always." }],
  ])("falls back to statement null on %s", (_n, patch) => {
    const p = planFromPlanner({ ...good, ...patch });
    expect(p).toEqual(emptyPlan());
    expect(p.statement).toBeNull();
  });
  it("accepts a number only when it is the lag or the window", () => {
    const p = planFromPlanner({
      ...good,
      relation: "leads",
      lagDays: 3,
      statement: "Swaps lead the refund rate by 3 days over the last 90 days.",
    });
    expect(p.statement).not.toBeNull();
    expect(
      planFromPlanner({ ...good, statement: "Swaps lead the refund rate by 4 days." }).statement,
    ).toBeNull();
  });
  it("an empty statement is no plan", () => {
    expect(planFromPlanner({ ...good, statement: "" })).toEqual(emptyPlan());
    expect(planFromPlanner(null)).toEqual(emptyPlan());
  });
  it("the hash covers the canonical fields only, not the edit flag or the lock time", () => {
    const a = planFromPlanner(good);
    const b = { ...a, editedByUser: true, lockedAt: "2026-11-14T00:00:00.000Z" };
    expect(testPlanSha(a)).toBe(testPlanSha(b));
    expect(testPlanSha(a)).not.toBe(testPlanSha({ ...a, windowDays: 120 }));
    expect(testPlanSha(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a user's edit", () => {
  const base: TaskTestPlan = planFromPlanner(good);
  it("merges fields, sets editedByUser and reports each bad field by name", () => {
    const ok = applyPatch(base, { windowDays: 120, expectedSign: "either" });
    expect(ok).toMatchObject({
      ok: true,
      plan: { windowDays: 120, expectedSign: "either", editedByUser: true },
    });
    const bad = applyPatch(base, { windowDays: 5, statement: "More swaps cause refunds." });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path).sort()).toEqual(["statement", "windowDays"]);
    const same = applyPatch(base, { yLabel: "daily swaps" });
    expect(same.ok).toBe(false);
    if (!same.ok)
      expect(same.issues).toEqual([{ path: "yLabel", issue: "must name a different series than xLabel" }]);
    const rel = applyPatch(base, { relation: "leads" });
    expect(rel.ok).toBe(false);
    if (!rel.ok) expect(rel.issues[0]).toMatchObject({ path: "lagDays" });
    expect(applyPatch(base, { colour: "red" }).ok).toBe(false);
    expect(applyPatch(base, {}).ok).toBe(false);
  });
  it("statement null clears the plan", () => {
    const r = applyPatch(base, { statement: null });
    expect(r).toMatchObject({
      ok: true,
      plan: { statement: null, xLabel: null, yLabel: null, editedByUser: true },
    });
  });
});

describe("the instruction that follows the question", () => {
  it("names both series and the window, and keeps the question within 2000 characters", () => {
    const text = instructionFor({ xLabel: "daily swaps", yLabel: "refund rate", windowDays: 90 });
    expect(text).toContain('"daily swaps" and "refund rate"');
    expect(text).toContain("last 90 days");
    expect(text).toMatch(/chart exactly these two daily series/);
    const q = questionWithPlan("Q".repeat(1990), { xLabel: "a", yLabel: "b", windowDays: 90 });
    expect(q.length).toBeLessThanOrEqual(2000);
    expect(q.startsWith("Q")).toBe(true);
    expect(q.endsWith(text.replace("a daily", "a daily"))).toBe(false);
    expect(
      questionWithPlan("Do swaps follow refunds?", { xLabel: "swaps", yLabel: "refunds", windowDays: 30 }),
    ).toMatch(/^Do swaps follow refunds\?\n\nTest plan for this investigation: chart exactly/);
  });
});

// -------------------------------------------------------------------------------------------------------- pure: why
describe("why this step", () => {
  const params = { objective: "Swaps over 90 days" };
  it("accepts one plain sentence", () => {
    expect(sanitizeWhy("It keeps the work in one place.", params)).toBe("It keeps the work in one place.");
  });
  it("allows numbers that are in the step's own params and no others", () => {
    expect(sanitizeWhy("It looks at the 90 days you asked for.", params)).not.toBeNull();
    expect(sanitizeWhy("It looks at the 91 days you asked for.", params)).toBeNull();
    expect(sanitizeWhy("It looks at 90 days.", {})).toBeNull();
  });
  it.each([
    ["causal wording", "Swaps cause refunds, so this step comes first."],
    ["bullish wording", "This is a bullish step."],
    ["more than 220 characters", "x ".repeat(111)],
    ["empty text", "   "],
    ["non-ASCII text", "It keeps the work together — always."],
  ])("drops %s", (_n, text) => {
    expect(sanitizeWhy(text, params)).toBeNull();
  });
  it("has a fixed fallback for every catalog step key, and a generic one for an unknown key", () => {
    for (const key of [
      "workspace.create",
      "workspace.use",
      "workspace.archive",
      "question.ask",
      "run.await",
      "setup.auto",
      "marker.create",
      "monitor.create",
      "hypothesis.create",
      "hypothesis.freeze",
      "capsule.build",
      "capsule.prove",
      "capsule.publish",
      "report.build",
      "thesis.build",
      "thesis.publish",
      "thesis.compare",
      "thesis.challenge",
    ])
      expect(FALLBACK_WHY[key]!.length, key).toBeLessThanOrEqual(220);
    expect(fallbackWhy("nope.nope")).toMatch(/part of the plan/);
    for (const v of Object.values(FALLBACK_WHY)) expect(v).not.toMatch(/\d/);
  });
});

// ------------------------------------------------------------------------------------------------ pure: planner output
const out = (o: Partial<PlannerOutput>): PlannerOutput => ({
  route: "plan",
  text: "",
  title: "t",
  lookup: "none",
  workspaceId: "",
  steps: [],
  ...o,
});
const step = (key: string, params: unknown = {}, why?: string) => ({
  key,
  params: JSON.stringify(params),
  ...(why !== undefined ? { why } : {}),
});

describe("interpret: test plan and why", () => {
  const investigate = [
    step(
      "workspace.create",
      { objective: "Swaps and refunds" },
      "A workspace keeps the whole investigation together.",
    ),
    step("question.ask", {}, "Swaps cause refunds so it starts here."),
    step("run.await", {}, "It waits for the run, 3 minutes at most."),
  ];
  it("a plan with question.ask carries the sanitised test plan and each step's why (fallback when it fails)", () => {
    const d = interpret(out({ steps: investigate, testPlan: good, followUp: "none" }), {});
    expect(d.kind).toBe("plan");
    if (d.kind !== "plan") return;
    expect(d.testPlan).toMatchObject({
      statement: good.statement,
      editedByUser: false,
      lockedAt: null,
      sha256: null,
    });
    expect(d.steps.map((s) => s.why ?? null)).toEqual([
      "A workspace keeps the whole investigation together.",
      null, // causal wording
      null, // a number that is not in the params
      null, // the capsule step the server added
      null, // the thesis step the server added
    ]);
  });
  it("an invalid test plan keeps statement null and the plan still stands", () => {
    const d = interpret(
      out({ steps: investigate, testPlan: { ...good, statement: "Swaps cause refunds." } }),
      {},
    );
    expect(d.kind).toBe("plan");
    if (d.kind === "plan") expect(d.testPlan).toEqual(emptyPlan());
  });
  it("a plan without question.ask has no test plan", () => {
    const d = interpret(out({ steps: [step("workspace.create", { objective: "o" })], testPlan: good }), {});
    if (d.kind === "plan") expect(d.testPlan).toBeNull();
    else throw new Error("expected a plan");
  });
  it("a model that omits why, testPlan and followUp still parses", () => {
    const r = PlannerOutput.safeParse({
      route: "plan",
      text: "",
      title: "t",
      lookup: "none",
      workspaceId: "",
      steps: [{ key: "workspace.create", params: "{}" }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ followUp: "none", testPlan: { statement: "" } });
  });
  it("follow-up: reuse_plan takes every field from the stored plan, only the window may change; new_plan takes the model's", () => {
    const prev = { ...good, statement: "Days with more swaps have a higher failure rate.", windowDays: 90 };
    const steps = [
      step("workspace.use", { workspaceId: "5c9d5f90-4709-4c0c-8709-d9b671c1e1e4" }),
      step("question.ask", { question: "In this workspace, repeat this over the last 365 days: x" }),
      step("run.await"),
      step("capsule.build"),
      step("thesis.build"),
    ];
    const ambient = { workspaceId: "5c9d5f90-4709-4c0c-8709-d9b671c1e1e4" };
    const reuse = interpret(
      out({
        steps,
        followUp: "reuse_plan",
        testPlan: { ...good, statement: "Something else entirely.", windowDays: 365 },
      }),
      ambient,
      { previousPlan: prev },
    );
    expect(reuse.kind).toBe("plan");
    if (reuse.kind === "plan") {
      expect(reuse.steps.map((s) => s.key)).toEqual([
        "workspace.use",
        "question.ask",
        "run.await",
        "capsule.build",
        "thesis.build",
      ]);
      expect(reuse.testPlan).toMatchObject({
        statement: prev.statement,
        windowDays: 365,
        editedByUser: false,
        lockedAt: null,
      });
    }
    // no window from the model: the stored window stays
    const keep = interpret(out({ steps, followUp: "reuse_plan" }), ambient, { previousPlan: prev });
    if (keep.kind === "plan")
      expect(keep.testPlan).toMatchObject({ statement: prev.statement, windowDays: 90 });
    const changed = interpret(out({ steps, followUp: "new_plan", testPlan: good }), ambient, {
      previousPlan: prev,
    });
    if (changed.kind === "plan") expect(changed.testPlan?.statement).toBe(good.statement);
    // reuse with nothing to reuse: the model's own plan is used
    const none = interpret(out({ steps, followUp: "reuse_plan", testPlan: good }), ambient, {
      previousPlan: null,
    });
    if (none.kind === "plan") expect(none.testPlan?.statement).toBe(good.statement);
  });
});

// ------------------------------------------------------------------------------------------------- pure: label matching
const cand = (panelTitle: string, column: string, panelHash = "a".repeat(64)): Candidate => ({
  panelHash,
  panelTitle,
  column,
  unit: null,
  values: new Map([[1, "1"]]),
});
describe("matching a plain label to a series by name", () => {
  const cs = [
    cand("Swaps", "swaps"),
    cand("Swaps", "swapsWithUnknownUsd"),
    cand("Swaps", "refundRate"),
    cand("Volume", "volumeUsd", "b".repeat(64)),
  ];
  it("an exact match wins over a longer name", () => {
    const m = matchLabel(cs, "daily swaps");
    expect(m.status).toBe("one");
    expect(m.picks[0]!.column).toBe("swaps");
    expect(matchLabel(cs, "refund rate").picks[0]!.column).toBe("refundRate");
    expect(matchLabel(cs, "volume usd").picks[0]!.column).toBe("volumeUsd");
  });
  it("ties are many, nothing found is none, a label with no concept words names nothing", () => {
    expect(matchLabel([cand("A", "swaps"), cand("B", "swaps", "c".repeat(64))], "swaps").status).toBe("many");
    expect(matchLabel(cs, "gas fees")).toEqual({ status: "none", picks: [] });
    expect(matchLabel(cs, "daily count").status).toBe("many");
  });
});

// ------------------------------------------------------------------------------------------------------ app fixture
let f: ApiFixture;
let svc: AgentService;
let real: AgentApi;
let stub: AgentApi | null = null;
let plan: PlannerOutput = out({ route: "text", text: "hello" });
let pick: { xId: string; yId: string; missing: "none" | "x" | "y" } = {
  xId: "c1",
  yId: "c2",
  missing: "none",
};
let resolveCalls = 0;
const prompts: string[] = [];
const makePort = (): AssistantModelPort => {
  let calls = 0;
  return {
    generate: async <T>(a: { key: string; prompt: string; schema: { parse(v: unknown): T } }) => {
      calls++;
      if (a.key.endsWith(":resolve")) {
        resolveCalls++;
        prompts.push(a.prompt);
        return a.schema.parse(pick);
      }
      return a.schema.parse(plan);
    },
    usage: () => ({ usd: 0.0021 * calls, modelCalls: calls }),
  };
};
let alice: string;
let bob: string;
let aliceU: AgentUser;
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
        model: async () => makePort(),
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
  const a = await seedOrg(f.db.admin, "tp", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "tp-b", { bob: "owner" });
  alice = await login(f.app, a.users.alice!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  aliceU = { userId: a.users.alice!.userId, orgId: a.orgId };
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
const S = (key: string, params: Record<string, unknown> = {}) => validateStep(key, params);
type Handler = (p: { method: string; url: string; body: any }) => { status: number; body: unknown } | null;
function stubWith(handlers: Handler[], log: string[] = []): AgentApi {
  return async (u, method, url, body, headers) => {
    log.push(`${method} ${url}`);
    for (const h of handlers) {
      const r = h({ method, url, body });
      if (r) return r;
    }
    return real(u, method, url, body, headers);
  };
}
const is =
  (method: string, re: RegExp): ((p: { method: string; url: string }) => boolean) =>
  (p) =>
    p.method === method && re.test(p.url);
const writtenPlan = (extra: Partial<TaskTestPlan> = {}): TaskTestPlan => ({
  ...planFromPlanner(good),
  ...extra,
});
/** A proposed task through the service, with a test plan. */
const propose = async (steps: PlannedStep[], testPlan: TaskTestPlan | null, title = "Test task") =>
  svc.createTask(aliceU, await newThread(), null, title, steps, {}, testPlan);

// ------------------------------------------------------------------------------------------------------ planning
describe("planning a task with a test plan", () => {
  it("the planner call returns the plan and the whys; the task view carries testPlan and a why on every step", async () => {
    stub = null;
    plan = out({
      title: "Swaps and refunds",
      steps: [
        step(
          "workspace.create",
          { objective: "NEAR Intents reliability" },
          "A workspace keeps the investigation and its thesis together.",
        ),
        step("question.ask", {}, "The investigation reads the data and charts both series."),
        step("run.await"),
      ],
      testPlan: good,
    });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, {
      text: "test swaps against refund rate",
    });
    await svc.idle();
    const th = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
    const task = th.tasks[0];
    expect(task.state).toBe("proposed");
    expect(task.testPlan).toEqual({ ...good, editedByUser: false, lockedAt: null, sha256: null });
    expect(task.steps.map((s: any) => s.key)).toEqual([
      "workspace.create",
      "question.ask",
      "run.await",
      "capsule.build",
      "thesis.build",
    ]);
    expect(task.steps[0].why).toBe("A workspace keeps the investigation and its thesis together.");
    expect(task.steps[1].why).toBe("The investigation reads the data and charts both series.");
    // no why from the model, and the steps the server added: the fixed sentence of the step key
    expect(task.steps[2].why).toBe(fallbackWhy("run.await"));
    expect(task.steps[3].why).toBe(fallbackWhy("capsule.build"));
    expect(task.steps[4].why).toBe(fallbackWhy("thesis.build"));
    for (const s of task.steps) expect(s.why.length).toBeLessThanOrEqual(220);
    // the same call planned and wrote the test plan: one planner call
    expect(th.messages.find((m: any) => m.kind === "plan").cost.modelCalls).toBe(1);
  });

  it("a plan whose test plan fails validation still gets a task, with statement null", async () => {
    plan = out({
      steps: [step("workspace.create", { objective: "o" }), step("question.ask"), step("run.await")],
      testPlan: { ...good, statement: "More swaps cause more refunds." },
    });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "swaps and refunds" });
    await svc.idle();
    const task = (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>().tasks[0];
    expect(task.testPlan).toMatchObject({
      statement: null,
      xLabel: null,
      editedByUser: false,
      lockedAt: null,
    });
    expect(task.state).toBe("proposed");
  });

  it("a plan without question.ask has testPlan null", async () => {
    plan = out({ steps: [step("workspace.create", { objective: "o" })], testPlan: good });
    const tid = await newThread();
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: "make a workspace" });
    await svc.idle();
    expect((await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>().tasks[0].testPlan).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------ PATCH rules
describe("PATCH /v1/agent/tasks/:id/test-plan", () => {
  const steps = [S("workspace.create", { objective: "o" }), S("question.ask"), S("run.await")];
  it("edits fields, marks the plan edited, and keeps it unlocked", async () => {
    const id = await propose(steps, writtenPlan());
    const r = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, {
      statement: "Days with more swaps have a lower refund rate.",
      expectedSign: "negative",
      windowDays: 120,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<any>().testPlan).toMatchObject({
      statement: "Days with more swaps have a lower refund rate.",
      expectedSign: "negative",
      windowDays: 120,
      xLabel: "daily swaps",
      editedByUser: true,
      lockedAt: null,
      sha256: null,
    });
    expect((await taskOf(id)).testPlan.windowDays).toBe(120);
  });
  it("each bad field is a 422 naming the field", async () => {
    const id = await propose(steps, writtenPlan());
    const r = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, {
      statement: "More swaps cause refunds.",
      windowDays: 5,
      yLabel: "Daily swaps",
    });
    expect(r.statusCode).toBe(422);
    const b = r.json<any>();
    expect(b.reasonCode).toBe("INVALID_TEST_PLAN");
    expect(b.details.map((d: any) => d.path).sort()).toEqual(["statement", "windowDays", "yLabel"]);
    // nothing changed
    expect((await taskOf(id)).testPlan).toMatchObject({ statement: good.statement, editedByUser: false });
    // an unknown field and a wrong type are 422 too
    expect(
      (await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, { colour: "red" })).statusCode,
    ).toBe(422);
    expect((await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, { lagDays: "3" })).statusCode).toBe(
      422,
    );
    expect((await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, {})).statusCode).toBe(422);
  });
  it("a task with no question has no plan to edit (422 NO_TEST_PLAN); another user's task is 404", async () => {
    const none = await propose([S("workspace.create", { objective: "o" })], null);
    const r = await call(alice, "PATCH", `/v1/agent/tasks/${none}/test-plan`, { windowDays: 60 });
    expect(r.statusCode).toBe(422);
    expect(r.json<any>().reasonCode).toBe("NO_TEST_PLAN");
    const id = await propose(steps, writtenPlan());
    expect((await call(bob, "PATCH", `/v1/agent/tasks/${id}/test-plan`, { windowDays: 60 })).statusCode).toBe(
      404,
    );
    expect(
      (await call(alice, "PATCH", `/v1/agent/tasks/not-a-uuid/test-plan`, { windowDays: 60 })).statusCode,
    ).toBe(404);
    expect((await taskOf(id)).testPlan.windowDays).toBe(90);
    const anon = await f.app.inject({
      method: "PATCH",
      url: `/v1/agent/tasks/${id}/test-plan`,
      payload: { windowDays: 60 },
    });
    expect(anon.statusCode).toBe(401);
  });
  it("a plan with no statement can be written by the user; clearing the statement clears the plan", async () => {
    const id = await propose(steps, emptyPlan());
    const w = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, {
      statement: good.statement,
      xLabel: good.xLabel,
      yLabel: good.yLabel,
      wouldCountAsWrong: good.wouldCountAsWrong,
      expectedSign: "positive",
    });
    expect(w.statusCode, w.body).toBe(200);
    expect(w.json<any>().testPlan).toMatchObject({ statement: good.statement, editedByUser: true });
    const c = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, { statement: null });
    expect(c.json<any>().testPlan).toMatchObject({ statement: null, xLabel: null, editedByUser: true });
    // statement alone on an empty plan lacks its labels: 422 on them
    const partial = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, {
      statement: good.statement,
    });
    expect(partial.statusCode).toBe(422);
    expect(partial.json<any>().details.map((d: any) => d.path)).toEqual(
      expect.arrayContaining(["xLabel", "yLabel", "wouldCountAsWrong"]),
    );
  });
});

// ---------------------------------------------------------------------------------------------------- lock on start
describe("Start locks the test plan", () => {
  it("sets lockedAt and the sha256 of the canonical plan, and nothing can change it afterwards", async () => {
    stub = stubWith([
      (p) =>
        p.method === "POST" && /\/v1\/workspaces$/.test(p.url)
          ? { status: 503, body: { reasonCode: "X", message: "m", retryable: false } }
          : null,
    ]);
    const steps = [S("workspace.create", { objective: "o" }), S("question.ask"), S("run.await")];
    const id = await propose(steps, writtenPlan());
    const before = Date.now();
    expect((await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] })).statusCode).toBe(200);
    const t = await settle(id, ["failed", "completed"]);
    stub = null;
    expect(t.testPlan.lockedAt).not.toBeNull();
    expect(Date.parse(t.testPlan.lockedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(t.testPlan.sha256).toBe(testPlanSha(writtenPlan()));
    expect(t.testPlan.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the owner cannot edit it any more
    const r = await call(alice, "PATCH", `/v1/agent/tasks/${id}/test-plan`, { windowDays: 60 });
    expect(r.statusCode).toBe(409);
    expect(r.json<any>().reasonCode).toBe("TEST_PLAN_LOCKED");
    // and the database refuses it too
    await expect(
      f.db.admin.query(
        "UPDATE agent_tasks SET test_plan = jsonb_set(test_plan, '{windowDays}', '60') WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/locked/);
    expect((await taskOf(id)).testPlan.windowDays).toBe(90);
  });
  it("a plan with no statement has nothing to lock", async () => {
    stub = stubWith([
      (p) =>
        p.method === "POST" && /\/v1\/workspaces$/.test(p.url)
          ? { status: 503, body: { reasonCode: "X", message: "m", retryable: false } }
          : null,
    ]);
    const id = await propose(
      [S("workspace.create", { objective: "o" }), S("question.ask"), S("run.await")],
      emptyPlan(),
    );
    await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
    const t = await settle(id, ["failed", "completed"]);
    stub = null;
    expect(t.testPlan).toMatchObject({ statement: null, lockedAt: null, sha256: null });
  });
});

// ------------------------------------------------------------------------------------------ the run: question, series
const runId = "11111111-1111-4111-8111-111111111111";
const completeRun = {
  runId,
  version: 3,
  terminal: true,
  state: "COMPLETE",
  children: [{ status: "DONE" }],
  budget: { spent: { usd: 0.0123, toolCalls: 4 } },
  findings: [{ statement: "s", status: "supported" }],
  interpretation: { state: "ready", reason: null, findingCount: 1 },
};
const sv = (panelHash: string, panelTitle: string, column: string) => ({
  panelHash,
  panelTitle,
  column,
  unit: null,
  days: 90,
});
const SWAPS = sv("a".repeat(64), "Swaps", "swaps");
const RATE = sv("a".repeat(64), "Swaps", "refundRate");
const VOLUME = sv("b".repeat(64), "Volume", "volumeUsd");

interface Seen {
  questions: any[];
  resolves: any[];
  capsules: any[];
  theses: any[];
}
/** The routes a plan with a question needs, answered as the real API would for this run. */
const flow = (
  seen: Seen,
  resolver: (body: any) => { status: number; body: unknown },
  extra: Handler[] = [],
): Handler[] => [
  ...extra,
  (p) =>
    is("POST", /\/questions$/)(p)
      ? (seen.questions.push(p.body), { status: 202, body: { runId, workflowId: "w" } })
      : null,
  (p) => (is("GET", new RegExp(`^/v1/runs/${runId}$`))(p) ? { status: 200, body: completeRun } : null),
  (p) => (is("POST", /\/test-plan\/resolve$/)(p) ? (seen.resolves.push(p.body), resolver(p.body)) : null),
  (p) =>
    is("POST", /\/assistant\/setup$/)(p)
      ? {
          status: 200,
          body: { markers: [], monitors: [], hypothesis: null, skipped: [], cost: { usd: 0, modelCalls: 0 } },
        }
      : null,
  (p) =>
    is("POST", /\/capsules$/)(p)
      ? (seen.capsules.push(p.body),
        { status: 201, body: { capsuleId: "cap-1", title: "T", capsuleHash: "h" } })
      : null,
  (p) =>
    is("POST", /\/theses$/)(p)
      ? (seen.theses.push(p.body),
        {
          status: 201,
          body: {
            thesisId: "thesis-1",
            version: "v-1",
            status: "draft",
            verdict: { status: "SUPPORTED", headline: "h" },
          },
        })
      : null,
];
const newSeen = (): Seen => ({ questions: [], resolves: [], capsules: [], theses: [] });
const investigate = (): PlannedStep[] => [
  S("workspace.create", { objective: "NEAR Intents reliability" }),
  S("question.ask", { question: "Test whether days with more swaps have a higher refund rate." }),
  S("run.await"),
  S("setup.auto"),
  S("capsule.build"),
  S("thesis.build"),
];
const run = async (steps: PlannedStep[], tp: TaskTestPlan | null) => {
  const id = await propose(steps, tp);
  await call(alice, "POST", `/v1/agent/tasks/${id}/start`, { consent: [] });
  return settle(id, ["completed", "failed"]);
};

describe("the investigation charts the two series of the plan", () => {
  it("question.ask appends the plain instruction to the user's question (the plan as edited and locked at Start)", async () => {
    const seen = newSeen();
    stub = stubWith(
      flow(seen, () => ({ status: 200, body: { status: "resolved", by: "name", x: SWAPS, y: RATE } })),
    );
    const edited = writtenPlan({ windowDays: 120, editedByUser: true });
    const t = await run(investigate(), edited);
    stub = null;
    expect(t.state, JSON.stringify(t.steps.map((s: any) => s.error))).toBe("completed");
    expect(seen.questions).toHaveLength(1);
    const q = seen.questions[0].question as string;
    expect(q.startsWith("Test whether days with more swaps have a higher refund rate.\n\n")).toBe(true);
    expect(q).toContain(instructionFor({ xLabel: "daily swaps", yLabel: "refund rate", windowDays: 120 }));
    expect(q).toContain("last 120 days");
    expect(q.length).toBeLessThanOrEqual(2000);
    expect(t.steps[1].result.items.map((i: any) => i.label)).toContain("Charts requested");
  });
  it("a task with no written plan sends the question as it was (nothing appended)", async () => {
    const seen = newSeen();
    stub = stubWith(flow(seen, () => ({ status: 200, body: {} })));
    const t = await run(investigate(), emptyPlan());
    stub = null;
    expect(t.state).toBe("completed");
    expect(seen.questions[0].question).toBe("Test whether days with more swaps have a higher refund rate.");
    expect(seen.resolves).toHaveLength(0);
    expect(seen.theses[0].test).toBeUndefined();
    expect(seen.theses[0].planLock).toBeUndefined();
  });
});

describe("resolving the two series after the run", () => {
  it("by name: the resolved pair and the locked plan are the explicit test of the capsule and the thesis, with no model call", async () => {
    const seen = newSeen();
    resolveCalls = 0;
    stub = stubWith(
      flow(seen, () => ({ status: 200, body: { status: "resolved", by: "name", x: SWAPS, y: RATE } })),
    );
    const t = await run(investigate(), writtenPlan({ expectedSign: "positive" }));
    stub = null;
    expect(t.state).toBe("completed");
    expect(resolveCalls).toBe(0);
    // resolved once, by the first step that needs the pair (setup.auto), not again for the capsule and the thesis
    expect(seen.resolves).toEqual([{ runId, xLabel: "daily swaps", yLabel: "refund rate" }]);
    const test = {
      x: { panelHash: SWAPS.panelHash, column: "swaps" },
      y: { panelHash: RATE.panelHash, column: "refundRate" },
      lagDays: 0,
      expectedSign: "positive",
      statement: good.statement,
      chosenBy: "planner",
    };
    expect(seen.capsules[0]).toMatchObject({ runId, test });
    expect(seen.theses[0]).toMatchObject({ runId, test, planLock: { taskId: t.id } });
    expect(seen.theses[0].test.why).toMatch(/matched to the run's real series by name\.$/);
    expect(seen.capsules[0].test).toEqual(seen.theses[0].test);
    expect(t.links.thesisId).toBe("thesis-1");
  });

  it("chosenBy is user when the user edited the plan", async () => {
    const seen = newSeen();
    stub = stubWith(
      flow(seen, () => ({ status: 200, body: { status: "resolved", by: "name", x: SWAPS, y: RATE } })),
    );
    const t = await run(investigate(), writtenPlan({ editedByUser: true }));
    stub = null;
    expect(t.state).toBe("completed");
    expect(seen.theses[0].test.chosenBy).toBe("user");
    expect(seen.theses[0].test.why).toMatch(/^The user named/);
  });

  it("ambiguous: ONE model call picks ids from the listed candidates, is charged to the user and validated by the API", async () => {
    const seen = newSeen();
    resolveCalls = 0;
    prompts.length = 0;
    pick = { xId: "c2", yId: "c3", missing: "none" };
    const candidates = [SWAPS, VOLUME, RATE];
    stub = stubWith(
      flow(seen, (b) =>
        b.proposal
          ? { status: 200, body: { status: "resolved", by: "model", x: VOLUME, y: RATE } }
          : { status: 200, body: { status: "ambiguous", matches: { x: "many", y: "one" }, candidates } },
      ),
    );
    const t = await run(investigate(), writtenPlan());
    stub = null;
    expect(t.state).toBe("completed");
    expect(resolveCalls).toBe(1);
    // ids only: the model saw the candidates and the labels, and answered with ids
    expect(prompts[0]).toContain('"id":"c1"');
    expect(prompts[0]).toContain("untrusted_data");
    // the proposal that reached the API is the pair the model picked, by panel hash and column
    expect(seen.resolves[1].proposal).toEqual({
      x: { panelHash: VOLUME.panelHash, column: "volumeUsd" },
      y: { panelHash: RATE.panelHash, column: "refundRate" },
    });
    expect(seen.theses[0].test.x).toEqual({ panelHash: VOLUME.panelHash, column: "volumeUsd" });
    expect(seen.theses[0].test.why).toMatch(/by a model that returned ids only/);
    // cost: on the setup step (the first step that needed the pair), charged to the user's credits
    const setup = t.steps[3];
    expect(setup.cost).toMatchObject({ modelUsd: "0.002100", modelCalls: 1 });
    expect(setup.cost.entries[0].label).toMatch(/Matching the test plan's series/);
    const credits = (await call(alice, "GET", "/v1/credits")).json<any>();
    const e = credits.entries.find((x: any) => x.refKind === "agent_step" && x.refId.startsWith(t.id));
    expect(e).toMatchObject({ kind: "charge", category: "model", amountUsd: "0.002100" });
  });

  it("the model says a series is not there: the thesis step completes with 'no thesis' and what to ask for", async () => {
    const seen = newSeen();
    pick = { xId: "c1", yId: "", missing: "y" };
    stub = stubWith(
      flow(seen, () => ({
        status: 200,
        body: { status: "ambiguous", matches: { x: "one", y: "none" }, candidates: [SWAPS, VOLUME] },
      })),
    );
    const t = await run(investigate(), writtenPlan());
    stub = null;
    expect(t.state).toBe("completed");
    const thesis = t.steps[5];
    expect(thesis.state).toBe("done");
    expect(thesis.result.summary).toMatch(/^No thesis: the run does not hold "refund rate"\./);
    expect(thesis.result.summary).toMatch(
      /Ask for the investigation again with a question that names "refund rate"/,
    );
    expect(t.steps[4].result.summary).toMatch(
      /^No capsule was built\. No thesis: the run does not hold "refund rate"/,
    );
    expect(seen.capsules).toHaveLength(0);
    expect(seen.theses).toHaveLength(0);
    expect(t.links.thesisId).toBeNull();
  });

  it("a run that holds neither series (missing from the API) is the same completed 'no thesis'", async () => {
    const seen = newSeen();
    stub = stubWith(
      flow(seen, () => ({
        status: 200,
        body: { status: "missing", missing: "x", label: "daily swaps", reason: "no daily series" },
      })),
    );
    const t = await run(investigate(), writtenPlan());
    stub = null;
    expect(t.state).toBe("completed");
    expect(t.steps[5].result.summary).toMatch(/^No thesis: the run does not hold "daily swaps"\./);
  });

  it("a proposal the API rejects is a completed 'no thesis' with the reason, never a guessed pair", async () => {
    const seen = newSeen();
    pick = { xId: "c1", yId: "c2", missing: "none" };
    stub = stubWith(
      flow(seen, (b) =>
        b.proposal
          ? { status: 200, body: { status: "rejected", reason: "swaps is a part of refunds" } }
          : {
              status: 200,
              body: { status: "ambiguous", matches: { x: "many", y: "many" }, candidates: [SWAPS, RATE] },
            },
      ),
    );
    const t = await run(investigate(), writtenPlan());
    stub = null;
    expect(t.state).toBe("completed");
    expect(t.steps[5].result.summary).toMatch(
      /^No thesis: the series matched to "daily swaps" and "refund rate" cannot be tested together: swaps is a part of refunds/,
    );
    expect(seen.theses).toHaveLength(0);
  });

  it("a model that returns an id that is not in the list, or the same id twice, is 'no thesis', not a guess", async () => {
    for (const bad of [
      { xId: "c9", yId: "c2", missing: "none" as const },
      { xId: "c1", yId: "c1", missing: "none" as const },
    ]) {
      const seen = newSeen();
      pick = bad;
      stub = stubWith(
        flow(seen, () => ({
          status: 200,
          body: { status: "ambiguous", matches: {}, candidates: [SWAPS, RATE] },
        })),
      );
      const t = await run(investigate(), writtenPlan());
      stub = null;
      expect(t.steps[5].result.summary).toMatch(/^No thesis: the run does not hold /);
      expect(seen.theses).toHaveLength(0);
    }
  });
});

// ----------------------------------------------------------------------------------------------------- reasons
describe("results explain choices", () => {
  it("setup.auto passes the setup route's reasons and threshold origin through, and invents none", async () => {
    const seen = newSeen();
    stub = stubWith(
      flow(seen, () => ({ status: 200, body: { status: "resolved", by: "name", x: SWAPS, y: RATE } }), [
        (p) =>
          is("POST", /\/assistant\/setup$/)(p)
            ? {
                status: 200,
                body: {
                  markers: [{ id: "m1", title: "Peak", reason: "The finding cites swaps on a day." }],
                  monitors: [
                    {
                      id: "r1",
                      title: "Swaps below",
                      reason: "Notifies below a value.",
                      thresholdFrom: "the lowest cited value",
                    },
                    { id: "r2", title: "Swaps above", reason: "Notifies above a value." },
                  ],
                  hypothesis: null,
                  skipped: [],
                  cost: { usd: 0, modelCalls: 0 },
                },
              }
            : null,
      ]),
    );
    const t = await run(investigate().slice(0, 4), writtenPlan());
    stub = null;
    expect(t.state).toBe("completed");
    expect(t.steps[3].result.refs).toMatchObject({
      markerIds: ["m1"],
      monitorIds: ["r1", "r2"],
      markerReasons: [{ id: "m1", reason: "The finding cites swaps on a day." }],
      monitorReasons: [
        { id: "r1", reason: "Notifies below a value.", thresholdFrom: "the lowest cited value" },
        { id: "r2", reason: "Notifies above a value.", thresholdFrom: null },
      ],
    });
  });

  it("run.await gains queryNotes only when the run recorded a reason for every panel", async () => {
    const withNotes =
      (complete: boolean): Handler =>
      (p) =>
        is("GET", /\/runs\/[0-9a-f-]+\/query-notes$/)(p)
          ? {
              status: 200,
              body: {
                runId,
                panels: 2,
                complete,
                notes: [
                  { panelTitle: "Swaps", why: "The question asks about swaps." },
                  ...(complete ? [{ panelTitle: "Refunds", why: "The question asks about refunds." }] : []),
                ],
              },
            }
          : null;
    for (const complete of [true, false]) {
      const seen = newSeen();
      stub = stubWith(flow(seen, () => ({ status: 200, body: {} }), [withNotes(complete)]));
      const t = await run(
        [S("workspace.create", { objective: "o" }), S("question.ask", { question: "q" }), S("run.await")],
        null,
      );
      stub = null;
      expect(t.state).toBe("completed");
      if (complete)
        expect(t.steps[2].result.refs.queryNotes).toEqual([
          { panelTitle: "Swaps", why: "The question asks about swaps." },
          { panelTitle: "Refunds", why: "The question asks about refunds." },
        ]);
      else expect(t.steps[2].result.refs).not.toHaveProperty("queryNotes");
    }
  });

  it("a run that recorded no reasons (the real route) leaves queryNotes out", async () => {
    const seen = newSeen();
    // the real query-notes route answers 404 for a run this API does not know: the notes are left out, nothing is invented
    stub = stubWith(flow(seen, () => ({ status: 200, body: {} })));
    const t = await run(
      [S("workspace.create", { objective: "o" }), S("question.ask", { question: "q" }), S("run.await")],
      null,
    );
    stub = null;
    expect(t.state).toBe("completed");
    expect(t.steps[2].result.refs).not.toHaveProperty("queryNotes");
  });
});

// -------------------------------------------------------------------------------------------------------- follow-ups
describe("follow-up planning", () => {
  const FOLLOW =
    "In this workspace, investigate what happened around 2026-10-03: Days with more swaps have a higher failure rate.";
  const prevPlan = (): TaskTestPlan => ({
    ...writtenPlan({ statement: "Days with more swaps have a higher failure rate.", windowDays: 90 }),
    editedByUser: true,
    lockedAt: "2026-11-01T10:00:00.000Z",
    sha256: "f".repeat(64),
  });
  const followSteps = (ws: string) => [
    step("workspace.use", { workspaceId: ws }),
    step("question.ask", { question: FOLLOW }),
    step("run.await"),
    step("capsule.build"),
    step("thesis.build"),
  ];
  let ws = "";
  beforeAll(async () => {
    ws = (
      await call(alice, "POST", "/v1/workspaces", {
        objective: "Swaps and failures",
        networkScope: "fixture-only",
        idempotencyKey: "tp-follow-ws",
      })
    ).json<any>().workspaceId;
  });
  const apiWithThesis = (thesisId: string, doc: unknown): Handler[] => [
    (p) =>
      is("GET", new RegExp(`^/v1/workspaces/${ws}/runs$`))(p)
        ? { status: 200, body: { runs: [{ runId, state: "COMPLETE" }] } }
        : null,
    (p) =>
      is("GET", new RegExp(`^/v1/workspaces/${ws}/capsules$`))(p)
        ? { status: 200, body: { capsules: [{}] } }
        : null,
    (p) =>
      is("GET", /^\/v1\/theses$/)(p)
        ? { status: 200, body: { items: [{ id: thesisId, workspaceId: ws, kind: "workspace" }] } }
        : null,
    (p) =>
      is("GET", new RegExp(`^/v1/theses/${thesisId}$`))(p)
        ? { status: 200, body: { thesis: {}, doc } }
        : null,
  ];
  const send = async () => {
    const tid = await newThread();
    await call(alice, "PATCH", `/v1/agent/threads/${tid}`, { workspaceId: ws });
    await call(alice, "POST", `/v1/agent/threads/${tid}/messages`, { text: FOLLOW });
    await svc.idle();
    return (await call(alice, "GET", `/v1/agent/threads/${tid}`)).json<any>();
  };

  it("reuses the locked plan of the task that built the workspace's newest thesis (the model is told it; the server enforces it)", async () => {
    const thesisId = "00000000-0000-4000-8000-0000000000aa";
    // the plan the earlier task locked, stored with that task and its thesis
    const prior = await propose(
      [S("workspace.create", { objective: "o" }), S("question.ask"), S("run.await")],
      prevPlan(),
    );
    await f.db.admin.query(
      "UPDATE agent_tasks SET test_plan = $2::jsonb, ctx = ctx || $3::jsonb WHERE id = $1",
      [prior, JSON.stringify(prevPlan()), JSON.stringify({ thesisId })],
    );
    stub = stubWith(apiWithThesis(thesisId, { test: { plan: {} } }));
    // the model writes a different plan, but says it is a follow-up that keeps the plan
    plan = out({
      steps: followSteps(ws),
      followUp: "reuse_plan",
      testPlan: { ...good, statement: "Something the model made up.", windowDays: 0 },
    });
    const th = await send();
    stub = null;
    const task = th.tasks[0];
    expect(task.steps.map((s: any) => s.key)).toEqual([
      "workspace.use",
      "question.ask",
      "run.await",
      "capsule.build",
      "thesis.build",
    ]);
    expect(task.testPlan).toEqual({
      statement: "Days with more swaps have a higher failure rate.",
      xLabel: good.xLabel,
      yLabel: good.yLabel,
      relation: "moves_with",
      lagDays: 0,
      expectedSign: "positive",
      windowDays: 90,
      wouldCountAsWrong: good.wouldCountAsWrong,
      editedByUser: false,
      lockedAt: null,
      sha256: null,
    });
  });

  it("falls back to the plan the thesis document records when no task built it; 'Extend the window' changes only the window", async () => {
    const thesisId = "00000000-0000-4000-8000-0000000000bb";
    stub = stubWith(
      apiWithThesis(thesisId, {
        test: {
          n: 70,
          plan: {
            statement: "Days with higher swaps have higher volume usd.",
            x: { column: "swaps" },
            y: { column: "volumeUsd" },
            relation: "moves_with",
            lagDays: 0,
            expectedSign: "positive",
            wouldCountAsWrong: "The claim fails if the interval includes zero.",
          },
        },
      }),
    );
    plan = out({ steps: followSteps(ws), followUp: "reuse_plan", testPlan: { ...good, windowDays: 365 } });
    const th = await send();
    stub = null;
    expect(th.tasks[0].testPlan).toMatchObject({
      statement: "Days with higher swaps have higher volume usd.",
      xLabel: "swaps",
      yLabel: "volume usd",
      expectedSign: "positive",
      windowDays: 365,
      editedByUser: false,
    });
  });

  it("when the user asks to change the plan the model's new plan is used", async () => {
    const thesisId = "00000000-0000-4000-8000-0000000000cc";
    stub = stubWith(apiWithThesis(thesisId, { test: { plan: {} } }));
    plan = out({ steps: followSteps(ws), followUp: "new_plan", testPlan: good });
    const th = await send();
    stub = null;
    expect(th.tasks[0].testPlan.statement).toBe(good.statement);
  });
});

// ------------------------------------------------------------------------------------- the old plans keep working
describe("tasks built before test plans", () => {
  it("a task row with no test_plan and steps with no why still render, with the fixed sentences", async () => {
    const id = await propose([S("workspace.create", { objective: "o" })], null);
    await f.db.admin.query("UPDATE agent_task_steps SET why = NULL WHERE task_id = $1", [id]);
    const t = await taskOf(id);
    expect(t.testPlan).toBeNull();
    expect(t.steps[0].why).toBe(fallbackWhy("workspace.create"));
  });
});
