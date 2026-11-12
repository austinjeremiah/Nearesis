import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CostGovernor,
  exportLedger,
  kernelSpendGateFactory,
  makePool,
  migrate as migrateRuntime,
  upsertPolicy,
  withTenant,
} from "@nearesis/workflow";
import { hostileManifest, rig } from "../../../tests/security/_plugin-harness.ts";
import type { Rig } from "../../../tests/security/_plugin-harness.ts";

/**
 * Cost control on the kernel tool gateway's egress path (NEARESIS_COST_CONTROL=1): a hostile plugin handler run by the
 * real gateway calls `ctx.egress` against an allowlisted host served locally (no real network, no paid call). Every call is
 * authorised as one `external_requests` unit BEFORE any socket opens; a refused spend never reaches the host.
 */
const HOST = "paid.example.com";
const IP = "93.184.216.34";
let svc: http.Server;
let svcPort = 0;
let served = 0;
let r: Rig;
let pool: ReturnType<typeof makePool>;
const revive = () =>
  r.db.admin.query("UPDATE plugin_installations SET state='enabled', consecutive_failures=0");
const call = async () => {
  await revive();
  return r.invoke({ action: "egress", url: `http://${HOST}/x` });
};

beforeAll(async () => {
  svc = http.createServer((_q, res) => {
    served++;
    res.end("served");
  });
  await new Promise<void>((res) => svc.listen(0, "127.0.0.1", res));
  svcPort = (svc.address() as AddressInfo).port;
  const holder: { gov?: CostGovernor } = {};
  r = await rig({
    prefix: "cost-egress",
    manifest: hostileManifest({ networkHosts: [HOST] }),
    execution: {
      egressDeps: {
        resolve: async () => [IP],
        dialOverride: (ip: string, p: number) =>
          ip === IP ? { ip: "127.0.0.1", port: svcPort } : { ip, port: p },
      },
      egressPolicy: { allowInsecureHttp: true, timeoutMs: 3000 },
      spendGate: kernelSpendGateFactory(() => holder.gov),
      paidEgressOp: (h) => (h === HOST ? "paid_api" : undefined),
    },
  });
  const admin = makePool(r.db.adminUrl, 2);
  try {
    await migrateRuntime(admin);
  } finally {
    await admin.end();
  }
  pool = makePool(r.db.appUrl, 4);
  holder.gov = new CostGovernor({ pool });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await new Promise((res) => svc?.close(() => res(null)));
  await r?.drop();
});

const setPolicy = (p: Parameters<typeof upsertPolicy>[3]) =>
  withTenant(pool, r.orgId, (c) => upsertPolicy(c, r.orgId, r.workspaceId, p, new Date()));

describe("kernel gateway egress is gated by the cost governor", () => {
  it("a paid host without the paid_api permission is refused before any socket opens", async () => {
    await setPolicy({ capUsd: 1, rates: { external_requests: 0.004 }, paidOpsPermitted: [] });
    const before = served;
    const res = await call();
    expect(res.state).toBe("failed");
    expect(served).toBe(before);
    const led = await withTenant(pool, r.orgId, (c) => exportLedger(c, r.orgId, r.workspaceId));
    expect(led.blocks.map((b) => b.reason)).toContain("PAID_OP_NOT_PERMITTED");
  });

  it("permitted calls run and are metered; the call that would pass the cap never reaches the host", async () => {
    await withTenant(pool, r.orgId, (c) =>
      c.query(
        "UPDATE runtime.cost_policies SET hard_stopped_at=NULL, hard_stop_reason=NULL WHERE tenant_id=$1",
        [r.orgId],
      ),
    );
    await setPolicy({
      capUsd: 0.01,
      rates: { external_requests: 0.004 },
      paidOpsPermitted: ["paid_api"],
    });
    const before = served;
    expect((await call()).state).toBe("ok");
    expect((await call()).state).toBe("ok");
    expect(served - before).toBe(2);
    const blocked = await call(); // 0.012 > 0.01
    expect(blocked.state).toBe("failed");
    expect(served - before).toBe(2); // the provider was never reached
    const led = await withTenant(pool, r.orgId, (c) => exportLedger(c, r.orgId, r.workspaceId));
    const dims = new Set(led.entries.map((e) => e.dimension));
    expect(dims.has("external_requests")).toBe(true);
    expect(dims.has("network_egress_bytes")).toBe(true);
    expect(led.blocks.map((b) => b.reason)).toContain("CAP_REACHED");
  });
});
