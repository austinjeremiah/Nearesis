import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { KernelError } from "../../src/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { randomUUID } from "node:crypto";
import {
  cap,
  createTestDb,
  createWs,
  execReq,
  grant,
  inHours,
  loginSession,
  makeManifest,
  pluginUp,
  seedOrg,
  testKernel,
} from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const org = await seedOrg(db.admin, "k10", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

const CAP = "fx_plugin_echo.say@1";

async function denied(p: Promise<unknown>): Promise<KernelError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KernelError);
    return e as KernelError;
  }
  throw new Error("expected denial");
}

it("K10: a child lease is a subset of its parent only", async () => {
  await k.plugins.install(
    null,
    makeManifest({
      pluginId: "fx-plugin-echo",
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
      capabilities: [cap(CAP, { requiredGrants: ["fx:run"] })],
    }),
  );
  await k.plugins.enable(null, "fx-plugin-echo");
  const { workspaceId, version } = await createWs(k, s);
  await pluginUp(k, s, workspaceId, version, "fx-plugin-echo");

  const parentExp = inHours(2);
  const parent = await k.leases.issue(s, {
    workspaceId,
    holderActorId: s.principal.actorId,
    capability: CAP,
    grants: [
      grant({ maxCost: 10, expiresAt: parentExp }),
      grant({ resource: "fx", action: "read", maxCost: 5, expiresAt: parentExp }),
    ],
    expiresAt: parentExp,
  });
  const agent = randomUUID();
  const asChild = (over: Record<string, unknown>) =>
    k.leases.derive(s, parent.id, {
      holderActorId: agent,
      grants: [grant({ maxCost: 3, expiresAt: inHours(1) })],
      expiresAt: inHours(1),
      ...over,
    });

  // Allowed: strict subset.
  const child = await asChild({});
  expect(child.parentLeaseId).toBe(parent.id);
  expect(child.grants).toHaveLength(1);

  // Denied: grant not in parent, higher maxCost, later expiry (grant and lease), different capability.
  const e1 = await denied(
    asChild({ grants: [grant({ action: "write", maxCost: 1, expiresAt: inHours(1) })] }),
  );
  const e2 = await denied(asChild({ grants: [grant({ maxCost: 11, expiresAt: inHours(1) })] }));
  const e3 = await denied(asChild({ grants: [grant({ maxCost: 3, expiresAt: inHours(3) })] }));
  const e4 = await denied(asChild({ expiresAt: inHours(3) }));
  const e5 = await denied(asChild({ capability: "fx_plugin_echo.other@1" }));
  for (const e of [e1, e2, e3, e4, e5]) expect(e.reasonCode).toBe("LEASE_EXPANSION_DENIED");
  expect(e1.opts.details?.[0]?.issue).toMatch(/not held/);
  expect(e2.opts.details?.[0]?.issue).toMatch(/maxCost/);

  // Denials are audited and nothing was created.
  const audits = (
    await db.admin.query("SELECT count(*)::int n FROM audit_events WHERE action='lease.derive_denied'")
  ).rows[0].n;
  expect(audits).toBe(5);
  const leaseCount = (
    await db.admin.query("SELECT count(*)::int n FROM capability_leases WHERE workspace_id=$1", [workspaceId])
  ).rows[0].n;
  expect(leaseCount).toBe(2);

  // Grandchild must be a subset of the child, not just of the root.
  const e6 = await denied(
    k.leases.derive(s, child.id, {
      holderActorId: randomUUID(),
      grants: [grant({ maxCost: 4, expiresAt: inHours(1) })],
      expiresAt: inHours(1),
    }),
  );
  expect(e6.reasonCode).toBe("LEASE_EXPANSION_DENIED");

  // Authority at the gateway: the agent holding the child lease can call only what the child grants, and
  // a child cannot use the broader parent grants. The agent principal is server-side.
  const agentP = { kind: "agent" as const, actorId: agent, orgId: s.principal.orgId };
  const okRes = await k.gateway.invoke(agentP, {
    ...execReq(s, workspaceId, CAP, {}),
    actor: { kind: "agent", actorId: agent },
  });
  expect(okRes.state).toBe("ok");
  // Revoking the parent invalidates the child immediately.
  await k.leases.revoke(s, parent.id);
  const after = await k.gateway.invoke(agentP, {
    ...execReq(s, workspaceId, CAP, {}),
    actor: { kind: "agent", actorId: agent },
  });
  expect(after.state).toBe("blocked");
  expect(after.reasonCode).toBe("TOOL_NOT_GRANTED");

  observe({
    testId: "K10",
    observed: `valid subset child accepted; 5 expansion attempts (extra grant, maxCost 11>10, later grant expiry, later lease expiry, different capability) all denied LEASE_EXPANSION_DENIED with 5 audit rows and no lease rows created (leases=${leaseCount}); grandchild exceeding child denied; child lease invokes ok then after parent revocation -> ${after.reasonCode}`,
    evidence: {
      denials: [e1, e2, e3, e4, e5, e6].map((e) => ({ reasonCode: e.reasonCode, details: e.opts.details })),
      auditRows: audits,
      leaseCount,
      afterRevoke: after.reasonCode,
    },
  });
});
