import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { ErrorResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg, sansTrace } from "../helpers.ts";
import type { ApiFixture } from "../helpers.ts";

let f: ApiFixture;
beforeAll(async () => {
  f = await apiFixture();
});
afterAll(async () => f?.close());

const cmd = (commandType: string, payload: Record<string, unknown>, expectedVersion: number) => ({
  apiVersion: "v1",
  commandId: randomUUID(),
  commandType,
  payload,
  expectedVersion,
});

it("K04: cross-tenant marker injection is denied with 403 and leaks no object existence", async () => {
  const a = await seedOrg(f.db.admin, "victim", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "attacker", { bob: "owner" });
  const alice = await login(f.app, a.users.alice!.subject);
  const bob = await login(f.app, b.users.bob!.subject);

  const mk = async (token: string) => {
    const r = await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(token), "idempotency-key": `ws-${randomUUID()}` },
      payload: { objective: "o", networkScope: "fixture-only" },
    });
    return (r.json() as { workspaceId: string }).workspaceId;
  };
  const wa = await mk(alice);
  const wb = await mk(bob);
  const panelA = randomUUID();
  const panelB = randomUUID();
  await f.db.admin.query(
    "INSERT INTO panels(id, org_id, workspace_id, kind) VALUES ($1,$2,$3,'chart'),($4,$5,$6,'chart')",
    [panelA, a.orgId, wa, panelB, b.orgId, wb],
  );

  const snapshot = async () => ({
    markers: (await f.db.admin.query("SELECT count(*)::int n FROM markers")).rows[0].n as number,
    eventsA: (
      await f.db.admin.query("SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1", [wa])
    ).rows[0].n as number,
    versionA: (await f.db.admin.query("SELECT version FROM workspaces WHERE id=$1", [wa])).rows[0]
      .version as number,
  });
  const before = await snapshot();
  const post = (ws: string, c: unknown, token = bob) =>
    f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: { ...bearer(token), "if-match": "1" },
      payload: c as object,
    });

  // (1) Attacker targets the victim workspace directly, with a real victim panel id.
  const direct = await post(
    wa,
    cmd("marker.create", { panelId: panelA, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } }, 1),
  );
  // (2) Same, against a workspace id that does not exist.
  const ghostWs = await post(
    randomUUID(),
    cmd("marker.create", { panelId: panelA, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } }, 1),
  );
  // (3) Attacker uses its OWN workspace but injects the victim's panel id.
  const viaPanel = await post(
    wb,
    cmd("marker.create", { panelId: panelA, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } }, 1),
  );
  // (4) Same, with a panel id that does not exist anywhere.
  const ghostPanel = await post(
    wb,
    cmd(
      "marker.create",
      { panelId: randomUUID(), anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } },
      1,
    ),
  );

  for (const r of [direct, ghostWs, viaPanel, ghostPanel]) {
    expect(r.statusCode).toBe(403);
    ErrorResponse.parse(r.json());
  }
  // Existing and non-existing objects are indistinguishable.
  expect(sansTrace(direct.json())).toEqual(sansTrace(ghostWs.json()));
  expect(sansTrace(viaPanel.json())).toEqual(sansTrace(ghostPanel.json()));
  for (const r of [direct, viaPanel]) {
    const s = JSON.stringify(r.json());
    expect(s).not.toContain(panelA);
    expect(s).not.toContain(wa);
  }

  const after = await snapshot();
  expect(after).toEqual(before);
  const injected = (
    await f.db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1 OR panel_id=$2", [
      wa,
      panelA,
    ])
  ).rows[0].n;
  expect(injected).toBe(0);
  const denyAudit = (
    await f.db.admin.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='access.denied' AND actor_id=$1",
      [b.users.bob!.userId],
    )
  ).rows[0].n;
  expect(denyAudit).toBe(4);

  // Positive control: attacker's own panel in its own workspace works.
  const own = await post(
    wb,
    cmd("marker.create", { panelId: panelB, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } }, 1),
  );
  expect(own.statusCode).toBe(200);
  const ownMarkers = (
    await f.db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1", [wb])
  ).rows[0].n;
  expect(ownMarkers).toBe(1);

  observe({
    testId: "K04",
    observed: `4 injection attempts (direct victim workspace, nonexistent workspace, victim panel via own workspace, nonexistent panel) all -> 403 ACCESS_DENIED; existing-vs-nonexistent response bodies identical (sans traceId) and contain neither victim workspace nor panel id; markers/events/version in victim workspace unchanged (${JSON.stringify(after)}); 0 injected markers; 4 access.denied audit rows; own-panel control -> 200`,
    evidence: {
      statuses: [direct, ghostWs, viaPanel, ghostPanel].map((r) => r.statusCode),
      body: sansTrace(direct.json()),
      before,
      after,
      injected,
      denyAudit,
    },
  });
});
