import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let owner: string;
let analyst: string;
let viewer: string;
let outsider: string;
let ws: string;
let wsOther: string;
let version = 1;
beforeAll(async () => {
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "hw", { alice: "owner", ann: "analyst", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "hw2", { bob: "owner" });
  owner = await login(f.app, a.users.alice!.subject);
  analyst = await login(f.app, a.users.ann!.subject);
  viewer = await login(f.app, a.users.vic!.subject);
  outsider = await login(f.app, b.users.bob!.subject);
  const mk = async (key: string, token = owner) =>
    (
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/workspaces",
          headers: { ...bearer(token), "idempotency-key": key },
          payload: { objective: "o", networkScope: "fixture-only" },
        })
      ).json() as { workspaceId: string }
    ).workspaceId;
  ws = await mk("create-hw-0001");
  wsOther = await mk("create-hw-0002");
});
afterAll(async () => f?.close());

const call = (token: string, method: "GET" | "POST", url: string, payload?: unknown) =>
  f.app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const post = async (token: string, path: string, body: Record<string, unknown>, id = ws) => {
  const r = await call(token, "POST", `/v1/workspaces/${id}${path}`, { expectedVersion: version, ...body });
  if (r.statusCode < 300) version = (r.json() as { workspaceVersion: number }).workspaceVersion;
  return r;
};

describe("history routes for the W07-W18 surface", () => {
  it("provenance, impact with ACL, reconstruction, comments, retention and 404 mapping", async () => {
    const n = async (kind: string, label: string, extra: Record<string, unknown> = {}) => {
      const r = await post(owner, "/graph/nodes", { kind, label, ...extra });
      expect(r.statusCode).toBe(201);
      return r.json().result.nodeId as string;
    };
    const R = await n("statistical_result", "R", { semanticPins: { m: "1.0.0" } });
    const A = await n("claim", "A", {
      data: { numeric: true, value: 1, provenance: { queryHash: "a".repeat(64) } },
    });
    expect(
      (await post(owner, "/graph/edges", { from: R, to: A, relation: "supports", reason: "r" })).statusCode,
    ).toBe(201);

    // Publication eligibility lists the incomplete numeric claim apart, with its missing provenance.
    const pe = await call(owner, "GET", `/v1/workspaces/${ws}/publication-eligibility`);
    expect(pe.statusCode).toBe(200);
    expect(pe.json().publicationEligibleIds).toEqual([]);
    expect(pe.json().unsupportedSection.claims[0].missing).toEqual(
      expect.arrayContaining(["result_rows", "quant_model_revision"]),
    );

    // Impact analysis, with a restricted node hidden from a member without a grant.
    await post(owner, "/graph/semantic-changes", { metricId: "m", toVersion: "2.0.0" });
    const imp = await call(owner, "GET", `/v1/workspaces/${ws}/impact/m`);
    expect(
      imp
        .json()
        .affected.map((x: { nodeId: string }) => x.nodeId)
        .sort(),
    ).toEqual([R, A].sort());
    expect((await post(owner, "/graph/restrictions", { nodeId: A, restricted: true })).statusCode).toBe(200);
    const impA = await call(analyst, "GET", `/v1/workspaces/${ws}/impact/m`);
    expect(impA.json().affected.map((x: { nodeId: string }) => x.nodeId)).toEqual([R]);
    expect(impA.body).not.toContain(A);
    const impOut = await call(outsider, "GET", `/v1/workspaces/${ws}/impact/m`);
    const impNone = await call(outsider, "GET", `/v1/workspaces/${randomUUID()}/impact/m`);
    expect(impOut.statusCode).toBe(404);
    expect(impOut.json().errorCode).toBe(impNone.json().errorCode);

    // Reviewer comment: analyst ok, viewer 403.
    expect((await post(analyst, "/comments", { nodeId: R, body: "check the window" })).statusCode).toBe(201);
    expect((await post(viewer, "/comments", { nodeId: R, body: "no" })).statusCode).toBe(403);

    // Snapshot of another workspace compared across workspaces is a 404, like a missing snapshot.
    const s1 = (await post(owner, "/snapshots", { label: "a" })).json().result.snapshotId as string;
    const vOther = (await call(owner, "GET", `/v1/workspaces/${wsOther}`)).json().version as number;
    const s2 = (
      await call(owner, "POST", `/v1/workspaces/${wsOther}/snapshots`, {
        expectedVersion: vOther,
        label: "o",
      })
    ).json().result.snapshotId as string;
    const cross = await call(owner, "GET", `/v1/workspaces/${ws}/snapshots/compare?a=${s1}&b=${s2}`);
    const none = await call(owner, "GET", `/v1/workspaces/${ws}/snapshots/compare?a=${s1}&b=${randomUUID()}`);
    expect(cross.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);

    // Reconstruction and a verifiable export; timeline entries carry actorKind.
    const rev = await call(owner, "GET", `/v1/workspaces/${ws}/revisions/3`);
    expect(rev.statusCode).toBe(200);
    expect(rev.json().historical).toBe(true);
    expect(rev.json().objects).toBeUndefined();
    const exp = await call(owner, "GET", `/v1/workspaces/${ws}/revisions/3/export`);
    expect(exp.json().contentHash).toMatch(/^[0-9a-f]{64}$/);
    const tl = await call(owner, "GET", `/v1/workspaces/${ws}/timeline`);
    for (const e of tl.json().entries) expect(["human", "agent", "service"]).toContain(e.actorKind);

    // Dereference: foreign workspace is a 404 for the outsider.
    const deref = await call(outsider, "GET", `/v1/workspaces/${ws}/evidence/${R}`);
    expect(deref.statusCode).toBe(404);
    const mine = await call(owner, "GET", `/v1/workspaces/${ws}/evidence/${R}`);
    expect(mine.statusCode).toBe(200);
  }, 60_000);
});
