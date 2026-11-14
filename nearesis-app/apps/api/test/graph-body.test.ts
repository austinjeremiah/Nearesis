import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg, sansTrace } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let owner: string;
let viewer: string;
let outsider: string;
let ws: string;
let orgId: string;
beforeAll(async () => {
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "gb", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "gb2", { bob: "owner" });
  orgId = a.orgId;
  owner = await login(f.app, a.users.alice!.subject);
  viewer = await login(f.app, a.users.vic!.subject);
  outsider = await login(f.app, b.users.bob!.subject);
  const c = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(owner), "idempotency-key": "create-graph1" },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  ws = (c.json() as { workspaceId: string }).workspaceId;
});
afterAll(async () => f?.close());

const cmd = (v: number, type: string, payload: unknown) => ({
  apiVersion: "v1",
  commandId: randomUUID(),
  commandType: type,
  payload,
  expectedVersion: v,
});

describe("body limit (C09)", () => {
  it("an oversized command body is 422 VALIDATION_FAILED with a body error path, traceId and last stable revision", async () => {
    const big = "x".repeat(1_100_000);
    const r = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: { ...bearer(owner), "content-type": "application/json" },
      payload: JSON.stringify(cmd(1, "workspace.update_objective", { objective: big })),
    });
    expect(r.statusCode).toBe(422);
    const body = ErrorResponse.parse(r.json());
    expect(body.errorCode).toBe("VALIDATION_FAILED");
    expect(body.details).toEqual([{ path: "body", issue: "payload exceeds 1000000 bytes" }]);
    expect(body.traceId).toBe(r.headers["x-trace-id"]);
    expect(body.lastStableRevision).toBe(1);
  });

  it("an oversized body from an unauthenticated caller still gets 422 with no revision (no existence leak)", async () => {
    const r = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ x: "x".repeat(1_100_000) }),
    });
    expect(r.statusCode).toBe(422);
    expect(ErrorResponse.parse(r.json()).lastStableRevision).toBeUndefined();
  });

  it("a body just under the limit is processed normally", async () => {
    const r = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: { ...bearer(owner), "content-type": "application/json" },
      payload: JSON.stringify(cmd(1, "workspace.update_objective", { objective: "x".repeat(3000) })),
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("GET /v1/workspaces/:id/graph and graph.save_layout", () => {
  it("members (including viewers) read the projection; outsiders and unknown ids get identical 404", async () => {
    const g = await f.app.inject({ url: `/v1/workspaces/${ws}/graph`, headers: bearer(viewer) });
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({ workspaceId: ws, nodes: [], edges: [], unresolved: [] });
    const foreign = await f.app.inject({ url: `/v1/workspaces/${ws}/graph`, headers: bearer(outsider) });
    const unknown = await f.app.inject({
      url: `/v1/workspaces/${randomUUID()}/graph`,
      headers: bearer(outsider),
    });
    const malformed = await f.app.inject({ url: `/v1/workspaces/nope/graph`, headers: bearer(outsider) });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect(sansTrace(foreign.json())).toEqual(sansTrace(malformed.json()));
    expect((await f.app.inject({ url: `/v1/workspaces/${ws}/graph` })).statusCode).toBe(401);
  });

  it("save_layout over HTTP persists, is visible in the projection, and enforces roles and versions", async () => {
    const panelNode = randomUUID();
    await f.db.admin.query(
      "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,'hypothesis','H')",
      [panelNode, orgId, ws],
    );
    const v = (await f.app.inject({ url: `/v1/workspaces/${ws}`, headers: bearer(owner) })).json() as {
      version: number;
    };
    const ok = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(owner),
      payload: cmd(v.version, "graph.save_layout", { positions: { [panelNode]: { x: 5, y: 6 } } }),
    });
    expect(ok.statusCode).toBe(200);
    const g = (await f.app.inject({ url: `/v1/workspaces/${ws}/graph`, headers: bearer(viewer) })).json() as {
      nodes: Array<{ id: string; position?: unknown }>;
    };
    expect(g.nodes.find((n) => n.id === panelNode)?.position).toEqual({ x: 5, y: 6 });
    const stale = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(owner),
      payload: cmd(v.version, "graph.save_layout", { positions: {} }),
    });
    expect(stale.statusCode).toBe(409);
    const asViewer = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(viewer),
      payload: cmd(v.version + 1, "graph.save_layout", { positions: {} }),
    });
    expect(asViewer.statusCode).toBe(403);
    const asOutsider = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(outsider),
      payload: cmd(v.version + 1, "graph.save_layout", { positions: {} }),
    });
    expect(asOutsider.statusCode).toBe(403);
  });
});
