import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { researchResultsDir, getResearchRun, listResearchRuns } from "../src/research-store.ts";
import { signInviteToken, verifyInviteToken } from "../src/workspace-admin-routes.ts";
import { validateThesis } from "../src/thesis-routes.ts";
import type { ThesisContent } from "../src/thesis-routes.ts";

let f: ApiFixture;
let orgA: string;
let orgB: string;
let owner: string; // org A owner
let analyst: string;
let viewer: string;
let adminB: string; // org B admin
let ownerUserId: string;
let wsA: string;
let wsB: string;

type Res = {
  statusCode: number;
  json(): any;
  body: string;
  headers: Record<string, any>;
  rawPayload: Buffer;
};
const call = (
  tok: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<Res> =>
  f.app.inject({
    method,
    url,
    headers: tok ? bearer(tok) : {},
    ...(payload !== undefined ? { payload: payload as never } : {}),
  }) as unknown as Promise<Res>;
const mkWs = async (tok: string, key: string) =>
  (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "Is demand durable?", networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "orga", { owner: "owner", analyst: "analyst", viewer: "viewer" });
  const b = await seedOrg(f.db.admin, "orgb", { admin: "admin" });
  orgA = a.orgId;
  orgB = b.orgId;
  ownerUserId = a.users.owner!.userId;
  owner = await login(f.app, a.users.owner!.subject);
  analyst = await login(f.app, a.users.analyst!.subject);
  viewer = await login(f.app, a.users.viewer!.subject);
  adminB = await login(f.app, b.users.admin!.subject);
  wsA = await mkWs(owner, "ws-key-a-0001");
  wsB = await mkWs(adminB, "ws-key-b-0001");
});
afterAll(async () => {
  await f.close();
});

const H = {
  proposition: "Lagged Intents volume improves out-of-sample forecasts of organic activity.",
  target: "organic daily actions",
  predictor: "lagged completed Intents volume",
  benchmark: "own-history ridge",
  falsification: "No FDR-significant gain in delta MAE over 77 origins.",
};

