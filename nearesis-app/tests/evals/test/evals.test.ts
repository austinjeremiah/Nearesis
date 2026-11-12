import { describe, expect, it } from "vitest";
import { assertReadOnly } from "../lib/clickhouse.ts";
import { CATEGORIES } from "../lib/schema.ts";
import type { Question } from "../lib/schema.ts";
import { scoreQuestion } from "../lib/score.ts";
import type { Observation, RunObs } from "../lib/score.ts";
import { forbiddenHits, proseNumbers, runProbe, ungroundedNumbers } from "../lib/validators.ts";
import type { ProbeIo } from "../lib/validators.ts";
import { getPath } from "../lib/util.ts";
import { loadQuestions, summarise } from "../run.ts";

const dev = loadQuestions("dev");
const held = loadQuestions("heldout");

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const jaccard = (a: string, b: string): number => {
  const x = tokens(a);
  const y = tokens(b);
  return [...x].filter((t) => y.has(t)).length / new Set([...x, ...y]).size;
};

describe("question corpus", () => {
  it("has at least 50 dev questions covering every s19 category and every difficulty", () => {
    expect(dev.length).toBeGreaterThanOrEqual(50);
    for (const c of CATEGORIES) expect(dev.filter((q) => q.category === c).length, c).toBeGreaterThan(0);
    for (const d of ["easy", "medium", "hard", "adversarial"])
      expect(
        dev.some((q) => q.difficulty === d),
        d,
      ).toBe(true);
    expect(dev.every((q) => q.split === "dev")).toBe(true);
  });

  it("defines, for every question, the seven s19 fields in machine-checkable form", () => {
    for (const q of [...dev, ...held]) {
      expect(q.minAnswerProperties.length, q.id).toBeGreaterThan(0);
      expect(q.requiredProvenance.length, q.id).toBeGreaterThan(0);
      expect(q.acceptanceTests.length, q.id).toBeGreaterThan(0);
      expect(q.kind === "run" ? q.run !== undefined : (q.http ?? []).length > 0, q.id).toBe(true);
      // acceptable refusal conditions are explicit whenever a refusal is allowed on a run question
      if (q.kind === "run" && q.expect.outcome !== "answer")
        expect(q.acceptableRefusals.length, q.id).toBeGreaterThan(0);
      // every numeric claim has an independent check: a question that names numbers carries a probe
      if (q.category === "intents" || q.category === "ecosystem")
        expect(q.probes.length, q.id).toBeGreaterThan(0);
      for (const p of q.probes)
        if (p.kind === "ch_equals" || p.kind === "ch_check")
          expect(() => assertReadOnly(p.ch), q.id).not.toThrow();
    }
  });

  it("keeps a held-out split of unseen questions that is not a paraphrase of the dev set", () => {
    expect(held.length).toBeGreaterThanOrEqual(10);
    expect(held.every((q) => q.split === "heldout" && q.id.startsWith("H"))).toBe(true);
    const ids = new Set(dev.map((q) => q.id));
    for (const h of held) {
      expect(ids.has(h.id)).toBe(false);
      const best = Math.max(...dev.map((q) => jaccard(q.prompt, h.prompt)));
      expect(best, `${h.id} too close to a dev prompt`).toBeLessThan(0.6);
    }
  });
});

