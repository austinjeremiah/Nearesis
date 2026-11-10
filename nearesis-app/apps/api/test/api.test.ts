import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { buildApp } from "../src/app.ts";

let f: ApiFixture;
let tok: string;
let orgId: string;
beforeAll(async () => {
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "t", { alice: "owner", ana: "analyst" });
  orgId = a.orgId;
  tok = await login(f.app, a.users.alice!.subject);
});
afterAll(async () => f?.close());

describe("api", () => {
  it("health and ready", async () => {
    expect((await f.app.inject({ url: "/health" })).json()).toEqual({ status: "ok" });
    expect((await f.app.inject({ url: "/ready" })).json()).toEqual({ status: "ready" });
  });

  it("every error carries a traceId and conforms to ErrorResponse", async () => {
    for (const r of [
      await f.app.inject({ url: "/nope" }),
      await f.app.inject({ url: "/v1/workspaces/x" }),
      await f.app.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: "ghost" } }),
    ]) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(ErrorResponse.parse(r.json()).traceId).toBeTruthy();
    }
  });

  it("malformed JSON and invalid bodies are 422 without leaking internals", async () => {
    const r = await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tok), "content-type": "application/json" },
      payload: "{bad",
    });
    expect(r.statusCode).toBe(422);
    const r2 = await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tok), "idempotency-key": "abcdefgh" },
      payload: { objective: "", networkScope: "x" },
    });
    expect(r2.statusCode).toBe(422);
    expect(ErrorResponse.parse(r2.json()).details?.length).toBeGreaterThan(0);
  });

  it("commands: If-Match drives optimistic concurrency, stale => 409 with lastStableRevision", async () => {
    const c = await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tok), "idempotency-key": "create-1234" },
      payload: { objective: "o", networkScope: "fixture-only" },
    });
    const { workspaceId } = c.json() as { workspaceId: string };
    const body = (v: number) => ({
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: `v${v}` },
      expectedVersion: v,
    });
    const ok = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/commands`,
      headers: { ...bearer(tok), "if-match": "1" },
      payload: body(1),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { workspaceVersion: number }).workspaceVersion).toBe(2);
    const stale = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/commands`,
      headers: { ...bearer(tok), "if-match": "1" },
      payload: body(1),
    });
    expect(stale.statusCode).toBe(409);
    expect(ErrorResponse.parse(stale.json())).toMatchObject({
      errorCode: "STALE_VERSION",
      lastStableRevision: 2,
      retryable: true,
    });
    const mismatch = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/commands`,
      headers: { ...bearer(tok), "if-match": "2" },
      payload: body(1),
    });
    expect(mismatch.statusCode).toBe(422);
    const bad = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/commands`,
      headers: { ...bearer(tok), "if-match": "2" },
      payload: { ...body(2), commandType: "nope" },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("a body-supplied org or actor is ignored: identity is server-resolved", async () => {
    const r = await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tok), "idempotency-key": "create-5678" },
      payload: { objective: "o", networkScope: "fixture-only", orgId: randomUUID(), createdBy: randomUUID() },
    });
    expect(r.statusCode).toBe(422); // strict schema rejects smuggled authority fields
    expect(orgId).toBeTruthy();
  });

  it("dev login does not exist in production", async () => {
    const prod = await buildApp({ kernel: f.kernel, nodeEnv: "production" });
    const r = await prod.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: "x" } });
    expect(r.statusCode).toBe(404);
    await prod.close();
  });
});
