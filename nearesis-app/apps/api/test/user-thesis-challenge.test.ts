import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InferenceProvider } from "@nearesis/contracts";
import { MockInferenceProvider, type MockFixture } from "../../../packages/inference/src/mock.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { outcomeOf, validateNotes, factsOf } from "../src/user-thesis/challenges.ts";
import type { Note } from "../src/user-thesis/challenges.ts";

const DOC = {
  schema: "nearesis.thesis.v1",
  version: "v-0123456789ab",
  generatedAt: "2026-11-13T00:00:00.000Z",
  hypothesis: "Swaps and volume move together over the window.",
  origin: { kind: "workspace", workspaceId: "w", runId: "r", capsuleId: "c", hypothesisId: null },
  verdict: {
    status: "MIXED",
    headline: "MIXED: the same-day correlation is 0.62 over 70 aligned days.",
    comparison: {
      summary: "Same-day correlation 0.62.",
      rows: [{ label: "Same-day correlation", value: "0.62", unit: null }],
    },
    whatWouldChangeOurMind: ["A same-day correlation below 0.2."],
  },
  sections: [],
  claims: [],
  charts: [
    {
      id: "swaps",
      title: "Swaps per day",
      unit: "swaps",
      sentence: "Swaps went from 100 to 90.",
      evidenceAgainst: null,
      caveats: [],
      x: ["2026-08-01", "2026-08-02", "2026-08-03"],
      series: [{ name: "swaps", values: ["100", "120", "90"] }],
    },
  ],
  test: {
    rule: "relationship-v1",
    n: 70,
    pearson: "0.62",
    x: { name: "swaps" },
    y: { name: "volume" },
    lag: [{ days: 7, value: "0.41" }],
    coverage: { complete: true },
    thresholds: { minDays: 30, supportedMinDays: 60 },
  },
  verification: { capsule: { status: "reproduced" }, outlayer: null },
};
const hash = (d: unknown) => createHash("sha256").update(JSON.stringify(d)).digest("hex");

const GOOD =
  "The same-day correlation of 0.62 rests on 70 aligned days and could reflect a shared trend in both series.";
const BAD = "The correlation of 0.91 could be inflated by a handful of extreme days.";
const note = (
  text: string,
  group: Note["group"] = "causation",
  severity: Note["severity"] = "minor",
  refs: string[] = ["test.pearson"],
): Note => ({ text, group, severity, refs });

let outputs: unknown = { notes: [] };
let fail = false;
const prompts: string[] = [];
const inner = new MockInferenceProvider({ fixtures: [] });
const provider: InferenceProvider = {
  id: "mock",
  health: () => inner.health(),
  listModels: () => inner.listModels(),
  verifyResponse: () => inner.verifyResponse(),
  streamText: (a) => inner.streamText(a),
  generateStructured: (a) => {
    prompts.push(a.prompt);
    if (fail) throw new Error("model down");
    const fx: MockFixture[] = [{ promptIncludes: "[stage=thesis_challenge]", output: outputs }];
    return new MockInferenceProvider({ fixtures: fx }).generateStructured(a);
  },
};