describe("hypotheses", () => {
  let hid: string;
  it("creates a draft, edits it, freezes it with a content hash", async () => {
    const c = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses`, H);
    expect(c.statusCode).toBe(201);
    hid = c.json().hypothesisId;
    expect(c.json()).toMatchObject({
      status: "draft",
      registered: false,
      registrationHash: null,
      version: 1,
      chainCommitment: "none",
    });
    const p = await call(analyst, "PATCH", `/v1/workspaces/${wsA}/hypotheses/${hid}`, {
      benchmark: "own-history ridge, alpha 1.0",
    });
    expect(p.json().benchmark).toBe("own-history ridge, alpha 1.0");
    const run = listResearchRuns().find(
      (r) => r.integrity === "verified" && typeof (r.artifacts.preregistration as any)?.hash === "string",
    )!;
    const prereg = (run.artifacts.preregistration as any).hash as string;
    const fz = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/freeze`, {
      preregistrationHash: prereg,
    });
    expect(fz.statusCode).toBe(200);
    expect(fz.json()).toMatchObject({ status: "frozen", registered: true });
    expect(fz.json().registrationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fz.json().preregistration).toMatchObject({ hash: prereg, verified: true });
    expect(fz.json().preregistration.source).toContain("research-run:");
    const v = await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}/verify`);
    expect(v.json()).toMatchObject({ intact: true });
  });

  it("an unknown preregistration hash is recorded as unverified, not as a match", async () => {
    const c = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses`, H);
    const fz = await call(
      analyst,
      "POST",
      `/v1/workspaces/${wsA}/hypotheses/${c.json().hypothesisId}/freeze`,
      { preregistrationHash: `sha256:${"ab".repeat(32)}` },
    );
    expect(fz.json().preregistration).toMatchObject({ verified: false, source: "user_supplied" });
  });

  it("a frozen hypothesis is never edited: API refuses and the database trigger refuses even for the superuser", async () => {
    const e = await call(analyst, "PATCH", `/v1/workspaces/${wsA}/hypotheses/${hid}`, {
      proposition: "Something else entirely, rewritten.",
    });
    expect(e.statusCode).toBe(422);
    expect(e.json().reasonCode).toBe("HYPOTHESIS_FROZEN");
    const f2 = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/freeze`, {});
    expect(f2.json().reasonCode).toBe("HYPOTHESIS_FROZEN");
    await expect(
      f.db.admin.query("UPDATE hypotheses SET proposition = 'tampered text here' WHERE root_id = $1", [hid]),
    ).rejects.toThrow(/immutable/);
    await expect(
      f.db.admin.query("UPDATE hypotheses SET freeze_hash = $2 WHERE root_id = $1", [
        hid,
        `sha256:${"0".repeat(64)}`,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(f.db.admin.query("DELETE FROM hypotheses WHERE root_id = $1", [hid])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      f.db.app.tx({ orgId: orgA, userId: ownerUserId }, (tx) =>
        tx.query("UPDATE hypotheses SET target = 'x' WHERE root_id = $1", [hid]),
      ),
    ).rejects.toThrow(/immutable/);
    const after = await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}`);
    expect(after.json().proposition).toBe(H.proposition);
  });

  it("amend creates a new draft version chained to the frozen hash; freezing it gives a different hash; verify stays intact", async () => {
    const orig = (await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}`)).json();
    const am = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/amend`, {
      falsification: "No gain in delta MAE over 77 origins at horizons 1, 7 and 14.",
      reason: "Extend falsification to all horizons.",
    });
    expect(am.statusCode).toBe(201);
    expect(am.json()).toMatchObject({
      version: 2,
      status: "draft",
      hypothesisId: hid,
      parentVersionId: orig.versionId,
    });
    const fz = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/freeze`, {});
    expect(fz.json().registrationHash).not.toBe(orig.registrationHash);
    const all = (await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}`)).json();
    expect(all.versions).toHaveLength(2);
    expect(all.versions[0].falsification).toBe(H.falsification); // v1 untouched
    expect((await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}/verify`)).json().intact).toBe(
      true,
    );
    const noDraft = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/amend`, {
      reason: "again, with a new reason",
      target: "t",
    });
    expect(noDraft.statusCode).toBe(201); // frozen v2 can be amended again
    const dup = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/amend`, {
      reason: "second open draft",
      target: "t2",
    });
    expect(dup.statusCode).toBe(422); // v3 is a draft: only frozen versions are amended
    expect(dup.json().reasonCode).toBe("HYPOTHESIS_NOT_FROZEN");
  });

  it("fork starts a new line with lineage", async () => {
    const fk = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/fork`, {
      predictor: "lagged price returns",
      reason: "Compare the price predictor.",
    });
    expect(fk.statusCode).toBe(201);
    expect(fk.json()).toMatchObject({ version: 1, status: "draft", predictor: "lagged price returns" });
    expect(fk.json().hypothesisId).not.toBe(hid);
    expect(fk.json().forkedFromVersionId).toBeTruthy();
  });

  it("links a research run and an evidence-graph claim; rejects unknown refs", async () => {
    const run = listResearchRuns().find((r) => r.integrity === "verified")!;
    const l1 = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/links`, {
      kind: "experiment",
      ref: run.runId,
    });
    expect(l1.statusCode).toBe(201);
    expect(
      (
        await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/links`, {
          kind: "experiment",
          ref: "no-such-run",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/links`, {
          kind: "claim",
          ref: randomUUID(),
        })
      ).json().reasonCode,
    ).toBe("CLAIM_NOT_FOUND");
    const claimId = randomUUID();
    await f.db.admin.query(
      "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,'claim','Lagged volume helps')",
      [claimId, orgA, wsA],
    );
    const l2 = await call(analyst, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/links`, {
      kind: "claim",
      ref: claimId,
    });
    expect(l2.statusCode).toBe(201);
    expect(
      l2
        .json()
        .links.map((x: any) => x.kind)
        .sort(),
    ).toEqual(["claim", "experiment"]);
    const edge = await f.db.admin.query(
      "SELECT relation FROM evidence_edges WHERE from_node = $1 AND to_node = $2",
      [hid, claimId],
    );
    expect(edge.rows[0].relation).toBe("references");
    const list = (await call(analyst, "GET", `/v1/workspaces/${wsA}/hypotheses`)).json();
    const mine = list.hypotheses.find((h: any) => h.hypothesisId === hid);
    expect(mine).toMatchObject({
      experimentCount: 1,
      claimCount: 1,
      verdict: run.run.status,
      strength: run.run.evidenceStrength,
    });
  });

  it("viewers cannot write; other tenants see 404; RLS hides rows from another org's context", async () => {
    expect((await call(viewer, "POST", `/v1/workspaces/${wsA}/hypotheses`, H)).statusCode).toBe(403);
    expect((await call(viewer, "GET", `/v1/workspaces/${wsA}/hypotheses`)).statusCode).toBe(200);
    const x = await call(adminB, "GET", `/v1/workspaces/${wsA}/hypotheses/${hid}`);
    const y = await call(adminB, "GET", `/v1/workspaces/${randomUUID()}/hypotheses/${hid}`);
    expect(x.statusCode).toBe(404);
    expect(y.statusCode).toBe(404);
    expect(
      (await call(adminB, "POST", `/v1/workspaces/${wsA}/hypotheses/${hid}/freeze`, {})).statusCode,
    ).toBe(404);
    // a hypothesis id from another workspace of the same org is also not found
    expect((await call(owner, "GET", `/v1/workspaces/${wsB}/hypotheses/${hid}`)).statusCode).toBe(404);
    const other = await f.db.app.tx(
      {
        orgId: orgB,
        userId: (await f.db.admin.query("SELECT user_id FROM memberships WHERE org_id=$1", [orgB])).rows[0]
          .user_id,
      },
      (tx) => tx.query("SELECT 1 FROM hypotheses"),
    );
    expect(other.rowCount).toBe(0);
    const ins = f.db.app.tx(
      {
        orgId: orgB,
        userId: (await f.db.admin.query("SELECT user_id FROM memberships WHERE org_id=$1", [orgB])).rows[0]
          .user_id,
      },
      (tx) =>
        tx.query(
          "INSERT INTO hypotheses(id, org_id, workspace_id, root_id, version, proposition, target, predictor, benchmark, falsification, created_by) VALUES ($1,$2,$3,$1,1,'cross tenant insert','','','','x',$4)",
          [randomUUID(), orgA, wsA, ownerUserId],
        ),
    );
    await expect(ins).rejects.toThrow();
  });
});

