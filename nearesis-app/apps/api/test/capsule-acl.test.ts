import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCapsule, writeCapsuleOwnership } from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SNAPSHOT = join(ROOT, "packages/capsule/fixtures/snapshot-synthetic");
const RESEARCH = join(ROOT, "packages/test-fixtures/research/signal-bundle-a002");

let f: ApiFixture;
let dir: string;
let alice: string; // org A member
let bob: string; // org B member
let aliceViewer: string; // org A viewer
const ids = {
  a: "cap-org-a",
  b: "cap-org-b",
  unowned: "cap-unowned",
  noWorkspace: "cap-ghost-ws",
  noResearch: "cap-no-research",
};

async function workspace(tok: string, key: string): Promise<string> {
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(tok), "idempotency-key": key },
    payload: { objective: "capsules", networkScope: "fixture-only" },
  });
  return (r.json() as { workspaceId: string }).workspaceId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "api-capsule-acl-"));
  process.env.NEARESIS_CAPSULE_DIR = dir;
  f = await apiFixture();
  const orgA = await seedOrg(f.db.admin, "acl-a", { alice: "owner", vic: "viewer" });
  const orgB = await seedOrg(f.db.admin, "acl-b", { bob: "owner" });
  alice = await login(f.app, orgA.users.alice!.subject);
  aliceViewer = await login(f.app, orgA.users.vic!.subject);
  bob = await login(f.app, orgB.users.bob!.subject);
  const wsA = await workspace(alice, "capsule-acl-a-01");
  const wsB = await workspace(bob, "capsule-acl-b-01");
  mkdirSync(dir, { recursive: true });
  const build = (id: string, research: boolean) =>
    buildCapsule({
      snapshotDir: SNAPSHOT,
      outDir: join(dir, id),
      ...(research ? { researchBundleDir: RESEARCH } : {}),
    });
  build(ids.a, true);
  build(ids.b, true);
  build(ids.unowned, true);
  build(ids.noWorkspace, true);
  build(ids.noResearch, false);
  writeCapsuleOwnership(join(dir, ids.a), { orgId: orgA.orgId, workspaceId: wsA });
  writeCapsuleOwnership(join(dir, ids.noResearch), { orgId: orgA.orgId, workspaceId: wsA });
  writeCapsuleOwnership(join(dir, ids.b), { orgId: orgB.orgId, workspaceId: wsB });
  // the ownership record names the caller's org but a workspace that does not exist
  writeCapsuleOwnership(join(dir, ids.noWorkspace), { orgId: orgA.orgId, workspaceId: randomUUID() });
  // a malformed record is the same as none
  writeFileSync(join(dir, ids.unowned, "ownership.json"), "{not json");
}, 120_000);
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  await f?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (tok: string, url: string) => {
  const r = await f.app.inject({ method: "GET", url, headers: bearer(tok) });
  return { status: r.statusCode, body: sansTrace(r.json() as unknown), raw: r.body };
};
/** The response body with the requested id masked: the only permitted difference is the echo of the id asked for. */
const norm = (body: unknown, id: string) =>
  JSON.parse(JSON.stringify(body).split(id).join("<id>")) as unknown;
const paths = (id: string) => [
  `/v1/capsules/${id}`,
  `/v1/capsules/${id}/verify`,
  `/v1/capsules/${id}/research-run`,
  `/v1/capsules/${id}/exports/THESIS.md`,
  `/v1/capsules/${id}/exports/site/index.html`,
];

