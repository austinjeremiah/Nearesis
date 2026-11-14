import {
  CompositeLeases,
  FakeLeaseBroker,
  FakeToolGateway,
  PgAudit,
  PgLeases,
  ScriptedProvider,
  INVESTIGATION_GRANT,
  loadRoles,
  makePolicy,
  runInternalEffect,
  scenarioHandlers,
  scenarioRules,
  type Policy,
} from "@nearesis/agent-runtime";
import type pg from "pg";
import type { ActivityDeps } from "../activities.ts";

/**
 * UNIT-TEST wiring only: scripted model + FAKE gateway (leases from the tasks table plus an in-memory broker for the
 * plan-validation principal) + a no-op canvas executor. Acceptance tests that require the real kernel use
 * `buildKernelDeps` (./kernel-deps.ts).
 */
export function buildDevDeps(a: {
  pool: pg.Pool;
  appUrl?: string;
  policy?: Partial<Policy>;
  stepDelayMs?: number;
}): ActivityDeps & { provider: ScriptedProvider; gateway: FakeToolGateway } {
  const audit = new PgAudit(a.pool);
  const roles = loadRoles();
  const leases = new FakeLeaseBroker();
  const gateway = new FakeToolGateway({
    leases: new CompositeLeases([new PgLeases(a.pool), leases]),
    audit,
    roles: roles as never,
    handlers: scenarioHandlers(),
    pool: a.pool,
  });
  const provider = new ScriptedProvider(scenarioRules({ stepDelayMs: a.stepDelayMs ?? 0 }));
  return {
    pool: a.pool,
    ...(a.appUrl ? { appUrl: a.appUrl } : {}),
    policy: makePolicy(a.policy ?? {}),
    audit,
    gateway,
    leases,
    // Stand-in for the kernel canvas command: records the same gateway-level ledger row the fake gateway used to.
    canvas: {
      apply: async (c) => {
        await runInternalEffect(
          a.pool,
          {
            tenantId: c.tenantId,
            runId: c.runId,
            effectKey: `gw:canvas.patch@1:priv-${c.actionHash}`,
            kind: "gw:canvas.patch@1",
          },
          async () => ({ state: "ok" }),
        );
        return { state: "ok" };
      },
    },
    provider,
    investigationGrant: INVESTIGATION_GRANT,
    faultAt: (point, scenario) => point === "recordChildStarted" && scenario === "A18",
  };
}
