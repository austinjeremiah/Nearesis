import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLiveRegistry, loadRegistry } from "@nearesis/analytics";
import { DEFAULT_ENGINE_INTERFACES, Kernel } from "@nearesis/kernel";
import { FIXTURE_ROOT, TEST_KEY, TEST_PUBLISHER, createTestDb, seedOrg } from "@nearesis/kernel/testing";
import type { TestDb } from "@nearesis/kernel/testing";
import { buildApp } from "../src/app.ts";
import { catalogFromRegistries, productionMonitoringConfig } from "../src/monitoring-config.ts";
import { bearer, login } from "./helpers.ts";

/** The configuration main.ts injects (`productionMonitoringConfig()`), exercised through the real command route. */
async function setup(monitoring: ReturnType<typeof productionMonitoringConfig>) {
  const db: TestDb = await createTestDb();
  const kernel = new Kernel({
    db: db.app,
    plugins: {
      trustMode: "production",
      trustedKeys: { [TEST_PUBLISHER]: [TEST_KEY.publicKey] },
      pluginRoot: FIXTURE_ROOT,
      engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      quarantineAfterFailures: 3,
    },
    sessionSecret: "test-session-secret-0123456789abcdef",
    nodeEnv: "test",
    monitoring,
  });
  const app = await buildApp({ kernel, nodeEnv: "test" });
  const org = await seedOrg(db.admin, `mcfg-${randomUUID().slice(0, 6)}`, { alice: "owner" });
  const token = await login(app, org.users.alice!.subject);
  const ws = (
    await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(token), "idempotency-key": `mcfg-ws-${randomUUID()}` },
      payload: { objective: "o", networkScope: "fixture-only" },
    })
  ).json<{ workspaceId: string }>().workspaceId;
  const rule = async (metricId: string) => {
    const v = (
      await app.inject({ method: "GET", url: `/v1/workspaces/${ws}`, headers: bearer(token) })
    ).json<{ version: number }>().version;
    return app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(token),
      payload: {
        apiVersion: "v1",
        commandId: randomUUID(),
        commandType: "monitor.rule_create",
        payload: {
          name: "r",
          sourceId: `src-${randomUUID().slice(0, 8)}`,
          condition: { kind: "compare", metricId, op: "gt", value: 1 },
        },
        expectedVersion: v,
      },
    });
  };
  return {
    rule,
    close: async () => {
      await app.close();
      await db.drop();
    },
  };
}

describe("production monitoring configuration (what main.ts injects)", () => {
  let real: Awaited<ReturnType<typeof setup>>;
  let broken: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    real = await setup(productionMonitoringConfig());
    broken = await setup(
      productionMonitoringConfig(() => {
        throw new Error("registry unreadable");
      }),
    );
  }, 120_000);
  afterAll(async () => {
    await real?.close();
    await broken?.close();
  });

  it("builds its catalog from the real certified registries", () => {
    const cat = catalogFromRegistries([loadRegistry(), loadLiveRegistry()]);
    expect(Object.keys(cat.metrics)).toContain("near.daily_successful_tx_count");
    expect(Object.keys(cat.metrics).length).toBeGreaterThan(10);
    expect(cat.knownVersions).toContain("1.0.0");
  });

  it("rejects an unknown metric and accepts a certified one", async () => {
    const bad = await real.rule("definitely.not_a_metric");
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ reasonCode: string }>().reasonCode).toBe("UNKNOWN_METRIC");
    expect((await real.rule("near.daily_successful_tx_count")).statusCode).toBe(200);
  });

  it("fails closed when the catalog cannot be loaded: rejects, never skips validation", async () => {
    const r = await broken.rule("near.daily_successful_tx_count");
    expect(r.statusCode).not.toBe(200);
    expect(r.json<{ reasonCode: string }>().reasonCode).toBe("CATALOG_UNAVAILABLE");
  });
});
