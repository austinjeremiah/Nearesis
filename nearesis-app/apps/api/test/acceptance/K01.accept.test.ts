import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { CreateWorkspaceResponse, ErrorResponse, Workspace } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg, sansTrace } from "../helpers.ts";
import type { ApiFixture } from "../helpers.ts";

let f: ApiFixture;
beforeAll(async () => {
  f = await apiFixture();
});
afterAll(async () => f?.close());

it("K01: a member reads the workspace; an outsider gets a 404 indistinguishable from an unknown id", async () => {
  const a = await seedOrg(f.db.admin, "acme", { alice: "owner", vera: "viewer" });
  const b = await seedOrg(f.db.admin, "other", { bob: "owner" });
  const alice = await login(f.app, a.users.alice!.subject);
  const vera = await login(f.app, a.users.vera!.subject);
  const bob = await login(f.app, b.users.bob!.subject);

  const created = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(alice), "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "Why did swap volume spike?", networkScope: "fixture-only" },
  });
  expect(created.statusCode).toBe(201);
  const { workspaceId, version } = CreateWorkspaceResponse.parse(created.json());
  expect(version).toBe(1);

  // Members (owner and viewer) can read.
  for (const t of [alice, vera]) {
    const r = await f.app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}`, headers: bearer(t) });
    expect(r.statusCode).toBe(200);
    const ws = Workspace.parse(r.json());
    expect(ws.id).toBe(workspaceId);
    expect(ws.orgId).toBe(a.orgId);
    expect(ws.objective).toBe("Why did swap volume spike?");
  }

  // Outsider vs unknown id: identical status and body (minus traceId).
  const outsider = await f.app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}`,
    headers: bearer(bob),
  });
  const unknown = await f.app.inject({
    method: "GET",
    url: `/v1/workspaces/${randomUUID()}`,
    headers: bearer(bob),
  });
  expect(outsider.statusCode).toBe(404);
  expect(unknown.statusCode).toBe(404);
  ErrorResponse.parse(outsider.json());
  expect(sansTrace(outsider.json())).toEqual(sansTrace(unknown.json()));
  expect(JSON.stringify(outsider.json())).not.toContain(workspaceId);
  expect((outsider.json() as { traceId: string }).traceId).toBeTruthy();

  // Unauthenticated and forged tokens never reach data.
  const anon = await f.app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}` });
  const forged = await f.app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}`,
    headers: bearer("not.a.jwt"),
  });
  expect(anon.statusCode).toBe(401);
  expect(forged.statusCode).toBe(401);

  // Idempotent create replay returns the same workspace, not a second one.
  const key = `ws-${randomUUID()}`;
  const c1 = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(alice), "idempotency-key": key },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  const c2 = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(alice), "idempotency-key": key },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  expect(c2.json()).toEqual(c1.json());
  const n = (await f.db.admin.query("SELECT count(*)::int n FROM workspaces WHERE org_id=$1", [a.orgId]))
    .rows[0].n;
  expect(n).toBe(2);

  // Viewer cannot create.
  const vc = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(vera), "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  expect(vc.statusCode).toBe(403);

  observe({
    testId: "K01",
    observed: `HTTP: create -> 201 v${version}; owner and viewer GET -> 200 with matching projection; outsider GET -> ${outsider.statusCode} NOT_FOUND, byte-identical (sans traceId) to unknown-id GET (${unknown.statusCode}); body does not contain the workspace id; no token -> ${anon.statusCode}, forged token -> ${forged.statusCode}; idempotent create replay returned same workspace (org has ${n} workspaces); viewer create -> ${vc.statusCode}`,
    evidence: {
      outsiderBody: sansTrace(outsider.json()),
      unknownBody: sansTrace(unknown.json()),
      statuses: {
        outsider: outsider.statusCode,
        unknown: unknown.statusCode,
        anon: anon.statusCode,
        forged: forged.statusCode,
      },
    },
  });
});
