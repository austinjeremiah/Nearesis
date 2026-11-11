import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg, sansTrace } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let owner: string;
let viewer: string;
let outsider: string;
let ws: string;
beforeAll(async () => {
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "hr", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "hr2", { bob: "owner" });
  owner = await login(f.app, a.users.alice!.subject);
  viewer = await login(f.app, a.users.vic!.subject);
  outsider = await login(f.app, b.users.bob!.subject);
  const c = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(owner), "idempotency-key": "create-hist01" },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  ws = (c.json() as { workspaceId: string }).workspaceId;
});
afterAll(async () => f?.close());

const call = (
  token: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  f.app.inject({
    method,
    url,
    headers: { ...bearer(token), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

describe("history routes", () => {
  it("full flow: node -> snapshot -> branch -> change -> diff, with If-Match and Idempotency-Key", async () => {
    const n = await call(
      owner,
      "POST",
      `/v1/workspaces/${ws}/graph/nodes`,
      { kind: "claim", label: "c", data: { verdict: "open" } },
      { "if-match": '"1"', "idempotency-key": "node-key-0001" },
    );
    expect(n.statusCode).toBe(201);
    const nodeId = n.json().result.nodeId as string;
    const again = await call(
      owner,
      "POST",
      `/v1/workspaces/${ws}/graph/nodes`,
      { kind: "claim", label: "c", data: { verdict: "open" } },
      { "if-match": '"1"', "idempotency-key": "node-key-0001" },
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().result.nodeId).toBe(nodeId);

    const s = await call(owner, "POST", `/v1/workspaces/${ws}/snapshots`, {
      label: "s1",
      expectedVersion: 2,
    });
    expect(s.statusCode).toBe(201);
    const sid = s.json().result.snapshotId as string;
    const view = await call(viewer, "GET", `/v1/workspaces/${ws}/snapshots/${sid}/graph`);
    expect(view.statusCode).toBe(200);
    expect(view.json().historical).toBe(true);
    expect(view.json().graph.nodes.map((x: { id: string }) => x.id)).toContain(nodeId);

    const b = await call(owner, "POST", `/v1/workspaces/${ws}/branches`, {
      fromSnapshotId: sid,
      name: "x",
      expectedVersion: 3,
    });
    expect(b.statusCode).toBe(201);
    const bid = b.json().result.branchId as string;
    const ch = await call(owner, "POST", `/v1/workspaces/${ws}/branches/${bid}/changes`, {
      expectedVersion: 4,
      ops: [{ op: "set", objectId: "metric:m", value: { version: "2.0.0" } }],
    });
    expect(ch.statusCode).toBe(200);
    const d = await call(viewer, "GET", `/v1/workspaces/${ws}/branches/${bid}/diff`);
    expect(d.json().changes).toHaveLength(1);
    const bl = await call(viewer, "GET", `/v1/workspaces/${ws}/branches`);
    expect(bl.statusCode, bl.body).toBe(200);
    expect(bl.json().branches).toHaveLength(2);
    expect(
      (await call(viewer, "GET", `/v1/workspaces/${ws}/timeline`)).json().entries.length,
    ).toBeGreaterThan(3);
    // stale -> 409, viewer write -> 403, bad body -> 422
    expect(
      (await call(owner, "POST", `/v1/workspaces/${ws}/snapshots`, { label: "late", expectedVersion: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/snapshots`, { label: "v", expectedVersion: 5 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(owner, "POST", `/v1/workspaces/${ws}/snapshots`, { expectedVersion: 5 })).statusCode,
    ).toBe(422);
  });

  it("foreign and unknown workspaces/objects answer identical 404s on every route family", async () => {
    const unknownWs = randomUUID();
    const someId = randomUUID();
    const routes: Array<["GET" | "POST" | "PUT", (id: string) => string, unknown?]> = [
      ["GET", (id) => `/v1/workspaces/${id}/snapshots`],
      ["POST", (id) => `/v1/workspaces/${id}/snapshots`, { label: "x", expectedVersion: 1 }],
      ["GET", (id) => `/v1/workspaces/${id}/snapshots/${someId}`],
      ["GET", (id) => `/v1/workspaces/${id}/snapshots/${someId}/canvas`],
      ["GET", (id) => `/v1/workspaces/${id}/timeline`],
      ["GET", (id) => `/v1/workspaces/${id}/branches`],
      [
        "POST",
        (id) => `/v1/workspaces/${id}/branches`,
        { fromSnapshotId: someId, name: "n", expectedVersion: 1 },
      ],
      ["GET", (id) => `/v1/workspaces/${id}/branches/${someId}`],
      ["GET", (id) => `/v1/workspaces/${id}/merge-proposals`],
      ["GET", (id) => `/v1/workspaces/${id}/merge-proposals/${someId}`],
      ["POST", (id) => `/v1/workspaces/${id}/graph/nodes`, { kind: "claim", label: "x", expectedVersion: 1 }],
      [
        "POST",
        (id) => `/v1/workspaces/${id}/graph/edges`,
        { from: someId, to: randomUUID(), relation: "supports", expectedVersion: 1 },
      ],
      [
        "POST",
        (id) => `/v1/workspaces/${id}/graph/semantic-changes`,
        { metricId: "m", toVersion: "1", expectedVersion: 1 },
      ],
      ["GET", (id) => `/v1/workspaces/${id}/graph/rechecks`],
      ["GET", (id) => `/v1/workspaces/${id}/collab/layout/state`],
      ["POST", (id) => `/v1/workspaces/${id}/collab/layout/updates`, { update: "AAAA" }],
      ["GET", (id) => `/v1/workspaces/${id}/collab/layout/presence`],
      ["PUT", (id) => `/v1/workspaces/${id}/collab/layout/presence`, { state: {} }],
    ];
    for (const [m, url, body] of routes) {
      const foreign = await call(outsider, m, url(ws), body);
      const absent = await call(outsider, m, url(unknownWs), body);
      expect(foreign.statusCode, `${m} ${url(ws)}`).toBe(404);
      expect(sansTrace(foreign.json())).toEqual(sansTrace(absent.json()));
    }
    // unauthenticated
    const anon = await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}/snapshots` });
    expect(anon.statusCode).toBe(401);
    // an object of OUR workspace requested through the outsider's own workspace is also a plain 404
    const own = (
      await call(
        outsider,
        "POST",
        "/v1/workspaces",
        { objective: "o", networkScope: "fixture-only" },
        { "idempotency-key": "create-hist-out" },
      )
    ).json().workspaceId as string;
    const sid = (await call(owner, "GET", `/v1/workspaces/${ws}/snapshots`)).json().snapshots[0].id as string;
    expect((await call(outsider, "GET", `/v1/workspaces/${own}/snapshots/${sid}`)).statusCode).toBe(404);
  });

  it("collab transport: apply and read back a Yjs update; orphan edges are 422", async () => {
    // Yjs update for Y.Map("layout").set("n1", {x:3,y:4}), generated once with yjs 13.6.33.
    const update = "AQGx6JtzACgBBmxheW91dAJuMQF2AgF4fQMBeX0EAA==";
    const up = await call(owner, "POST", `/v1/workspaces/${ws}/collab/layout/updates`, { update: update });
    expect(up.statusCode).toBe(200);
    const st = await call(viewer, "GET", `/v1/workspaces/${ws}/collab/layout/state`);
    expect(st.json().decoded).toEqual({ n1: { x: 3, y: 4 } });
    expect(
      (await call(viewer, "POST", `/v1/workspaces/${ws}/collab/layout/updates`, { update: update }))
        .statusCode,
    ).toBe(403);
    expect((await call(owner, "GET", `/v1/workspaces/${ws}/collab/bogus/state`)).statusCode).toBe(404);
    const v = (await call(owner, "GET", `/v1/workspaces/${ws}`)).json().version as number;
    const orphan = await call(owner, "POST", `/v1/workspaces/${ws}/graph/edges`, {
      from: randomUUID(),
      to: randomUUID(),
      relation: "supports",
      expectedVersion: v,
    });
    expect(orphan.statusCode).toBe(422);
    expect(orphan.json().reasonCode).toBe("ORPHAN_EVIDENCE_EDGE");
  });
});
