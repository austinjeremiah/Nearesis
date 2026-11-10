import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Kernel, Session } from "../../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
let orgId: string;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const org = await seedOrg(db.admin, "k03", { alice: "owner" });
  orgId = org.orgId;
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

it("K03: retrying the same command ID yields one event, one object and the same result fingerprint", async () => {
  const { workspaceId } = await createWs(k, s);
  const panelId = randomUUID();
  await db.admin.query("INSERT INTO panels(id, org_id, workspace_id, kind) VALUES ($1,$2,$3,'chart')", [
    panelId,
    orgId,
    workspaceId,
  ]);

  const commandId = randomUUID();
  const payload = { panelId, anchor: { x: 1, y: 2 } };
  const r1 = await runCmd(k, s, workspaceId, "marker.create", payload, 1, commandId);
  // Sequential retries (the workspace version has since moved on, so a naive CAS would fail), then a concurrent burst.
  const r2 = await runCmd(k, s, workspaceId, "marker.create", payload, 1, commandId);
  const burst = await Promise.all(
    Array.from({ length: 8 }, () => runCmd(k, s, workspaceId, "marker.create", payload, 1, commandId)),
  );

  for (const r of [r2, ...burst]) expect(r).toEqual(r1);

  const events = (
    await db.admin.query(
      "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND causation_id=$2",
      [workspaceId, commandId],
    )
  ).rows[0].n;
  const markers = (
    await db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1", [workspaceId])
  ).rows[0].n;
  const cmds = (
    await db.admin.query("SELECT count(*)::int n FROM commands WHERE workspace_id=$1", [workspaceId])
  ).rows[0].n;
  const outbox = (
    await db.admin.query(
      "SELECT count(*)::int n FROM outbox o JOIN workspace_events e ON e.event_id=o.event_id WHERE e.causation_id=$1",
      [commandId],
    )
  ).rows[0].n;
  const version = (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [workspaceId])).rows[0]
    .version;
  expect(events).toBe(1);
  expect(markers).toBe(1);
  expect(cmds).toBe(1);
  expect(outbox).toBe(1);
  expect(version).toBe(2);

  observe({
    testId: "K03",
    observed: `1 original + 1 sequential + 8 concurrent submissions of commandId: events=${events}, markers=${markers}, commands=${cmds}, outbox=${outbox}, workspace version=${version}; all 10 responses identical, fingerprint ${r1.resultFingerprint.slice(0, 16)}...`,
    evidence: { first: r1, retriesIdentical: 9, events, markers, commands: cmds, outbox, version },
  });
});