describe("experiments over real research artifacts", () => {
  it("lists the engine's real runs with the numbers the artifacts contain", async () => {
    const r = await call(analyst, "GET", `/v1/workspaces/${wsA}/experiments`);
    expect(r.statusCode).toBe(200);
    const ex = r.json().experiments as any[];
    expect(ex.length).toBeGreaterThan(0);
    const dir = researchResultsDir();
    const id = readdirSync(dir).find((d) => d.includes("organic-v3"))!;
    const est = JSON.parse(readFileSync(join(dir, id, "estimates.json"), "utf8"));
    const e = ex.find((x) => x.experimentId === id)!;
    expect(e.integrity).toBe("verified");
    const base = e.models.find((m: any) => m.id === "baseline");
    expect(base.mae).toBe(est.losses.development.baseline.mae_log);
    expect(base.smape).toBe(est.losses.development.baseline.smape_raw);
    expect(base.bias).toBe(est.losses.development.baseline.bias_log);
    expect(e.origins).toBe(est.primary.n_origins);
    expect(typeof e.methodValidated).toBe("boolean");
    expect(e.methodValidated).toBe(false); // the run's primary inference is comparison_method_not_validated
  });

  it("detail carries comparisons, the robustness matrix with NOT_COMPUTABLE cells as such, and provenance", async () => {
    const id = readdirSync(researchResultsDir()).find((d) => d.includes("organic-v3"))!;
    const d = (await call(analyst, "GET", `/v1/workspaces/${wsA}/experiments/${id}`)).json();
    expect(d.comparisons).toHaveLength(9);
    const c = d.comparisons.find((x: any) => x.key === "1:intents");
    expect(c.deltaMae).toBeLessThan(0);
    expect(c.inference.conclusion.state).toBe("comparison_method_not_validated");
    expect(c.inference.significanceClaimAllowed).toBe(false);
    const rm = d.robustness.rows.find((x: any) => x.name === "post_oct27_regime");
    expect(rm).toMatchObject({ status: "NOT_COMPUTABLE" });
    expect(rm.reason).toContain("post-regime");
    expect(d.robustness.hashed).toBe(false);
    expect(d.provenance.artifactHashes).toBeTruthy();
    expect((await call(analyst, "GET", `/v1/workspaces/${wsA}/experiments/does-not-exist`)).statusCode).toBe(
      404,
    );
    expect((await call(adminB, "GET", `/v1/workspaces/${wsA}/experiments`)).statusCode).toBe(404);
  });

  it("a run whose artifact bytes no longer match its recorded hash is served with integrity failed and no figures", () => {
    const tmp = mkdtempSync(join(tmpdir(), "research-"));
    const id = readdirSync(researchResultsDir()).find((d) => d.includes("organic-v3"))!;
    cpSync(join(researchResultsDir(), id), join(tmp, id), { recursive: true });
    expect(getResearchRun(id, tmp)!.integrity).toBe("verified");
    const p = join(tmp, id, "estimates.json");
    writeFileSync(p, readFileSync(p, "utf8").replace("0.0553293749", "0.0000000001"));
    const bad = getResearchRun(id, tmp)!;
    expect(bad.integrity).toBe("failed");
    expect(bad.integrityIssues.join()).toContain("estimates: sha256 mismatch");
  });
});

