import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createWs,
  createTestDb,
  loginSession,
  seedOrg,
  testKernel,
} from "../../kernel/test/helpers/index.ts";
import type { Kernel, Session } from "../../kernel/src/index.ts";
import { migrate } from "../../workflow/src/db.ts";
import { makePool } from "../../workflow/src/db.ts";
import { emitAlert, kernelAlertSink } from "../src/index.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  await migrate(makePool(db.adminUrl, 1));
  const org = await seedOrg(db.admin, "alert-sink", { alice: "owner" });
  k = testKernel(db);
  await k.boot();
  s = await loginSession(k, org.users.alice!.subject);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

it("a sent workspace alert is a notification.created journal event plus an audit row; a platform alert is an audit row with no org", async () => {
  const { workspaceId } = await createWs(k, s);
  const caps = { maxPerWindow: 5, windowSeconds: 3600, cooldownSeconds: 0 };
  const sink = kernelAlertSink(k);
  const r = await emitAlert(
    db.app.pool,
    sink,
    {
      tenantId: s.principal.orgId,
      workspaceId,
      key: "k1",
      kind: "cost.threshold",
      severity: "warning",
      title: "80%",
      detail: { fraction: 0.8 },
    },
    caps,
    new Date(),
  );
  expect(r.status).toBe("sent");
  const ev = await db.admin.query(
    "SELECT payload FROM workspace_events WHERE workspace_id=$1 AND event_type='notification.created' ORDER BY seq",
    [workspaceId],
  );
  expect(ev.rows).toHaveLength(1);
  expect(ev.rows[0].payload).toMatchObject({
    kind: "cost.threshold",
    severity: "warning",
    alertKey: "k1",
    fraction: 0.8,
  });
  const p = await emitAlert(
    db.app.pool,
    sink,
    {
      tenantId: null,
      workspaceId: null,
      key: "slo:x",
      kind: "slo.burn",
      severity: "critical",
      title: "burn",
      detail: { slo: "x" },
    },
    caps,
    new Date(),
  );
  expect(p.status).toBe("sent");
  const a = await db.admin.query("SELECT org_id, action FROM audit_events WHERE action='alert.slo.burn'");
  expect(a.rows).toHaveLength(1);
  expect(a.rows[0].org_id).toBeNull();
});