describe("deterministic validators", () => {
  const io = (over: Partial<ProbeIo> & { body?: unknown; status?: number } = {}): ProbeIo => ({
    apiGet: async () => ({
      status: over.status ?? 200,
      body: over.body ?? { data: { swaps: 100, parts: [30, 70] }, status: "OK" },
    }),
    chScalar: over.chScalar ?? (async () => 100),
  });
  it("compares API numbers with an independent query, exactly or within a stated tolerance", async () => {
    const p = {
      kind: "ch_equals",
      label: "n",
      api: "/x",
      json: "data.swaps",
      ch: "SELECT 1",
      rel: 0,
    } as const;
    expect((await runProbe(p, io())).ok).toBe(true);
    expect((await runProbe(p, io({ chScalar: async () => 101 }))).ok).toBe(false);
    expect((await runProbe({ ...p, rel: 0.02 }, io({ chScalar: async () => 101 }))).ok).toBe(true);
    expect((await runProbe(p, io({ status: 500 }))).ok).toBe(false);
  });
  it("checks partition, structural and source facts", async () => {
    expect(
      (
        await runProbe(
          { kind: "sum_equals", label: "s", api: "/x", parts: ["data.parts"], total: "data.swaps", abs: 0 },
          io(),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await runProbe(
          { kind: "sum_equals", label: "s", api: "/x", parts: ["data.parts"], totalValue: 99, abs: 0 },
          io(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await runProbe(
          { kind: "api_field", label: "a", api: "/x", json: "status", equals: "OK", httpStatus: 200 },
          io(),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await runProbe(
          { kind: "ch_check", label: "c", ch: "SELECT 0", expect: 0, precondition: false },
          io({ chScalar: async () => 0 }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (await runProbe({ kind: "range", label: "r", api: "/x", json: "data.swaps", min: 0, max: 1 }, io())).ok,
    ).toBe(false);
  });
  it("resolves dotted, indexed and wildcard paths", () => {
    const o = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(getPath(o, "a.b[1].c")).toBe(2);
    expect(getPath(o, "a.b[*].c")).toEqual([1, 2]);
    expect(getPath(o, "a.x.y")).toBeUndefined();
  });
  it("refuses any ClickHouse statement that is not one read-only SELECT", () => {
    for (const bad of [
      "INSERT INTO t VALUES (1)",
      "SELECT 1; DROP TABLE t",
      "ALTER TABLE t DELETE WHERE 1",
      "SYSTEM RELOAD DICTIONARIES",
    ])
      expect(() => assertReadOnly(bad)).toThrow();
    expect(() => assertReadOnly("WITH 1 AS x SELECT x")).not.toThrow();
  });
  it("catches forbidden claims and numbers the answer cannot source", () => {
    const q = { forbiddenClaims: [{ id: "x", pattern: "solver \\w+ filled", flags: "i", why: "w" }] };
    expect(forbiddenHits("This proves the point", q)).toContain("overclaim");
    expect(forbiddenHits("statistically significant (p < 0.01)", q)).toContain("significance_without_test");
    expect(forbiddenHits("1,200 unique users", q)).toContain("accounts_are_people");
    expect(forbiddenHits("solver abc filled 3", q)).toContain("x");
    expect(forbiddenHits("accounts are not people; coverage is partial", q)).toEqual([]);
    expect(
      proseNumbers(
        "On 2026-10-13 there were 564,285 swaps in 2026 (id 3f2a1b9c-1111-4222-8333-444455556666)",
      ),
    ).toEqual(["564285"]);
    expect(ungroundedNumbers("564,285 swaps and 12,345 refunds", ["564285"])).toEqual(["12345"]);
  });
});

describe("scoring", () => {
  const base = (
    over: Partial<Question["expect"]> = {},
    refusals: Question["acceptableRefusals"] = [],
  ): Question =>
    ({
      id: "Q999",
      split: "dev",
      category: "intents",
      difficulty: "easy",
      prompt: "p p p p p p p p p p",
      kind: "run",
      requiredSources: [],
      minAnswerProperties: ["x"],
      acceptableRefusals: refusals,
      requiredProvenance: ["x"],
      invariants: [],
      forbiddenClaims: [],
      acceptanceTests: ["A19"],
      probes: [],
      run: { as: "owner", source: "live", snapshotPolicy: "live" },
      expect: {
        outcome: "either",
        answerStates: ["COMPLETE", "PARTIAL"],
        minPanels: 1,
        maxLatencyMs: 1000,
        maxUsd: 0.05,
        reproducible: false,
        ...over,
      },
    }) as Question;
  const run = (over: Partial<RunObs> = {}): RunObs => ({
    state: "COMPLETE",
    terminal: true,
    failure: null,
    panels: [],
    findings: [],
    spentUsd: 0.01,
    runId: "r",
    ...over,
  });
  const obs = (r: RunObs, over: Partial<Observation> = {}): Observation => ({
    latencyMs: 500,
    run: r,
    probes: [],
    reproduced: null,
    ...over,
  });
  const panel = {
    panelId: "p",
    title: "swaps per day",
    fields: ["intents_swaps.day"],
    queryHash: "h",
    snapshotPolicy: "live",
    completeness: "complete",
  };
  const CANNOT = [{ state: "PARTIAL", reasonCodes: ["CANNOT_COMPUTE"], condition: "c" }];

  it("passes a grounded answer with provenance", () => {
    const s = scoreQuestion(base(), obs(run({ panels: [panel, { ...panel, panelId: "p2" }] })));
    expect(s.verdict).toBe("PASS");
  });
  it("a panel without a query hash fails provenance", () => {
    expect(scoreQuestion(base(), obs(run({ panels: [{ ...panel, queryHash: null }] }))).dims.provenance).toBe(
      0,
    );
  });
  it("an acceptable refusal is REFUSED_OK, an unacceptable reason is FAIL, and required answers cannot be refused", () => {
    const refused = run({
      state: "PARTIAL",
      failure: {
        reasonCode: "CANNOT_COMPUTE",
        humanActionNeeded: "the catalogue has no solver identity column",
      },
    });
    expect(scoreQuestion(base({}, CANNOT), obs(refused)).verdict).toBe("REFUSED_OK");
    expect(scoreQuestion(base({}, []), obs(refused)).verdict).toBe("FAIL");
    expect(scoreQuestion(base({ outcome: "answer" }, CANNOT), obs(refused)).verdict).toBe("FAIL");
    expect(scoreQuestion(base({ outcome: "refusal" }, CANNOT), obs(refused)).verdict).toBe("PASS");
  });
  it("answering a question whose data does not exist fails", () => {
    expect(scoreQuestion(base({ outcome: "refusal" }, CANNOT), obs(run({ panels: [panel] }))).verdict).toBe(
      "FAIL",
    );
  });
  it("a refusal that quotes an unsourced number fails honest-refusal", () => {
    const r = run({
      state: "PARTIAL",
      failure: {
        reasonCode: "CANNOT_COMPUTE",
        humanActionNeeded: "solver 4,812 handled most swaps but data are missing",
      },
    });
    expect(scoreQuestion(base({}, CANNOT), obs(r)).dims.honest_refusal).toBe(0);
  });
  it("latency and cost are gating", () => {
    const a = run({ panels: [panel, { ...panel, panelId: "p2" }], spentUsd: 0.5 });
    expect(scoreQuestion(base(), obs(a)).dims.cost).toBe(0);
    expect(scoreQuestion(base(), obs(run({ panels: [panel] }), { latencyMs: 5000 })).verdict).toBe("FAIL");
  });
  it("a failed independent probe fails numerical grounding", () => {
    const probes = [
      { label: "n", kind: "ch_equals" as const, ok: false, observed: 1, expected: 2, detail: "d" },
    ];
    expect(
      scoreQuestion(base(), obs(run({ panels: [panel, { ...panel, panelId: "p2" }] }), { probes })).dims
        .numerical_grounding,
    ).toBe(0);
  });
  it("http questions score typed errors", () => {
    const q = {
      ...base(),
      kind: "http" as const,
      run: undefined,
      http: [
        { as: "viewer" as const, method: "GET" as const, path: "/x", expectStatus: 403, expectBody: [] },
      ],
    };
    const good = {
      latencyMs: 10,
      probes: [],
      reproduced: null,
      steps: [
        {
          index: 0,
          status: 403,
          reasonCode: "FORBIDDEN",
          traceId: "t",
          bodyText: "{}",
          ok: true,
          detail: "",
        },
      ],
    };
    expect(scoreQuestion(q as Question, good).verdict).toBe("PASS");
    const bad = {
      ...good,
      steps: [
        {
          ...good.steps[0]!,
          ok: false,
          detail: "status 200, wanted 403",
          status: 200,
          reasonCode: null,
          traceId: null,
        },
      ],
    };
    expect(scoreQuestion(q as Question, bad).verdict).toBe("FAIL");
  });
  it("a precondition skip is reported as SKIPPED, not failed", () => {
    expect(
      scoreQuestion(base(), { latencyMs: 0, probes: [], reproduced: null, skipped: "precondition changed" })
        .verdict,
    ).toBe("SKIPPED");
  });
  it("renders a summary with per-category and per-dimension tables", () => {
    const row = scoreQuestion(base(), obs(run({ panels: [panel, { ...panel, panelId: "p2" }] })));
    const md = summarise({
      tag: "t",
      split: "dev",
      base: "b",
      cap: 0.4,
      live: false,
      observedSpend: 0,
      runSpend: 0.01,
      rows: [row],
      qs: [base()],
    });
    expect(md).toContain("| intents | 1 | 1 | 0 | 0 | 0 |");
    expect(md).toContain("numerical_grounding");
  });
});
