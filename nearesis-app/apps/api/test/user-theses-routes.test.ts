import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyticsPanelData } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { PanelDataPort, StoredQuery } from "../src/panel-data.ts";

const day = (i: number): string =>
  new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
const wave = (i: number): number => 1000 + i * 10 + Math.round(40 * Math.sin(i / 3));
const H = (c: string) => c.repeat(64);

const body = (hash: string, columns: string[], rows: unknown[][]): AnalyticsPanelData =>
  ({
    chart: {
      queryHash: hash,
      dataRevision: 1,
      columns: columns.map((name) => ({ name, unit: name === "period" ? null : "unit" })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness: "fresh",
      sourceWatermark: "2026-11-12",
    },
    shape: {
      queryHash: hash,
      fields: columns.map((name, i) => ({ name, unit: null, role: i === 0 ? "time" : "measure" })),
    },
    provenance: {
      queryHash: hash,
      sourceLabel: "ANALYTICS",
      certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
      capability: "intents.analyze@1",
      analysis: "trend",
      call: { capability: "intents.analyze@1", input: { analysis: "trend" } },
      resultHash: "c".repeat(64),
      sources: ["nearesis_live.intents_swaps"],
      metricVersion: "intents-1.0.0",
      definition: "d",
      method: "m",
      asOf: "2026-11-12",
      computedAt: "2026-11-13T00:00:00.000Z",
      coverage: {
        state: "complete",
        daysRequested: 70,
        daysWithData: 70,
        missingDays: [],
        incompleteDays: [],
      },
      caveats: [],
    },
    cannotCompute: null,
    truncated: false,
  }) as unknown as AnalyticsPanelData;

const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
const PANELS: Record<string, AnalyticsPanelData> = {
  [H("a")]: body(
    H("a"),
    ["period", "swaps"],
    idx(70).map((i) => [day(i), wave(i)]),
  ),
  [H("b")]: body(
    H("b"),
    ["period", "volumeUsd"],
    idx(70).map((i) => [day(i), 5000 + 3 * wave(i) + (i % 3)]),
  ),
  // the same y with a small revision: same verdict, same window, different numbers
  [H("c")]: body(
    H("c"),
    ["period", "volumeUsd"],
    idx(70).map((i) => [day(i), 5000 + 3 * wave(i) + (i % 3) + (i === 69 ? 7 : 0)]),
  ),
  [H("d")]: body(
    H("d"),
    ["period", "newWallets"],
    idx(70).map((i) => [day(i), 500 + ((i * 37) % 17) * 20]),
  ),
  [H("e")]: body(
    H("e"),
    ["period", "swaps"],
    idx(12).map((i) => [day(i), 100 + i * 3 + (i % 4)]),
  ),
  [H("f")]: body(
    H("f"),
    ["period", "rate"],
    idx(12).map((i) => [day(i), (0.02 + (i % 5) * 0.001).toFixed(3)]),
  ),
  [H("g")]: body(
    H("g"),
    ["period", "swaps"],
    idx(12).map((i) => [day(i), 100 + i]),
  ),
};
// per-test overrides of what the "data service" answers now (a correction, another series, an outage)
const NOW: Record<string, AnalyticsPanelData> = {};
const DOWN = new Set<string>();
const fakePort: PanelDataPort = {
  async stored(hash): Promise<StoredQuery | null> {
    return PANELS[hash] ? { kind: "analytics", ast: { kind: "analytics_call" } } : null;
  },
  async query() {
    throw new Error("not used");
  },
  async estimate() {
    throw new Error("not used");
  },
  registry: () => {
    throw new Error("not used");
  },
  async analytics(hash) {
    if (DOWN.has(hash))
      return { status: 503, body: { reasonCode: "SOURCE_UNAVAILABLE", message: "down" } } as never;
    return { status: 200, body: NOW[hash] ?? PANELS[hash]! };
  },
  async close() {},
};

let f: ApiFixture;
let root: string;
let orgA: string;
let aliceId: string;
let wsA: string;
let wsB: string;
let wsC: string;
let alice: string;
let vera: string;
let bob: string;
let runSupported: string;
let runNot: string;
let runOne: string;
let runIncomplete: string;
const post = (tok: string | null, url: string, payload: unknown = {}) =>
  f.app.inject({ method: "POST", url, headers: tok ? bearer(tok) : {}, payload: payload as object });
const get = (tok: string | null, url: string) => f.app.inject({ url, headers: tok ? bearer(tok) : {} });

async function seedRun(
  orgId: string,
  workspaceId: string,
  hashes: string[],
  o: { state?: string; findings?: boolean } = {},
) {
  const runId = randomUUID();
  const budgetId = randomUUID();
  const q = (s: string, p: unknown[]) => f.db.admin.query(s, p);
  await q(
    "INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000,10,2)",
    [budgetId, orgId, workspaceId],
  );
  await q(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, source)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,'live')`,
    [runId, orgId, workspaceId, randomUUID(), randomUUID(), budgetId, `wf-${runId}`, o.state ?? "COMPLETE"],
  );
  await q(
    `INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, objective, result)
     VALUES ($1,$2,$3,$4,'composer',1,$5,'{}'::jsonb,'h1','DONE','Do swaps follow volume?',$6)`,
    [
      randomUUID(),
      orgId,
      workspaceId,
      runId,
      randomUUID(),
      JSON.stringify({
        result: {
          proposal: {
            patch: {
              operations: hashes.map((h, i) => ({
                op: "addPanel",
                panel: {
                  panelId: randomUUID(),
                  title: `Panel ${i}`,
                  queryRef: { hash: h, resultKind: "analytics_result" },
                },
              })),
            },
          },
        },
      }),
    ],
  );
  await q(
    "INSERT INTO runtime.run_interpretation(run_id, tenant_id, workspace_id, state, finding_count) VALUES ($1,$2,$3,$4,$5)",
    [runId, orgId, workspaceId, "ready", 2],
  );
  const fin = (status: string, statement: string, notes: string[]) =>
    JSON.stringify({
      id: randomUUID(),
      workspaceId,
      runId,
      agentRole: "analyst",
      status,
      kind: "change",
      basis: "observation",
      statement,
      facts: [
        {
          value: String(wave(0)),
          unit: "swaps",
          resultRef: {
            column: "swaps",
            rowIds: [day(0)],
            queryHash: hashes[0],
            semanticVersion: "intents-1.0.0",
          },
        },
        {
          value: String(wave(69)),
          unit: "swaps",
          resultRef: {
            column: "swaps",
            rowIds: [day(69)],
            queryHash: hashes[0],
            semanticVersion: "intents-1.0.0",
          },
        },
      ],
      limitations: ["The window was chosen by the planner."],
      panelIds: [],
      skepticNotes: notes,
      skepticDegraded: false,
      createdAt: new Date().toISOString(),
    });
  if (o.findings !== false) {
    await q(
      "INSERT INTO runtime.run_findings(id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,0,$5)",
      [
        randomUUID(),
        orgId,
        workspaceId,
        runId,
        fin("supported", `Daily swaps rose from ${wave(0)} to ${wave(69)} over the window.`, [
          "The rise could reflect one event.",
        ]),
      ],
    );
    await q(
      "INSERT INTO runtime.run_findings(id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,1,$5)",
      [
        randomUUID(),
        orgId,
        workspaceId,
        runId,
        fin("mixed", `Swaps peaked at ${wave(69)} on ${day(69)}.`, ["A single peak can be a one-off."]),
      ],
    );
  }
  return runId;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "thesis-caps-"));
  process.env.NEARESIS_CAPSULE_DIR = root;
  f = await apiFixture({
    runtime: true,
    appOptions: { frontend: { panelData: fakePort, capsuleRoot: () => root } },
  });
  const a = await seedOrg(f.db.admin, "th-a", { alice: "owner", vera: "viewer" });
  const b = await seedOrg(f.db.admin, "th-b", { bob: "owner" });
  orgA = a.orgId;
  aliceId = a.users.alice!.userId;
  alice = await login(f.app, a.users.alice!.subject);
  vera = await login(f.app, a.users.vera!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
  wsA = await mk(alice, "th-ws-000000001");
  wsB = await mk(alice, "th-ws-000000002");
  wsC = await mk(alice, "th-ws-000000003");
  runSupported = await seedRun(orgA, wsA, [H("a"), H("b")]);
  await seedRun(orgA, wsB, [H("e"), H("f")]);
  runNot = await seedRun(orgA, wsC, [H("a"), H("d")]);
  runOne = await seedRun(orgA, wsA, [H("g")]);
  runIncomplete = await seedRun(orgA, wsA, [H("a"), H("b")], { state: "EXECUTING" });
}, 180_000);
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  await f?.close();
  rmSync(root, { recursive: true, force: true });
});

let thesisId = "";
let version = "";
let slug = "";

describe("build", () => {
  it("builds a draft thesis from a run (201) and a repeat with unchanged inputs returns the same version", async () => {
    // a hypothesis in the workspace is picked up
    const h = await post(alice, `/v1/workspaces/${wsA}/hypotheses`, {
      proposition: "Daily swaps move together with volume over the window.",
      target: "swaps",
      predictor: "volumeUsd",
      benchmark: "no change",
      falsification: "Rejected if the same-day correlation stays below 0.2.",
    });
    expect(h.statusCode, h.body).toBe(201);
    const r = await post(alice, `/v1/workspaces/${wsA}/theses`, { runId: runSupported });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({ status: "draft", verdict: { status: "SUPPORTED" } });
    expect(b.version).toMatch(/^v-[0-9a-f]{12}$/);
    expect(b.verdict.headline).toMatch(/^SUPPORTED: /);
    thesisId = b.thesisId;
    version = b.version;
    const again = await post(alice, `/v1/workspaces/${wsA}/theses`, { runId: runSupported });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ thesisId, version });
    // an empty body picks the newest COMPLETE run with a ready interpretation (runOne is the newest, but not capsulable)
    const empty = await post(alice, `/v1/workspaces/${wsB}/theses`, {});
    expect(empty.statusCode, empty.body).toBe(201);
    expect(empty.json().verdict.status).toBe("INSUFFICIENT_DATA");
  });

  it("the stored document is the contract's shape", async () => {
    const r = (await get(alice, `/v1/theses/${thesisId}`)).json();
    expect(r.thesis).toMatchObject({
      id: thesisId,
      kind: "workspace",
      workspaceId: wsA,
      version,
      status: "draft",
      shareSlug: null,
      verdict: { status: "SUPPORTED" },
      receipts: { verified: 0, reproduced: 0, drift: 0 },
    });
    expect(r.thesis.hypothesis).toBe(
      "Swaps and volume usd are systematically related from day to day, in either direction.",
    );
    const d = r.doc;
    expect(d.schema).toBe("nearesis.thesis.v1");
    expect(d.sections.map((s: { id: string }) => s.id)).toHaveLength(14);
    expect(d.origin).toMatchObject({
      kind: "workspace",
      workspaceId: wsA,
      runId: runSupported,
      hypothesisStatus: "draft",
      question: "Do swaps follow volume?",
    });
    expect(d.origin.capsuleId).toMatch(/^cap-wsrun-/);
    expect(d.test).toMatchObject({ rule: "relationship-v2", n: 70 });
    expect(d.verdict.comparison.rows.length).toBeGreaterThan(3);
    expect(d.charts).toHaveLength(2);
    expect(d.charts[0].queries[0].sqlExecuted).toContain("executed query of panel");
    const ev = d.sections.find((s: { id: string }) => s.id === "evidence-against").markdown;
    expect(ev).toContain("> Skeptic note: A single peak can be a one-off.");
    expect(d.sections[1].markdown).toContain("would give NOT_SUPPORTED");
    expect(d.verification.capsule.status).toBe("reproduced");
  });

  it("errors: not capsulable, not complete, viewer, other org, no session, bad body", async () => {
    const one = await post(alice, `/v1/workspaces/${wsA}/theses`, { runId: runOne });
    expect(one.statusCode).toBe(422);
    expect(one.json().reasonCode).toBe("RUN_NOT_CAPSULABLE");
    expect(
      (await post(alice, `/v1/workspaces/${wsA}/theses`, { runId: runIncomplete })).json().reasonCode,
    ).toBe("RUN_NOT_COMPLETE");
    expect((await post(vera, `/v1/workspaces/${wsA}/theses`, { runId: runSupported })).statusCode).toBe(403);
    expect((await post(bob, `/v1/workspaces/${wsA}/theses`, { runId: runSupported })).statusCode).toBe(404);
    expect((await post(null, `/v1/workspaces/${wsA}/theses`, {})).statusCode).toBe(401);
    expect((await post(alice, `/v1/workspaces/${wsA}/theses`, { runId: "nope" })).statusCode).toBe(422);
  });
});

describe("list and read", () => {
  it("lists the pinned reference first, then the caller's own; another org sees none of them", async () => {
    const mine = (await get(alice, "/v1/theses")).json().items;
    expect(mine[0]).toMatchObject({
      id: "reference-near-intents",
      kind: "reference",
      workspaceId: null,
      status: "published",
    });
    expect(mine[0].verdict.status).toBeTruthy();
    expect(mine.map((x: { id: string }) => x.id)).toContain(thesisId);
    const theirs = (await get(bob, "/v1/theses")).json().items;
    expect(theirs.map((x: { id: string }) => x.id)).toEqual(["reference-near-intents"]);
    expect((await get(bob, `/v1/theses/${thesisId}`)).statusCode).toBe(404);
    expect((await get(bob, `/v1/theses/${thesisId}/receipts`)).statusCode).toBe(404);
    expect((await get(bob, `/v1/theses/${thesisId}/files/THESIS.md`)).statusCode).toBe(404);
    expect((await get(null, "/v1/theses")).statusCode).toBe(401);
    expect((await get(alice, "/v1/theses/not-a-uuid")).statusCode).toBe(404);
  });

  it("the reference thesis is readable by everyone with origin.kind reference, and /v1/thesis still works", async () => {
    const r = await get(bob, "/v1/theses/reference-near-intents");
    expect(r.statusCode).toBe(200);
    expect(r.json().doc.origin).toEqual({ kind: "reference" });
    expect(r.json().doc.verdict.intentsVsPrice).toBeTruthy();
    expect((await get(bob, "/v1/thesis")).statusCode).toBe(200);
    const md = await get(bob, "/v1/theses/reference-near-intents/files/THESIS.md");
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain("## Executive claim");
  });

  it("serves THESIS.md rendered from the document", async () => {
    const md = await get(alice, `/v1/theses/${thesisId}/files/THESIS.md`);
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("## Executive claim");
    expect(md.body).toContain("## Changes since previous version");
    const doc = (await get(alice, `/v1/theses/${thesisId}`)).json().doc;
    expect(md.headers["x-thesis-sha256"]).toBe(
      doc.files.find((x: { path: string }) => x.path === "THESIS.md").sha256,
    );
    expect((await get(alice, `/v1/theses/${thesisId}/files/nope.txt`)).statusCode).toBe(404);
  });
});

describe("publish, public read, import", () => {
  it("publish needs an editor in the owning organisation", async () => {
    expect((await post(vera, `/v1/theses/${thesisId}/publish`)).statusCode).toBe(403);
    expect((await post(bob, `/v1/theses/${thesisId}/publish`)).statusCode).toBe(404);
    expect((await post(alice, "/v1/theses/reference-near-intents/publish")).statusCode).toBe(422);
    const r = await post(alice, `/v1/theses/${thesisId}/publish`);
    expect(r.statusCode, r.body).toBe(200);
    slug = r.json().shareSlug;
    expect(slug).toMatch(/^[a-z0-9]{20}$/);
    expect(r.json().publicUrlPath).toBe(`/t/${slug}`);
    const again = await post(alice, `/v1/theses/${thesisId}/publish`);
    expect(again.json().shareSlug).toBe(slug);
  });

  it("the public route needs no token and exposes no organisation, workspace or user ids", async () => {
    const r = await get(null, `/v1/public/theses/${slug}`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.thesis).toMatchObject({
      title: expect.any(String),
      verdict: { status: "SUPPORTED" },
      status: "published",
      shareSlug: slug,
    });
    expect(b.doc.origin).toMatchObject({ workspaceId: null, runId: null, hypothesisId: null });
    expect(b.receipts).toEqual({
      verified: 0,
      reproduced: 0,
      drift: 0,
      different: 0,
      incomplete: 0,
      mismatch: 0,
      challenged: 0,
    });
    const text = r.body;
    for (const id of [orgA, wsA, aliceId, runSupported]) expect(text).not.toContain(id);
    expect(text).not.toContain("ownerUserId");
    const md = await get(null, `/v1/public/theses/${slug}/files/THESIS.md`);
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain("## Verdict per claim");
    for (const id of [orgA, wsA, aliceId]) expect(md.body).not.toContain(id);
    const series = await get(null, `/v1/public/theses/${slug}/files/data/daily_series.csv`);
    expect(series.statusCode).toBe(200);
    expect(series.body.split("\n")[0]).toBe("date,x_value,y_value");
    expect((await get(null, `/v1/public/theses/${slug}/files/data/run-panels.json`)).statusCode).toBe(404);
    expect((await get(null, `/v1/public/theses/${"x".repeat(20)}`)).statusCode).toBe(404);
    expect((await get(null, "/v1/public/theses/short")).statusCode).toBe(404);
  });

  it("import is idempotent, gives access to the document without the workspace id, and keeps working after unpublish", async () => {
    expect((await post(null, "/v1/theses/import", { slug })).statusCode).toBe(401);
    expect((await post(bob, "/v1/theses/import", { slug: "x".repeat(20) })).statusCode).toBe(404);
    const first = await post(bob, "/v1/theses/import", { slug });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      thesisId,
      created: true,
      thesis: { kind: "imported", workspaceId: null },
    });
    const second = await post(bob, "/v1/theses/import", { slug });
    expect(second.json()).toMatchObject({ thesisId, created: false });
    const list = (await get(bob, "/v1/theses")).json().items;
    expect(list.filter((x: { id: string }) => x.id === thesisId)).toHaveLength(1);
    const read = (await get(bob, `/v1/theses/${thesisId}`)).json();
    expect(read.thesis.kind).toBe("imported");
    expect(read.doc.origin).toMatchObject({ workspaceId: null, question: "Do swaps follow volume?" });
    // an importer is not an editor of someone else's thesis
    expect((await post(bob, `/v1/theses/${thesisId}/publish`)).statusCode).toBe(404);
    // the owner importing their own thesis changes nothing
    expect((await post(alice, "/v1/theses/import", { slug })).json()).toMatchObject({ created: false });
  });

  it("verify works for the owner and for an importer, and records receipts that the public route counts", async () => {
    const a = await post(alice, `/v1/theses/${thesisId}/verify`);
    expect(a.statusCode, a.body).toBe(200);
    const av = a.json();
    expect(av.outcome, JSON.stringify(av.checks)).toBe("verified");
    const names = av.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "documentHash",
        "capsuleIdentity",
        "capsuleReverification",
        "testNumbers",
        "outlayerProof",
      ]),
    );
    expect(names.filter((n: string) => n.startsWith("chart:"))).toHaveLength(2);
    expect(av.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    const b = await post(bob, `/v1/theses/${thesisId}/verify`);
    expect(b.json().outcome).toBe("verified");
    expect((await post(null, `/v1/theses/${thesisId}/verify`)).statusCode).toBe(401);
    const pub = (await get(null, `/v1/public/theses/${slug}`)).json();
    expect(pub.receipts).toMatchObject({ verified: 2, drift: 0 });
    const rec = (await get(alice, `/v1/theses/${thesisId}/receipts`)).json();
    expect(rec.counts.verified).toBe(2);
    expect(rec.receipts).toHaveLength(2);
    expect(rec.receipts[0]).toMatchObject({ kind: "verify", outcome: "verified" });
    const list = (await get(alice, "/v1/theses")).json().items.find((x: { id: string }) => x.id === thesisId);
    expect(list.receipts.verified).toBe(2);
  });

  it("unpublish withdraws the link (identical 404) and republish keeps the slug", async () => {
    expect((await post(alice, `/v1/theses/${thesisId}/unpublish`)).json()).toMatchObject({
      status: "unpublished",
    });
    const gone = await get(null, `/v1/public/theses/${slug}`);
    expect(gone.statusCode).toBe(404);
    const unknown = await get(null, `/v1/public/theses/${"y".repeat(20)}`);
    expect(unknown.json().reasonCode).toBe(gone.json().reasonCode);
    expect((await post(bob, "/v1/theses/import", { slug })).statusCode).toBe(404);
    expect((await get(bob, `/v1/theses/${thesisId}`)).statusCode).toBe(200);
    expect((await post(alice, `/v1/theses/${thesisId}/publish`)).json().shareSlug).toBe(slug);
    expect((await get(null, `/v1/public/theses/${slug}`)).statusCode).toBe(200);
  });
});

describe("verify detects tampering", () => {
  it("a tampered document is a mismatch on the document hash", async () => {
    const r = await post(alice, `/v1/workspaces/${wsB}/theses`, {});
    const id = r.json().thesisId as string;
    await f.db.admin.query(
      "UPDATE theses SET doc = jsonb_set(doc, '{test,pearson}', '\"0.999999\"') WHERE id = $1",
      [id],
    );
    const v = (await post(alice, `/v1/theses/${id}/verify`)).json();
    expect(v.outcome).toBe("mismatch");
    const failed = v.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name);
    expect(failed).toContain("documentHash");
    expect(failed).toContain("testNumbers");
    const rec = (await get(alice, `/v1/theses/${id}/receipts`)).json();
    expect(rec.receipts[0]).toMatchObject({ kind: "verify", outcome: "mismatch" });
    expect(rec.counts.mismatch).toBe(1);
    expect(rec.counts.drift).toBe(0);
  });

  it("a tampered capsule file is a mismatch on the capsule re-verification", async () => {
    const r = await post(alice, `/v1/workspaces/${wsC}/theses`, { runId: runNot });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().verdict.status).toBe("NOT_SUPPORTED");
    const id = r.json().thesisId as string;
    const doc = (await get(alice, `/v1/theses/${id}`)).json().doc;
    expect((await post(alice, `/v1/theses/${id}/verify`)).json().outcome).toBe("verified");
    appendFileSync(
      join(root, doc.origin.capsuleId, "snapshot", "raw", "daily_series.csv"),
      "2099-01-01,1,1\n",
    );
    const v = (await post(alice, `/v1/theses/${id}/verify`)).json();
    expect(v.outcome).toBe("mismatch");
    expect(v.checks.find((c: { name: string }) => c.name === "capsuleReverification").ok).toBe(false);
  });
});

describe("OutLayer proof state", () => {
  it("a verified proof bound to the capsule is recorded in the document and re-checked by verify; a changed binding is a mismatch", async () => {
    const wsF = (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(alice), "idempotency-key": "th-ws-000000006" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
    const run = await seedRun(orgA, wsF, [H("a"), H("b")]);
    const cap = await post(alice, `/v1/workspaces/${wsF}/capsules`, { runId: run });
    expect(cap.statusCode, cap.body).toBe(201);
    const capsuleId = cap.json().capsuleId as string;
    const m = JSON.parse(readFileSync(join(root, capsuleId, "manifest.json"), "utf8")) as {
      computation: { inputFile: { sha256: string }; resultsSha256: string; verifier: { wasmSha256: string } };
    };
    await f.db.admin.query(
      `INSERT INTO outlayer_proofs(id, org_id, workspace_id, capsule_id, requested_by, state, request_id, tx_hash, wasm_sha256, input_sha256, output_sha256, decision, held_yocto)
       VALUES ($1,$2,$3,$4,$5,'verified','777','TXTEST',$6,$7,$8,'accept',0)`,
      [
        randomUUID(),
        orgA,
        wsF,
        capsuleId,
        aliceId,
        m.computation.verifier.wasmSha256,
        m.computation.inputFile.sha256,
        m.computation.resultsSha256,
      ],
    );
    const t = await post(alice, `/v1/workspaces/${wsF}/theses`, { runId: run });
    const id = t.json().thesisId as string;
    const doc = (await get(alice, `/v1/theses/${id}`)).json().doc;
    expect(doc.verification.outlayer).toEqual({ status: "verified", requestId: "777", txHash: "TXTEST" });
    expect(doc.unableToCompute.some((u: { what: string }) => u.what === "OutLayer attestation")).toBe(false);
    const ok = (await post(alice, `/v1/theses/${id}/verify`)).json();
    expect(ok.outcome, JSON.stringify(ok.checks)).toBe("verified");
    expect(ok.checks.find((c: { name: string }) => c.name === "outlayerProof").detail).toMatch(
      /bound to this capsule/,
    );
    await f.db.admin.query("UPDATE outlayer_proofs SET input_sha256 = $2 WHERE capsule_id = $1", [
      capsuleId,
      "0".repeat(64),
    ]);
    const bad = (await post(alice, `/v1/theses/${id}/verify`)).json();
    expect(bad.outcome).toBe("mismatch");
    expect(bad.checks.find((c: { name: string }) => c.name === "outlayerProof").ok).toBe(false);
  });
});

describe("compare and the reference thesis", () => {
  let reproA = "";
  it("an identical reproduction matches; the receipt lands on the ORIGINAL", async () => {
    // a second workspace with a run over the same stored results: the same numbers
    const wsD = (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(alice), "idempotency-key": "th-ws-000000004" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
    const run = await seedRun(orgA, wsD, [H("a"), H("b")]);
    const rep = await post(alice, `/v1/workspaces/${wsD}/theses`, { runId: run });
    expect(rep.statusCode, rep.body).toBe(201);
    reproA = rep.json().thesisId;
    const c = await post(alice, `/v1/theses/${reproA}/compare`, { against: thesisId });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().outcome).toBe("match");
    expect(c.json().rows.find((r: { what: string }) => r.what === "verdict")).toMatchObject({
      original: "SUPPORTED",
      reproduced: "SUPPORTED",
    });
    const rec = (await get(alice, `/v1/theses/${thesisId}/receipts`)).json();
    expect(rec.counts.reproduced).toBe(1);
    expect(
      rec.receipts.some(
        (x: { kind: string; outcome: string }) => x.kind === "reproduce" && x.outcome === "match",
      ),
    ).toBe(true);
    expect((await get(alice, `/v1/theses/${reproA}`)).json().thesis.sourceThesisId).toBe(thesisId);
    expect((await post(alice, `/v1/theses/${reproA}/compare`, { against: reproA })).statusCode).toBe(422);
    expect((await post(bob, `/v1/theses/${reproA}/compare`, { against: thesisId })).statusCode).toBe(404);
  });

  it("a revised number is drift; another verdict is different", async () => {
    const wsE = (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(alice), "idempotency-key": "th-ws-000000005" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
    const run = await seedRun(orgA, wsE, [H("a"), H("c")]);
    const rep = await post(alice, `/v1/workspaces/${wsE}/theses`, { runId: run });
    expect(rep.json().verdict.status).toBe("SUPPORTED");
    const c = await post(alice, `/v1/theses/${rep.json().thesisId}/compare`, { against: thesisId });
    expect(c.json().outcome).toBe("drift");
    expect(
      c.json().rows.some((r: { delta: string | null }) => r.delta !== null && Number(r.delta) !== 0),
    ).toBe(true);
    const wsC2 = (await get(alice, "/v1/theses"))
      .json()
      .items.find((x: { workspaceId: string }) => x.workspaceId === wsC);
    const d = await post(alice, `/v1/theses/${wsC2.id}/compare`, { against: thesisId });
    expect(d.json().outcome).toBe("different");
    const rec = (await get(alice, `/v1/theses/${thesisId}/receipts`)).json();
    expect(rec.counts.drift).toBeGreaterThanOrEqual(1);
  });

  it("verify of the reference thesis is the bundle hash check", async () => {
    const v = await post(alice, "/v1/theses/reference-near-intents/verify");
    expect(v.statusCode, v.body).toBe(200);
    const names = v.json().checks.map((c: { name: string }) => c.name);
    expect(names).toContain("output:build/THESIS.md");
    expect(names.some((n: string) => n.startsWith("input:thesis/raw/"))).toBe(true);
    expect(v.json().outcome, JSON.stringify(v.json().checks.filter((c: { ok: boolean }) => !c.ok))).toBe(
      "verified",
    );
    const ref = (await get(bob, "/v1/theses")).json().items[0];
    expect(ref.receipts.verified).toBeGreaterThanOrEqual(1);
    // compare a workspace thesis with the reference: a receipt on the reference
    const c = await post(alice, `/v1/theses/${thesisId}/compare`, { against: "reference-near-intents" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().outcome).toBe("different");
  });
});

describe("rerun: reproduction by re-executing the stored queries", () => {
  const rerun = (tok: string | null, id: string) => post(tok, `/v1/theses/${id}/rerun`);
  const asHash = (src: string, hash: string): AnalyticsPanelData => {
    const p = JSON.parse(JSON.stringify(PANELS[src])) as AnalyticsPanelData;
    (p.chart as { queryHash: string }).queryHash = hash;
    return p;
  };
  const clear = () => {
    for (const k of Object.keys(NOW)) delete NOW[k];
    DOWN.clear();
  };
  afterAll(clear);

  it("unchanged data is a match with the stored window, and nothing about the original workspace is needed", async () => {
    const r = await rerun(alice, thesisId);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(
      b.outcome,
      JSON.stringify(
        b.rows.filter((x: { original: string; reproduced: string }) => x.original !== x.reproduced),
      ),
    ).toBe("match");
    expect(b.unavailable).toEqual([]);
    expect(b.reran).toMatchObject({ charts: 2, queries: 2, window: { from: day(0), to: day(69) } });
    expect(Date.parse(b.reran.at)).not.toBeNaN();
    expect(b.rows.find((x: { what: string }) => x.what === "verdict")).toMatchObject({
      original: "SUPPORTED",
      reproduced: "SUPPORTED",
    });
    expect(b.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a corrected value is drift (same verdict and n)", async () => {
    NOW[H("b")] = asHash(H("c"), H("b"));
    const b = (await rerun(alice, thesisId)).json();
    clear();
    expect(b.outcome).toBe("drift");
    expect(b.rows.some((x: { delta: string | null }) => x.delta !== null && Number(x.delta) !== 0)).toBe(
      true,
    );
  });

  it("another verdict is different", async () => {
    // another series under the same column name: the verdict moves
    NOW[H("b")] = {
      ...asHash(H("d"), H("b")),
      chart: {
        ...PANELS[H("d")]!.chart,
        queryHash: H("b"),
        columns: PANELS[H("b")]!.chart.columns,
      },
    } as AnalyticsPanelData;
    const b = (await rerun(alice, thesisId)).json();
    clear();
    expect(b.outcome).toBe("different");
    expect(b.rows.find((x: { what: string }) => x.what === "verdict").reproduced).not.toBe("SUPPORTED");
  });

  it("a query that cannot run makes the outcome incomplete, with the reason, and nothing is guessed", async () => {
    DOWN.add(H("b"));
    const b = (await rerun(alice, thesisId)).json();
    clear();
    expect(b.outcome).toBe("incomplete");
    expect(b.unavailable).toEqual(
      expect.arrayContaining([{ chart: "Panel 1", reason: "SOURCE_UNAVAILABLE" }]),
    );
    expect(b.rows.every((x: { what: string }) => x.what !== "verdict")).toBe(true);
    expect(b.rows.some((x: { what: string }) => x.what.startsWith("Panel 0"))).toBe(true);
  });

  it("the reference thesis is offline (422 with the commands); an invisible thesis is a 404; no session is 401", async () => {
    const ref = await rerun(alice, "reference-near-intents");
    expect(ref.statusCode).toBe(422);
    expect(ref.json().reasonCode).toBe("REFERENCE_THESIS_OFFLINE");
    expect(ref.json().details.commands.length).toBeGreaterThan(0);
    const hidden = (await get(alice, "/v1/theses"))
      .json()
      .items.find((x: { workspaceId: string }) => x.workspaceId === wsC);
    expect((await rerun(bob, hidden.id)).statusCode).toBe(404);
    expect((await rerun(alice, "not-a-uuid")).statusCode).toBe(404);
    expect((await rerun(null, thesisId)).statusCode).toBe(401);
  });

  it("an importer in another organisation can rerun a published thesis, and the receipts are counted per outcome", async () => {
    const b = await rerun(bob, thesisId);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().outcome).toBe("match");
    const rec = (await get(alice, `/v1/theses/${thesisId}/receipts`)).json();
    const count = (kind: string, outcome: string): number =>
      rec.receipts.filter((x: { kind: string; outcome: string }) => x.kind === kind && x.outcome === outcome)
        .length;
    expect(rec.counts).toEqual({
      verified: count("verify", "verified"),
      reproduced: count("reproduce", "match"),
      drift: count("reproduce", "drift"),
      different: count("reproduce", "different"),
      incomplete: count("reproduce", "incomplete"),
      mismatch: count("verify", "mismatch"),
      challenged: 0,
    });
    expect(rec.counts.incomplete).toBe(1);
    expect(rec.counts.different).toBeGreaterThanOrEqual(1);
    expect(rec.counts.reproduced).toBeGreaterThanOrEqual(3);
    const detail = rec.receipts.find(
      (x: { outcome: string; detail: { method?: string } }) => x.detail.method === "rerun",
    );
    expect(detail.detail).toMatchObject({ method: "rerun", queries: 2 });
    const pub = (await get(null, `/v1/public/theses/${slug}`)).json();
    expect(pub.receipts).toEqual(rec.counts);
    const list = (await get(bob, "/v1/theses")).json().items.find((x: { id: string }) => x.id === thesisId);
    expect(list.receipts).toEqual(rec.counts);
  });
});