describe("claims", () => {
  it("derives estimate, counterexamples and falsification from graph, hypotheses and research; unknown is typed", async () => {
    const ws = await mkWs(owner, "ws-claims-0001");
    const mk = async (label: string, data: object = {}) => {
      const id = randomUUID();
      await f.db.admin.query(
        "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data) VALUES ($1,$2,$3,'claim',$4,$5)",
        [id, orgA, ws, label, JSON.stringify(data)],
      );
      return id;
    };
    const obs = randomUUID();
    await f.db.admin.query(
      "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,'observation','daily counts table')",
      [obs, orgA, ws],
    );
    const bare = await mk("A claim with nothing attached");
    const rich = await mk("Intents volume does not improve forecasts", { evidenceTier: "exploratory" });
    await f.db.admin.query(
      "INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation) VALUES ($1,$2,$3,$4,$5,'supports')",
      [randomUUID(), orgA, ws, obs, rich],
    );
    const run = listResearchRuns().find(
      (r) => r.integrity === "verified" && (r.artifacts.counterevidence as unknown[]).length > 0,
    )!;
    const h = (await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses`, H)).json().hypothesisId;
    expect(
      (await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses/${h}/links`, { kind: "claim", ref: rich }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses/${h}/links`, {
          kind: "experiment",
          ref: run.runId,
        })
      ).statusCode,
    ).toBe(201);

    const b = (await call(analyst, "GET", `/v1/workspaces/${ws}/claims/${bare}`)).json();
    expect(b.estimate).toMatchObject({ state: "unknown" });
    expect(b.counterexamples.state).toBe("unknown");
    expect(b.falsification.state).toBe("unknown");
    expect(b.support).toBe("unsupported");

    const r = (await call(analyst, "GET", `/v1/workspaces/${ws}/claims/${rich}`)).json();
    expect(r.support).toBe("supported");
    expect(r.estimate.state).toBe("available");
    expect(r.estimate.source).toBe(`research-run:${run.runId}`);
    const est = (run.artifacts.estimates as any).primary;
    expect(r.estimate.value.deltaMae).toBe(est.delta_mae);
    expect(r.counterexamples.value.length).toBeGreaterThan(0);
    expect(r.falsification.value.criteria[0].text).toBe(H.falsification);
    expect(r.strength.research).toMatchObject({ state: "available", value: run.run.evidenceStrength });
    expect(r.hypotheses[0].hypothesisId).toBe(h);

    const list = (await call(analyst, "GET", `/v1/workspaces/${ws}/claims`)).json();
    expect(list.claims).toHaveLength(2);
    expect((await call(adminB, "GET", `/v1/workspaces/${ws}/claims/${rich}`)).statusCode).toBe(404);
    expect((await call(analyst, "GET", `/v1/workspaces/${ws}/claims/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe("workspace profile, templates, pins, org and invites", () => {
  it("edits name and description (writers only), pins per user, archives (admins only)", async () => {
    const s0 = (await call(analyst, "GET", `/v1/workspaces/${wsA}/settings`)).json();
    expect(s0).toMatchObject({ name: null, pinned: false, archived: false, collaboratorScope: "org" });
    const p = await call(analyst, "PATCH", `/v1/workspaces/${wsA}/settings`, {
      name: "Intents durability",
      description: "Thesis workspace",
    });
    expect(p.json()).toMatchObject({
      name: "Intents durability",
      displayName: "Intents durability",
      description: "Thesis workspace",
    });
    expect((await call(viewer, "PATCH", `/v1/workspaces/${wsA}/settings`, { name: "x" })).statusCode).toBe(
      403,
    );
    expect(
      (await call(analyst, "PATCH", `/v1/workspaces/${wsA}/settings`, { objective: "nope" })).statusCode,
    ).toBe(422);
    expect((await call(analyst, "PUT", `/v1/workspaces/${wsA}/pin`)).json().pinned).toBe(true);
    expect((await call(analyst, "GET", `/v1/workspaces/${wsA}/settings`)).json().pinned).toBe(true);
    expect((await call(owner, "GET", `/v1/workspaces/${wsA}/settings`)).json().pinned).toBe(false); // per user
    expect((await call(analyst, "GET", "/v1/me/pins")).json().pins.map((x: any) => x.workspaceId)).toContain(
      wsA,
    );
    expect((await call(analyst, "DELETE", `/v1/workspaces/${wsA}/pin`)).json().pinned).toBe(false);
    expect((await call(analyst, "POST", `/v1/workspaces/${wsA}/archive`)).statusCode).toBe(403);
    const ar = await call(owner, "POST", `/v1/workspaces/${wsA}/archive`);
    expect(ar.json().archived).toBe(true);
    expect((await call(owner, "POST", `/v1/workspaces/${wsA}/unarchive`)).json().archived).toBe(false);
    expect(
      (await call(adminB, "PATCH", `/v1/workspaces/${wsA}/settings`, { name: "hijack" })).statusCode,
    ).toBe(404);
    expect((await call(adminB, "PUT", `/v1/workspaces/${wsA}/pin`)).statusCode).toBe(404);
  });

  it("creates a workspace from a template: seeds canvas config, no panels, no data; idempotent", async () => {
    const t = (await call(analyst, "GET", "/v1/workspace-templates")).json().templates as any[];
    expect(t.map((x) => x.id)).toEqual(
      expect.arrayContaining(["blank", "near-investment-thesis", "freeform-exploration"]),
    );
    const body = {
      templateId: "freeform-exploration",
      name: "Exploration",
      networkScope: "fixture-only",
      objective: "Explore Intents flows",
      idempotencyKey: "tmpl-key-0001",
    };
    const r = await call(analyst, "POST", "/v1/workspaces/from-template", body);
    expect(r.statusCode).toBe(201);
    const wsId = r.json().workspaceId as string;
    expect(r.json()).toMatchObject({
      name: "Exploration",
      template: { id: "freeform-exploration" },
      seeded: { panels: 0, data: "none" },
    });
    const canvas = (await call(analyst, "GET", `/v1/workspaces/${wsId}/canvas`)).json();
    expect(canvas).toMatchObject({ layoutMode: "freeform", panels: [], markers: [] });
    expect(canvas.viewport.zoom).toBe(0.8);
    const again = await call(analyst, "POST", "/v1/workspaces/from-template", body);
    expect(again.json().workspaceId).toBe(wsId);
    expect(
      (
        await f.db.admin.query("SELECT count(*)::int AS n FROM canvas_documents WHERE workspace_id=$1", [
          wsId,
        ])
      ).rows[0].n,
    ).toBe(1);
    // the first real canvas patch continues from the seeded document
    const cnt = await call(analyst, "GET", `/v1/workspaces/${wsId}`);
    expect(cnt.json().id).toBe(wsId);
    expect(
      (
        await call(analyst, "POST", "/v1/workspaces/from-template", {
          ...body,
          templateId: "no-such",
          idempotencyKey: "tmpl-key-0002",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(analyst, "POST", "/v1/workspaces/from-template", {
          ...body,
          templateId: "blank",
          objective: undefined,
          idempotencyKey: "tmpl-key-0003",
        })
      ).json().reasonCode,
    ).toBe("OBJECTIVE_REQUIRED");
    // org templates are tenant-scoped
    const mine = await call(owner, "POST", "/v1/workspace-templates", {
      key: "my-template",
      name: "Mine",
      canvasConfig: { layoutMode: "grid", viewport: { zoom: 1.5, x: 10, y: 20 } },
    });
    expect(mine.statusCode).toBe(201);
    expect(
      (
        await call(analyst, "POST", "/v1/workspace-templates", {
          key: "x-template",
          name: "X",
          canvasConfig: { layoutMode: "grid", viewport: { zoom: 1, x: 0, y: 0 } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(adminB, "GET", "/v1/workspace-templates"))
        .json()
        .templates.some((x: any) => x.key === "my-template"),
    ).toBe(false);
    expect(
      (
        await call(adminB, "POST", "/v1/workspaces/from-template", {
          ...body,
          templateId: mine.json().id,
          idempotencyKey: "tmpl-key-0004",
        })
      ).statusCode,
    ).toBe(404);
    const fromOrg = await call(analyst, "POST", "/v1/workspaces/from-template", {
      ...body,
      templateId: mine.json().id,
      idempotencyKey: "tmpl-key-0005",
    });
    expect(
      (await call(analyst, "GET", `/v1/workspaces/${fromOrg.json().workspaceId}/canvas`)).json().viewport,
    ).toEqual({ zoom: 1.5, x: 10, y: 20 });
  });

  it("org members: list, role change, owner rules, last owner", async () => {
    const m = (await call(viewer, "GET", "/v1/org/members")).json().members as any[];
    expect(m).toHaveLength(3);
    const an = m.find((x) => x.displayName === "analyst");
    expect((await call(viewer, "PATCH", `/v1/org/members/${an.userId}`, { role: "viewer" })).statusCode).toBe(
      403,
    );
    expect(
      (await call(owner, "PATCH", `/v1/org/members/${an.userId}`, { role: "admin" })).json(),
    ).toMatchObject({ role: "admin" });
    await call(owner, "PATCH", `/v1/org/members/${an.userId}`, { role: "analyst" });
    expect(
      (await call(owner, "PATCH", `/v1/org/members/${ownerUserId}`, { role: "admin" })).json().reasonCode,
    ).toBe("LAST_OWNER");
    expect((await call(owner, "DELETE", `/v1/org/members/${ownerUserId}`)).json().reasonCode).toBe(
      "LAST_OWNER",
    );
    expect((await call(adminB, "PATCH", `/v1/org/members/${an.userId}`, { role: "viewer" })).statusCode).toBe(
      404,
    ); // other org's member
    expect((await call(adminB, "GET", "/v1/org")).json()).toMatchObject({ name: "orgb", memberCount: 1 });
  });

  it("invites: signed token, preview, single-use accept into another org, forged and expired tokens refused", async () => {
    const inv = await call(owner, "POST", "/v1/org/invites", {
      email: "Newbie@Example.com",
      role: "viewer",
      workspaceId: wsA,
      ttlHours: 2,
    });
    expect(inv.statusCode).toBe(201);
    const { token, inviteId } = inv.json() as { token: string; inviteId: string };
    expect(inv.json().email).toBe("newbie@example.com");
    expect(token.startsWith("inv1.")).toBe(true);
    const stored = (await f.db.admin.query("SELECT token_hash FROM org_invites WHERE id=$1", [inviteId]))
      .rows[0].token_hash as string;
    expect(stored).not.toContain(token); // only the hash is stored
    expect(
      (await call(analyst, "POST", "/v1/org/invites", { email: "x@y.io", role: "viewer" })).statusCode,
    ).toBe(403);
    expect((await call(owner, "GET", "/v1/org/invites")).json().invites[0]).toMatchObject({
      inviteId,
      state: "pending",
    });
    expect(
      (await call(analyst, "GET", `/v1/workspaces/${wsA}/collaborators`)).json().pendingInvites,
    ).toBeNull();
    expect(
      (await call(owner, "GET", `/v1/workspaces/${wsA}/collaborators`)).json().pendingInvites,
    ).toHaveLength(1);

    const pv = await f.app.inject({
      method: "GET",
      url: `/v1/invites/preview?token=${encodeURIComponent(token)}`,
    });
    expect(pv.json()).toMatchObject({ orgName: "orga", role: "viewer", state: "pending", workspaceId: wsA });

    // forged: change the embedded expiry
    const parts = token.split(".");
    const forged = [parts[0], parts[1], String(Number(parts[2]) + 99999), parts[3]].join(".");
    const bad = await call(adminB, "POST", "/v1/invites/accept", { token: forged });
    expect(bad.json().reasonCode).toBe("INVITE_TOKEN_INVALID");
    expect(
      (await f.app.inject({ method: "GET", url: `/v1/invites/preview?token=${encodeURIComponent(forged)}` }))
        .statusCode,
    ).toBe(422);

    // accept as the org B admin: membership appears in org A with the invited role
    const ok = await call(adminB, "POST", "/v1/invites/accept", { token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: true, orgId: orgA, role: "viewer", workspaceId: wsA });
    const bUser = (await f.db.admin.query("SELECT user_id FROM memberships WHERE org_id=$1", [orgB])).rows[0]
      .user_id;
    expect(
      (await f.db.admin.query("SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2", [orgA, bUser]))
        .rows[0].role,
    ).toBe("viewer");
    const again = await call(adminB, "POST", "/v1/invites/accept", { token });
    expect(again.json().reasonCode).toBe("INVITE_ALREADY_ACCEPTED");
    expect((await call(owner, "GET", "/v1/org/invites")).json().invites[0].state).toBe("accepted");
  });

  it("an invite past its expiry is refused (database clock) and an expired signed token is refused before any lookup", async () => {
    const inv = (
      await call(owner, "POST", "/v1/org/invites", {
        email: "late@example.com",
        role: "analyst",
        ttlHours: 1,
      })
    ).json();
    await f.db.admin.query("UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      inv.inviteId,
    ]);
    const r = await call(adminB, "POST", "/v1/invites/accept", { token: inv.token });
    expect(r.statusCode).toBe(422);
    expect(r.json().reasonCode).toBe("INVITE_EXPIRED");
    expect(
      (await call(owner, "GET", "/v1/org/invites"))
        .json()
        .invites.find((i: any) => i.inviteId === inv.inviteId).state,
    ).toBe("expired");
    const secret = (await f.db.admin.query("SELECT invite_secret() AS s")).rows[0].s as string;
    const past = signInviteToken(secret, randomUUID(), Math.floor(Date.now() / 1000) - 5);
    expect(() => verifyInviteToken(secret, past, Date.now())).toThrow(/expired/);
    expect(() =>
      verifyInviteToken(
        secret,
        signInviteToken("another-secret", randomUUID(), Math.floor(Date.now() / 1000) + 600),
        Date.now(),
      ),
    ).toThrow(/Invalid invite token/);
  });

  it("revoked invites cannot be accepted; invites are tenant-scoped", async () => {
    const inv = (
      await call(owner, "POST", "/v1/org/invites", { email: "rev@example.com", role: "viewer" })
    ).json();
    expect((await call(adminB, "DELETE", `/v1/org/invites/${inv.inviteId}`)).statusCode).toBe(404);
    expect((await call(adminB, "GET", "/v1/org/invites")).json().invites).toHaveLength(0);
    expect((await call(owner, "DELETE", `/v1/org/invites/${inv.inviteId}`)).json().revoked).toBe(true);
    const r = await call(viewer, "POST", "/v1/invites/accept", { token: inv.token });
    expect(r.json().reasonCode).toBe("INVITE_REVOKED");
    const direct = await f.db.app.tx(
      {
        orgId: orgB,
        userId: (await f.db.admin.query("SELECT user_id FROM memberships WHERE org_id=$1", [orgB])).rows[0]
          .user_id,
      },
      (tx) => tx.query("SELECT 1 FROM org_invites WHERE org_id = $1", [orgA]),
    );
    expect(direct.rowCount).toBe(0);
    await expect(
      f.db.app.tx({ orgId: orgB, userId: ownerUserId }, (tx) =>
        tx.query("SELECT secret FROM platform_secrets"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("run detail", () => {
  it("per-task cost and tool calls from the runtime tables; tenant-scoped; unknown cost is null", async () => {
    const runId = randomUUID();
    const budgetId = randomUUID();
    const rootTask = randomUUID();
    const t1 = randomUUID();
    const t2 = randomUUID();
    const a = f.db.admin;
    await a.query(
      "INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000,10,2)",
      [budgetId, orgA, wsA],
    );
    await a.query(
      "INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state) VALUES ($1,$2,$3,$4,$5,'live',$6,$7,'COMPLETE')",
      [runId, orgA, wsA, randomUUID(), randomUUID(), budgetId, `wf-${runId}`],
    );
    const task = (id: string, role: string, depth: number, hyp: string, status: string) =>
      a.query(
        "INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, objective) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9,$10)",
        [id, orgA, wsA, runId, role, depth, `h-${id}`, hyp, status, `${role} objective`],
      );
    await task(rootTask, "director", 0, "h-root", "DONE");
    await task(t1, "analyst", 1, "h-1", "DONE");
    await task(t2, "skeptic", 1, "h-2", "RUNNING");
    const led = (
      task_id: string | null,
      kind: string,
      key: string,
      usd: number,
      tokens: number,
      calls: number,
    ) =>
      a.query(
        "INSERT INTO runtime.budget_ledger(tenant_id, workspace_id, budget_id, run_id, task_id, entry_key, kind, tokens, tool_calls, usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [orgA, wsA, budgetId, runId, task_id, key, kind, tokens, calls, usd],
      );
    await led(t1, "reserve", "r1", 0.5, 500, 3);
    await led(t1, "charge", "c1", 0.12, 321, 2);
    await led(t1, "release", "x1", 0.38, 179, 1);
    await led(t2, "reserve", "r2", 0.2, 100, 1);
    const call_ = (hyp: string, n: number, tool: string) =>
      a.query(
        "INSERT INTO runtime.tool_call_log(tenant_id, run_id, hypothesis_id, call_key, n, tool) VALUES ($1,$2,$3,$4,$5,$6)",
        [orgA, runId, hyp, `k-${hyp}-${n}`, n, tool],
      );
    await call_("h-1", 1, "intents.summary");
    await call_("h-1", 2, "intents.trend");
    await a.query(
      "INSERT INTO runtime.agent_audit(tenant_id, workspace_id, run_id, task_id, kind, reason_code, detail) VALUES ($1,$2,$3,$4,'tool.rejected','UNKNOWN_TOOL','{\"tool\":\"web.search\"}')",
      [orgA, wsA, runId, t1],
    );

    const r = await call(analyst, "GET", `/v1/runs/${runId}/tasks`);
    expect(r.statusCode).toBe(200);
    const tasks = r.json().tasks as any[];
    const an = tasks.find((x) => x.taskId === t1);
    expect(an.cost).toEqual({ usd: 0.12, tokens: 321, toolCalls: 2, reservedUsd: 0.5, releasedUsd: 0.38 });
    expect(an.toolCalls.map((c: any) => c.tool)).toEqual(["intents.summary", "intents.trend"]);
    expect(an.toolCallAttribution).toBe("task");
    expect(an.rejectedToolCalls).toEqual([
      expect.objectContaining({ reasonCode: "UNKNOWN_TOOL", tool: "web.search" }),
    ]);
    expect(an.endedAt).not.toBeNull();
    const sk = tasks.find((x) => x.taskId === t2);
    expect(sk.cost.usd).toBe(0); // only a reservation exists: charged is zero, reserved is shown
    expect(sk.cost.reservedUsd).toBe(0.2);
    expect(sk.endedAt).toBeNull();
    const root = tasks.find((x) => x.taskId === rootTask);
    expect(root.cost).toEqual({
      usd: null,
      tokens: null,
      toolCalls: null,
      reservedUsd: null,
      releasedUsd: null,
    });
    expect(r.json().totals).toMatchObject({ chargedUsd: 0.12, toolCalls: 2, tasks: 3 });
    expect((await call(adminB, "GET", `/v1/runs/${runId}/tasks`)).statusCode).toBe(404);
    expect((await call(analyst, "GET", `/v1/runs/${randomUUID()}/tasks`)).statusCode).toBe(404);
  });
});

describe("source health depth", () => {
  it("serves heatmap, errors and rate limits from the port; unknown source is 404", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const port = {
      watermarks: async () => [
        {
          sourceId: "intents-1click",
          state: "fresh",
          newestEventTime: "2026-11-12T22:03:19.741Z",
          lastFullScanAt: null,
          gapCount: 0,
          lagSeconds: 3,
        },
      ],
      heatmap: async () => ({
        granularity: "hour" as const,
        basis: "fake",
        note: null,
        cells: [
          { day, hour: 3, expected: 10, observed: 10, coverage: 1, state: "ok" as const },
          { day, hour: 4, expected: 10, observed: 4, coverage: 0.4, state: "partial" as const },
        ],
      }),
      errors: async () => ({
        notAttempted: [],
        events: [
          {
            at: "2026-11-12T20:00:00.000Z",
            kind: "http_error" as const,
            code: "NETWORK_ERROR",
            httpStatus: 500,
            reason: null,
            count: 3,
            firstSeen: "2026-11-12T20:00:24.000Z",
            lastSeen: "2026-11-12T20:10:00.000Z",
          },
          {
            at: "2026-11-12T21:00:00.000Z",
            kind: "http_error" as const,
            code: "NETWORK_ERROR",
            httpStatus: 500,
            reason: "reset",
            count: 2,
            firstSeen: "2026-11-12T21:00:00.000Z",
            lastSeen: "2026-11-12T21:30:00.000Z",
          },
        ],
      }),
      rateLimits: async () => ({
        recorded: true,
        basis: "fake",
        note: null,
        hourly: [{ at: "2026-11-12T20:00:00.000Z", attempts: 12, rateLimited: 0 }],
      }),
    };
    const g = await apiFixture({ appOptions: {} });
    try {
      const org = await seedOrg(g.db.admin, "orgh", { u: "analyst" });
      const tok = await login(g.app, org.users.u!.subject);
      const { sourceHealthRoutes } = await import("../src/source-health-routes.ts");
      const Fastify = (await import("fastify")).default;
      const { toErrorResponse } = await import("@nearesis/kernel");
      const app = Fastify();
      app.setErrorHandler((e, _r, reply) => {
        const { status, body } = toErrorResponse(e, "t");
        void reply.status(status).send(body);
      });
      await app.register(sourceHealthRoutes, {
        kernel: g.kernel,
        authenticate: async (req) =>
          g.kernel.identity.resolveSession(String(req.headers.authorization).slice(7)),
        port,
        now: () => Date.parse("2026-11-13T00:00:00Z"),
      });
      const h = { authorization: `Bearer ${tok}` };
      const r = (await app.inject({ url: "/v1/sources/intents-1click/health?days=7", headers: h })).json();
      expect(r.heatmap.cells).toHaveLength(2);
      expect(r.heatmap.weekdayHour).toHaveLength(2);
      expect(r.heatmap.weekdayHour.find((x: any) => x.hour === 4)).toMatchObject({
        observed: 4,
        expected: 10,
        coverage: 0.4,
      });
      expect(r.errors.byCode).toEqual([
        expect.objectContaining({
          code: "NETWORK_ERROR",
          count: 5,
          firstSeen: "2026-11-12T20:00:24.000Z",
          lastSeen: "2026-11-12T21:30:00.000Z",
          lastReason: "reset",
        }),
      ]);
      expect(r.rateLimits.hourly[0]).toMatchObject({ attempts: 12, rateLimited: 0 });
      expect((await app.inject({ url: "/v1/sources/nope/health", headers: h })).statusCode).toBe(404);
      expect(
        (await app.inject({ url: "/v1/sources/intents-1click/health?days=0", headers: h })).statusCode,
      ).toBe(422);
      expect((await app.inject({ url: "/v1/sources/intents-1click/health" })).statusCode).toBe(401);
      await app.close();
    } finally {
      await g.close();
    }
  });
});

describe("thesis documents", () => {
  const empty = (over: Partial<ThesisContent> = {}): ThesisContent => ({
    schema: "thesis-document@1",
    workspaceId: randomUUID(),
    title: "t",
    objective: "o",
    graphVersion: 1,
    hypotheses: [],
    unregisteredHypotheses: 0,
    claims: { included: [], excluded: [] },
    findings: { included: [], excluded: [] },
    experiments: [],
    capsules: [],
    limitations: [],
    ...over,
  });

  it("validation blocks an empty thesis and a claim resting on an unfrozen hypothesis", () => {
    expect(validateThesis(empty()).status).toBe("blocked");
    const claim = {
      claimId: "c",
      estimate: { state: "unknown" },
      falsification: { state: "unknown" },
      hypotheses: [{ hypothesisId: "h-draft" }],
    };
    const v = validateThesis(empty({ claims: { included: [claim as never], excluded: [] } }));
    expect(v.status).toBe("blocked");
    expect(v.checks.find((c) => c.id === "hypotheses_registered")!.passed).toBe(false);
  });

  it("assembles from supported claims only, versions are immutable, digest and exports are stable", async () => {
    const ws = await mkWs(owner, "ws-thesis-0001");
    const node = async (kind: string, label: string, data: object = {}) => {
      const id = randomUUID();
      await f.db.admin.query(
        "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, orgA, ws, kind, label, JSON.stringify(data)],
      );
      return id;
    };
    const edge = (from: string, to: string, rel: string) =>
      f.db.admin.query(
        "INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation) VALUES ($1,$2,$3,$4,$5,$6)",
        [randomUUID(), orgA, ws, from, to, rel],
      );

    expect(
      (await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents`, { title: "Empty" })).json(),
    ).toMatchObject({ status: "blocked", version: 1 });

    const obs = await node("observation", "daily table");
    const good = await node("claim", "Volume is concentrated in few routes");
    const unsupported = await node("claim", "Everything is fine");
    const numericIncomplete = await node("claim", "Share is 42%", {
      numeric: true,
      value: 0.42,
      provenance: { queryHash: "abc" },
    });
    await edge(obs, good, "supports");
    await edge(obs, numericIncomplete, "supports");
    const run = listResearchRuns().find((r) => r.integrity === "verified")!;
    const hid = (await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses`, H)).json().hypothesisId;
    await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses/${hid}/links`, { kind: "claim", ref: good });
    await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses/${hid}/links`, {
      kind: "experiment",
      ref: run.runId,
    });

    const c1 = await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents`, { title: "NEAR thesis" });
    expect(c1.statusCode).toBe(201);
    expect(c1.json().status).toBe("blocked"); // the hypothesis behind the claim is still a draft
    expect(c1.json().validation.checks.find((c: any) => c.id === "hypotheses_registered").passed).toBe(false);
    const did = c1.json().documentId as string;

    await call(owner, "POST", `/v1/workspaces/${ws}/hypotheses/${hid}/freeze`, {});
    const v2 = await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents/${did}/versions`);
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, status: "validated", changedSincePrevious: true });
    const doc = (await call(analyst, "GET", `/v1/workspaces/${ws}/thesis/documents/${did}`)).json();
    expect(doc.version).toBe(2);
    expect(doc.content.claims.included.map((c: any) => c.statement)).toEqual([
      "Volume is concentrated in few routes",
    ]);
    const excludedStatements = doc.content.claims.excluded.map((c: any) => c.statement).sort();
    expect(excludedStatements).toEqual(["Everything is fine", "Share is 42%"]);
    expect(
      doc.content.claims.excluded.find((c: any) => c.statement === "Share is 42%").missing.length,
    ).toBeGreaterThan(0);
    expect(doc.content.hypotheses[0]).toMatchObject({ hypothesisId: hid });
    expect(doc.content.experiments[0].experimentId).toBe(run.runId);
    expect(doc.markdown).toContain(doc.digest);
    expect(doc.markdown).toContain("UNSUPPORTED: excluded from the supported thesis");
    expect(doc.markdown).toContain("Everything is fine");
    expect(doc.versions).toHaveLength(2);

    const same = await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents/${did}/versions`);
    expect(same.json()).toMatchObject({ version: 3, changedSincePrevious: false, digest: v2.json().digest });
    const val = (await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents/${did}/validate`)).json();
    expect(val).toMatchObject({ upToDate: true, version: 3 });
    await f.db.admin.query(
      "DELETE FROM evidence_edges WHERE from_node = $1 AND to_node = $2 AND relation = 'supports'",
      [obs, good],
    );
    const stale = (
      await call(analyst, "POST", `/v1/workspaces/${ws}/thesis/documents/${did}/validate`)
    ).json();
    expect(stale.upToDate).toBe(false);
    expect(stale.validation.status).toBe("blocked"); // no supported claim remains

    const md = await call(
      analyst,
      "GET",
      `/v1/workspaces/${ws}/thesis/documents/${did}/export?format=markdown&version=2`,
    );
    expect(md.statusCode).toBe(200);
    expect(md.headers["x-content-digest"]).toBe(v2.json().digest);
    expect(md.body).toBe(doc.markdown);
    const pdf = await call(analyst, "GET", `/v1/workspaces/${ws}/thesis/documents/${did}/export?format=pdf`);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // immutability: the app role cannot rewrite a stored version
    await expect(
      f.db.app.tx({ orgId: orgA, userId: ownerUserId }, (tx) =>
        tx.query("UPDATE thesis_versions SET markdown = 'x' WHERE document_id = $1", [did]),
      ),
    ).rejects.toThrow(/permission denied/);
    // tenancy
    expect((await call(adminB, "GET", `/v1/workspaces/${ws}/thesis/documents/${did}`)).statusCode).toBe(404);
    expect((await call(adminB, "GET", `/v1/workspaces/${ws}/thesis/documents`)).statusCode).toBe(404);
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/thesis/documents`, { title: "x" })).statusCode,
    ).toBe(403);
    expect((await call(analyst, "GET", `/v1/workspaces/${wsB}/thesis/documents/${did}`)).statusCode).toBe(
      404,
    );
    expect(orgB).toBeTruthy();
  });
});

describe("source health depth against the live ingestion state (skipped when ClickHouse is unreachable)", () => {
  it("heatmap, errors and rate limits equal direct counts over nearesis_live", async () => {
    const { clickhouseSourceHealth } = await import("../src/source-health-routes.ts");
    const { createClient } = await import("@clickhouse/client");
    const ch = createClient({
      url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
      username: process.env.NEARESIS_CH_USER ?? "nearesis",
      password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
      database: "nearesis_live",
    });
    const q = async (sql: string) =>
      Number(
        ((await (await ch.query({ query: sql, format: "JSONEachRow" })).json()) as Array<{ n: string }>)[0]
          ?.n ?? 0,
      );
    const port = clickhouseSourceHealth();
    try {
      let wm;
      try {
        wm = await port.watermarks();
      } catch {
        console.warn("ClickHouse unreachable: live source-health check skipped");
        return;
      }
      expect(wm.map((w) => w.sourceId)).toContain("intents-1click");
      const now = Date.now();
      const ts = (ms: number) =>
        "toDateTime64('" + new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "', 3, 'UTC')";
      const since = ts(now - 60 * 86_400_000);
      const until = ts(now);
      const h = await port.heatmap("intents-1click", 60, now);
      expect(h.cells.reduce((a, c) => a + (c.expected ?? 0), 0)).toBe(
        await q(
          `SELECT toString(count()) AS n FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= ${since} AND scheduled_bucket_utc <= ${until}`,
        ),
      );
      expect(h.cells.reduce((a, c) => a + c.observed, 0)).toBe(
        await q(
          `SELECT toString(countIf(class = 'OK')) AS n FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= ${since} AND scheduled_bucket_utc <= ${until}`,
        ),
      );
      const e = await port.errors("intents-1click", 60, now);
      expect(e.events.filter((x) => x.kind === "http_error").reduce((a, x) => a + x.count, 0)).toBe(
        await q(
          `SELECT toString(countIf(class IS NOT NULL AND class != 'OK')) AS n FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= ${since} AND scheduled_bucket_utc <= ${until}`,
        ),
      );
      const rl = await port.rateLimits("intents-1click", 60, now);
      expect(rl.recorded).toBe(true);
      expect(rl.hourly.reduce((a, x) => a + x.attempts, 0)).toBe(
        await q(
          `SELECT toString(countIf(class IS NOT NULL)) AS n FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= ${since} AND scheduled_bucket_utc <= ${until}`,
        ),
      );
      const ex = await port.heatmap("near-explorer", 60, now);
      expect(ex.cells.reduce((a, c) => a + c.observed, 0)).toBe(
        await q(
          `SELECT toString(count()) AS n FROM intents_swaps FINAL WHERE created_at >= ${since} AND created_at <= ${until}`,
        ),
      );
      const bq = await port.heatmap("near-bigquery", 30, now);
      expect(bq.granularity).toBe("day");
      expect((await port.rateLimits("near-bigquery", 30, now)).recorded).toBe(false);
    } finally {
      await port.close();
      await ch.close();
    }
  }, 120_000);
});