let f: ApiFixture;
let spent = 0;
let alice: string;
let vera: string;
let bob: string;
let carol: string;
let thesisId: string;
let publicId: string;
const SLUG = "abcdefghij0123456789";
const post = (tok: string | null, url: string, payload: unknown = undefined) =>
  f.app.inject({
    method: "POST",
    url,
    headers: tok ? bearer(tok) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const get = (tok: string | null, url: string) =>
  f.app.inject({ method: "GET", url, headers: tok ? bearer(tok) : {} });
const challenge = (tok: string, id = thesisId) => post(tok, `/v1/theses/${id}/challenge`);
const q = (s: string, p: unknown[] = []) => f.db.admin.query(s, p);

beforeAll(async () => {
  f = await apiFixture({
    runtime: true,
    appOptions: {
      assistant: { inference: { provider, model: "mock-1" } },
      externalModelSpend: async () => spent,
    },
  });
  const a = await seedOrg(f.db.admin, "tc-a", { alice: "owner", vera: "viewer" });
  const b = await seedOrg(f.db.admin, "tc-b", { bob: "owner" });
  const c = await seedOrg(f.db.admin, "tc-c", { carol: "owner" });
  alice = await login(f.app, a.users.alice!.subject);
  vera = await login(f.app, a.users.vera!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  carol = await login(f.app, c.users.carol!.subject);
  const ws = (
    await post(alice, "/v1/workspaces", {
      objective: "o",
      networkScope: "fixture-only",
      idempotencyKey: "tc-ws-00000001",
    })
  ).json<{ workspaceId: string }>().workspaceId;
  const ownerId = (await q("SELECT id FROM users WHERE oidc_subject = $1", [a.users.alice!.subject])).rows[0]
    .id as string;
  const mk = async (version: string, status: string, slug: string | null) => {
    const id = randomUUID();
    await q(
      `INSERT INTO theses(id, org_id, workspace_id, owner_user_id, run_id, capsule_id, version, status, share_slug, title, doc, doc_sha256, published_at)
       VALUES ($1,$2,$3,$4,$5,'cap-x',$6,$7,$8,'Swaps and volume',$9,$10, $11)`,
      [
        id,
        a.orgId,
        ws,
        ownerId,
        randomUUID(),
        version,
        status,
        slug,
        JSON.stringify(DOC),
        hash(DOC),
        status === "published" ? new Date() : null,
      ],
    );
    return id;
  };
  thesisId = await mk("v-0123456789ab", "draft", null);
  publicId = await mk("v-0123456789ac", "published", SLUG);
}, 90_000);
afterAll(async () => f?.close());

const rowOf = async (id: string) =>
  (await q("SELECT doc, doc_sha256 FROM theses WHERE id = $1", [id])).rows[0] as {
    doc: unknown;
    doc_sha256: string;
  };

describe("note validation and outcome rule (pure)", () => {
  const facts = factsOf(DOC);
  it("lists every number of the document as a fact", () => {
    const v = facts.map((x) => x.value);
    expect(v).toEqual(expect.arrayContaining(["0.62", "70", "0.41", "100", "90", "120", "3"]));
  });
  it("keeps grounded notes, drops ungrounded, causal, advice, duplicate and too short ones", () => {
    const r = validateNotes(
      [
        note(GOOD),
        note(BAD),
        note("The volume drives swaps on the busiest days of the window."),
        note("You should buy more before the next window opens."),
        note(GOOD),
        note("Too short."),
        note(
          "Values quoted as 0.62 or 0.620 are fine, and the lag value of 0.41 is the 7 day figure.",
          "measurement",
          "material",
          ["test.lag.7", "nope.unknown"],
        ),
      ],
      facts,
    );
    expect(r.kept.map((n) => n.text.slice(0, 20))).toEqual([GOOD.slice(0, 20), "Values quoted as 0.6"]);
    expect(r.dropped).toBe(5);
    expect(r.kept[1]!.refs).toEqual(["test.lag.7"]);
  });
  it("outcome branches", () => {
    const n = (group: string, severity: string, refs: string[] = []): Note => ({
      text: "t",
      group: group as Note["group"],
      severity: severity as Note["severity"],
      refs,
    });
    expect(outcomeOf([], 0, false)).toBe("holds");
    expect(outcomeOf([n("window", "minor")], 0, false)).toBe("holds");
    expect(outcomeOf([n("window", "material")], 0, false)).toBe("weakened");
    expect(outcomeOf([n("window", "material"), n("coverage", "material")], 0, false)).toBe("weakened");
    expect(outcomeOf([n("alternative", "material", ["verdict"])], 0, false)).toBe("weakened");
    expect(outcomeOf([n("alternative", "material", ["test.n"])], 0, false)).toBe("unsupported");
    expect(outcomeOf([n("measurement", "material", ["plan"])], 0, false)).toBe("unsupported");
    expect(outcomeOf([n("causation", "material", ["test.n"])], 0, false)).toBe("weakened");
    expect(
      outcomeOf(
        [n("a", "material"), n("b", "material"), n("c", "material")].map((x) => ({
          ...x,
          group: "window" as const,
        })),
        0,
        false,
      ),
    ).toBe("unsupported");
    expect(outcomeOf([], 2, false)).toBe("unavailable");
    expect(outcomeOf([n("window", "material")], 1, true)).toBe("unavailable");
  });
});

describe("POST /v1/theses/:id/challenge", () => {
  it("keeps the grounded note, drops the ungrounded one, stores it, charges once and never changes the thesis", async () => {
    spent = 0;
    prompts.length = 0;
    outputs = { notes: [note(GOOD), note(BAD, "alternative", "material", ["test.n"])] };
    const before = await rowOf(thesisId);
    const r = await challenge(alice);
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(c).toMatchObject({
      outcome: "holds",
      droppedNotes: 1,
      by: expect.any(String),
      answer: null,
      answeredAt: null,
      cost: { modelCalls: 1 },
    });
    expect(c.notes).toEqual([{ text: GOOD, group: "causation", severity: "minor", refs: ["test.pearson"] }]);
    expect(c.cost.usd).toBeGreaterThan(0);
    // the model saw the thesis as untrusted data and the fact list
    expect(prompts[0]).toContain("<untrusted_data");
    expect(prompts[0]).toContain("test.pearson | same-day correlation | 0.62");
    // stored, hash unchanged
    const after = await rowOf(thesisId);
    expect(after).toEqual(before);
    expect(
      (await q("SELECT count(*)::int AS n FROM thesis_challenges WHERE thesis_id = $1", [thesisId])).rows[0]
        .n,
    ).toBe(1);
    // one charge of the actual USD, ref kind thesis_challenge
    const e = (
      await q(
        "SELECT amount_micro, category FROM usd_credit_entries WHERE ref_kind = 'thesis_challenge' AND ref_id = $1 AND kind = 'charge'",
        [c.challengeId],
      )
    ).rows;
    expect(e).toHaveLength(1);
    expect(Number(e[0].amount_micro) / 1e6).toBeCloseTo(c.cost.usd, 6);
    expect(e[0].category).toBe("model");
    // listed, newest first
    const l = (await get(alice, `/v1/theses/${thesisId}/challenges`)).json<{
      challenges: Array<{ challengeId: string }>;
    }>();
    expect(l.challenges[0]!.challengeId).toBe(c.challengeId);
  });

  it("computes each outcome from the kept notes", async () => {
    const one = async (notes: unknown[]) => {
      outputs = { notes };
      return (await challenge(alice)).json<{ outcome: string; notes: unknown[]; droppedNotes: number }>();
    };
    expect((await one([])).outcome).toBe("holds");
    expect((await one([note(GOOD, "window", "minor")])).outcome).toBe("holds");
    expect((await one([note(GOOD, "window", "material", ["verdict"])])).outcome).toBe("weakened");
    expect((await one([note(GOOD, "alternative", "material", ["test.n"])])).outcome).toBe("unsupported");
    const three = await one([
      note("The window of 70 aligned days is short.", "window", "material"),
      note("Daily totals hide timing within the day.", "measurement", "material", ["verdict"]),
      note("A single event drives the 0.62 reading on its own days.", "coverage", "material"),
    ]);
    // the third note says "drives": dropped by the wording rule, so two material notes remain
    expect(three.droppedNotes).toBe(1);
    expect(three.outcome).toBe("weakened");
    const all = await one([note(BAD)]);
    expect(all).toMatchObject({ outcome: "unavailable", droppedNotes: 1, notes: [] });
  });

  it("a failed model call is stored as unavailable with no notes", async () => {
    fail = true;
    const c = (await challenge(alice)).json<{
      outcome: string;
      notes: unknown[];
      droppedNotes: number;
      challengeId: string;
    }>();
    fail = false;
    expect(c).toMatchObject({ outcome: "unavailable", notes: [], droppedNotes: 0 });
    const stored = (await q("SELECT notes, outcome FROM thesis_challenges WHERE id = $1", [c.challengeId]))
      .rows[0];
    expect(stored).toMatchObject({ outcome: "unavailable", notes: [] });
  });

  it("works on the reference thesis, and 404s an unknown or invisible thesis", async () => {
    outputs = { notes: [] };
    const r = await challenge(alice, "reference-near-intents");
    expect(r.statusCode).toBe(200);
    expect(prompts.at(-1)).toContain("verdict.intentsVsPrice.5 | Origins scored, horizon 1 days | 77");
    expect((await challenge(bob, thesisId)).statusCode).toBe(404);
    expect((await challenge(alice, randomUUID())).statusCode).toBe(404);
    expect((await challenge(alice, "nope")).statusCode).toBe(404);
    expect((await post(null, `/v1/theses/${thesisId}/challenge`)).statusCode).toBe(401);
  });

  it("is refused with 402 GLOBAL_CEILING when the global ceiling is reached: no call, nothing stored, nothing charged", async () => {
    spent = 5;
    prompts.length = 0;
    const n0 = (await q("SELECT count(*)::int AS n FROM thesis_challenges")).rows[0].n;
    const r = await challenge(alice);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ errorCode: "BUDGET_EXCEEDED", reasonCode: "GLOBAL_CEILING" });
    expect(prompts).toHaveLength(0);
    expect((await q("SELECT count(*)::int AS n FROM thesis_challenges")).rows[0].n).toBe(n0);
    spent = 0;
  });
});

describe("answers, visibility and the public route", () => {
  let cid: string;
  it("only the owning organisation answers: editor and above, wording checked, once", async () => {
    outputs = { notes: [note(GOOD, "window", "material", ["verdict"])] };
    cid = (await challenge(alice)).json<{ challengeId: string }>().challengeId;
    const url = `/v1/theses/${thesisId}/challenges/${cid}/answer`;
    expect((await post(vera, url, { text: "We checked it." })).statusCode).toBe(403);
    expect((await post(bob, url, { text: "We checked it." })).statusCode).toBe(404);
    expect((await post(alice, url, { text: "   " })).statusCode).toBe(422);
    expect((await post(alice, url, { text: "x".repeat(601) })).statusCode).toBe(422);
    const bad = await post(alice, url, { text: "The volume causes the swaps." });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ reasonCode: "ANSWER_WORDING_REJECTED" });
    expect(
      (await post(alice, `/v1/theses/${thesisId}/challenges/${randomUUID()}/answer`, { text: "ok" }))
        .statusCode,
    ).toBe(404);
    const ok = await post(alice, url, { text: "The window is fixed by the plan; a longer one is queued." });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      challengeId: cid,
      answer: "The window is fixed by the plan; a longer one is queued.",
      answeredAt: expect.any(String),
    });
    const again = await post(alice, url, { text: "Another." });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ reasonCode: "CHALLENGE_ALREADY_ANSWERED" });
    expect(
      (await post(alice, `/v1/theses/reference-near-intents/challenges/${cid}/answer`, { text: "ok" }))
        .statusCode,
    ).toBe(422);
  });

  it("an unavailable challenge cannot be answered", async () => {
    fail = true;
    const id = (await challenge(alice)).json<{ challengeId: string }>().challengeId;
    fail = false;
    const r = await post(alice, `/v1/theses/${thesisId}/challenges/${id}/answer`, { text: "ok" });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ reasonCode: "CHALLENGE_NOT_ANSWERABLE" });
  });

  it("summaries carry strength; detail carries strength, challenges and receipts.challenged; the answer restores the points", async () => {
    const d = (await get(alice, `/v1/theses/${thesisId}`)).json<{
      thesis: {
        strength: { score: number; band: string; parts: Array<{ key: string; points: number }> };
        receipts: { challenged: number };
      };
      challenges: Array<{ challengeId: string; answer: string | null }>;
    }>();
    expect(d.thesis.strength.parts).toHaveLength(10);
    expect(d.challenges.length).toBeLessThanOrEqual(10);
    expect(d.challenges.find((c) => c.challengeId === cid)!.answer).toContain("window is fixed");
    expect(d.thesis.receipts.challenged).toBeGreaterThanOrEqual(4);
    const list = (await get(alice, "/v1/theses")).json<{
      items: Array<{ id: string; strength: { score: number } }>;
    }>();
    expect(list.items.every((i) => typeof i.strength.score === "number")).toBe(true);
    expect(list.items[0]!.id).toBe("reference-near-intents");
  });

  it("an unanswered material challenge costs the strength its 5 points; the owner's answer restores them", async () => {
    outputs = { notes: [note(GOOD, "window", "material", ["verdict"])] };
    const id = (await challenge(alice, publicId)).json<{ challengeId: string }>().challengeId;
    const pts = async () =>
      (await get(alice, `/v1/theses/${publicId}`))
        .json<{ thesis: { strength: { parts: Array<{ key: string; points: number }> } } }>()
        .thesis.strength.parts.find((p) => p.key === "challenges_answered")!.points;
    expect(await pts()).toBe(0);
    expect(
      (
        await post(alice, `/v1/theses/${publicId}/challenges/${id}/answer`, {
          text: "Noted; the window is fixed by the plan.",
        })
      ).statusCode,
    ).toBe(200);
    expect(await pts()).toBe(5);
  });

  it("the public route shows the challenges and strength read-only, without ids", async () => {
    const r = await get(null, `/v1/public/theses/${SLUG}`);
    expect(r.statusCode).toBe(200);
    const b = r.json<{
      thesis: { strength: { parts: unknown[] } };
      challenges: Array<Record<string, unknown>>;
      receipts: { challenged: number };
    }>();
    expect(b.thesis.strength.parts).toHaveLength(10);
    expect(b.challenges).toHaveLength(1);
    expect(Object.keys(b.challenges[0]!).sort()).toEqual([
      "answer",
      "answeredAt",
      "by",
      "challengeId",
      "cost",
      "createdAt",
      "droppedNotes",
      "notes",
      "outcome",
    ]);
    expect(b.receipts.challenged).toBe(1);
    // no challenge route works without a session
    expect(
      (await post(null, `/v1/theses/${publicId}/challenges/${randomUUID()}/answer`, { text: "x" }))
        .statusCode,
    ).toBe(401);
    expect((await get(null, `/v1/theses/${publicId}/challenges`)).statusCode).toBe(401);
    // an unpublished (draft) thesis shows nothing publicly
    expect((await get(null, "/v1/public/theses/zzzzzzzzzzzz0123456789")).statusCode).toBe(404);
  });

  it("a published thesis is visible to other tenants only through the public route, and a draft not at all", async () => {
    expect((await get(carol, `/v1/theses/${thesisId}/challenges`)).statusCode).toBe(404);
    expect((await get(bob, `/v1/theses/${thesisId}`)).statusCode).toBe(404);
  });
});

describe("credits", () => {
  it("is refused with 402 CREDITS_EXHAUSTED once the credits are used up, before any model call", async () => {
    const { UsdCreditsService } = await import("@nearesis/kernel");
    const ownerId = (await q("SELECT id FROM users WHERE oidc_subject LIKE '%alice%' LIMIT 1")).rows[0]
      .id as string;
    const orgId = (await q("SELECT org_id FROM theses WHERE id = $1", [thesisId])).rows[0].org_id as string;
    const svc = new UsdCreditsService(f.db.app);
    const left = await svc.account({ orgId, userId: ownerId });
    await svc.charge({ orgId, userId: ownerId }, left.availableMicro, {
      refKind: "run",
      refId: "drain",
      category: "model",
    });
    prompts.length = 0;
    const r = await challenge(alice);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({
      errorCode: "BUDGET_EXCEEDED",
      reasonCode: "CREDITS_EXHAUSTED",
      details: { availableUsd: "0.000000" },
    });
    expect(prompts).toHaveLength(0);
  });
});