describe("capsule tenant scoping", () => {
  it("the owner's org can read its own capsule", async () => {
    const r = await get(alice, `/v1/capsules/${ids.a}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "available" });
    expect((await get(alice, `/v1/capsules/${ids.a}/verify`)).status).toBe(200);
    expect((await get(aliceViewer, `/v1/capsules/${ids.a}`)).body).toMatchObject({ status: "available" });
  });

  it("a foreign org's capsule, an unowned one, a malformed record, a ghost workspace and a nonexistent id all answer identically", async () => {
    const SUFFIXES = ["", "/verify", "/research-run", "/exports/THESIS.md", "/exports/site/index.html"];
    for (const suffix of SUFFIXES) {
      const nonexistent = await get(alice, `/v1/capsules/cap-does-not-exist${suffix}`);
      for (const id of [ids.b, ids.unowned, ids.noWorkspace]) {
        const r = await get(alice, `/v1/capsules/${id}${suffix}`);
        expect(r.status, `${id}${suffix}`).toBe(nonexistent.status);
        expect(norm(r.body, id), `${id}${suffix}`).toEqual(norm(nonexistent.body, "cap-does-not-exist"));
      }
    }
    // the viewer route keeps its 200 "unavailable" contract, the others are 404
    expect((await get(alice, `/v1/capsules/${ids.b}`)).body).toMatchObject({ status: "unavailable" });
    expect((await get(alice, `/v1/capsules/${ids.b}/verify`)).status).toBe(404);
    expect((await get(alice, `/v1/capsules/${ids.b}/research-run`)).status).toBe(404);
  });

  it("is symmetric: org B cannot read org A's capsule, and listings contain only the caller's own", async () => {
    for (const p of paths(ids.a)) {
      const foreign = await get(bob, p);
      const none = await get(bob, p.replace(ids.a, "cap-does-not-exist"));
      expect(foreign.status, p).toBe(none.status);
      expect(norm(foreign.body, ids.a), p).toEqual(norm(none.body, "cap-does-not-exist"));
    }
    const la = (await get(alice, "/v1/capsules")).body as { capsules: Array<{ capsuleId: string }> };
    const lb = (await get(bob, "/v1/capsules")).body as { capsules: Array<{ capsuleId: string }> };
    expect(la.capsules.length).toBe(2); // cap-org-a and cap-no-research; foreign, unowned and ghost-scoped are never listed
    expect(lb.capsules.length).toBe(1);
  });

  it("a foreign capsule response reveals nothing about the capsule (no title, hash or id echo beyond the request)", async () => {
    const r = await get(alice, `/v1/capsules/${ids.b}`);
    expect(r.raw).not.toMatch(/sha256|capsuleHash|Synthetic|SYNTHETIC/);
  });

  it("still requires a session", async () => {
    for (const p of paths(ids.a))
      expect((await f.app.inject({ method: "GET", url: p })).statusCode, p).toBe(401);
  });
});

describe("GET /v1/capsules/:id/research-run", () => {
  it("serves the recorded run with its pinned method headers and manifest hash", async () => {
    const r = await f.app.inject({
      method: "GET",
      url: `/v1/capsules/${ids.a}/research-run`,
      headers: bearer(alice),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["x-research-method-revision"]).toBe("a002");
    expect(r.headers["x-research-method-version"]).toBe("near.intents_pred_v1@1.0.0");
    expect(r.headers["x-capsule-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    const run = r.json() as { methodVersion: string; estimates: { inferenceSummary: unknown } };
    expect(run.methodVersion).toBe("near.intents_pred_v1@1.0.0");
    expect(run.estimates.inferenceSummary).toBeTruthy();
  });

  it("a visible capsule built without a research run answers 404 RESEARCH_RUN_NOT_FOUND", async () => {
    const r = await f.app.inject({
      method: "GET",
      url: `/v1/capsules/${ids.noResearch}/research-run`,
      headers: bearer(alice),
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.stringify(r.json())).toContain("RESEARCH_RUN_NOT_FOUND");
  });

  it("refuses to serve a run whose bytes no longer match the manifest hash", async () => {
    writeFileSync(join(dir, ids.a, "research", "research_run.json"), "{}");
    const r = await f.app.inject({
      method: "GET",
      url: `/v1/capsules/${ids.a}/research-run`,
      headers: bearer(alice),
    });
    expect(r.statusCode).not.toBe(200);
    expect(JSON.stringify(r.json())).toContain("RESEARCH_RUN_HASH_MISMATCH");
  });
});
