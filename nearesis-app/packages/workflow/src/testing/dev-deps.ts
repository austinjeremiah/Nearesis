import {
  FakeToolGateway,
  PgAudit,
  PgLeases,
  ScriptedProvider,
  INVESTIGATION_GRANT,
  loadRoles,
  makePolicy,
  scenarioHandlers,
  scenarioRules,
  type Policy,
} from "@nearesis/agent-runtime";
import type pg from "pg";
import type { ActivityDeps } from "../activities.ts";

/** Test wiring: scripted model + FAKE gateway (leases from the tasks table, idempotent through the ledger). */
export function buildDevDeps(a: {
  pool: pg.Pool;
  appUrl?: string;
  policy?: Partial<Policy>;
  stepDelayMs?: number;
}): ActivityDeps & { provider: ScriptedProvider; gateway: FakeToolGateway } {
  const audit = new PgAudit(a.pool);
  const roles = loadRoles();
  const gateway = new FakeToolGateway({
    leases: new PgLeases(a.pool),
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
    provider,
    investigationGrant: INVESTIGATION_GRANT,
    faultAt: (point, scenario) => point === "recordChildStarted" && scenario === "A18",
  };
}
