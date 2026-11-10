import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createTestDatabase, withTenant, type TestDatabase } from "../../../workflow/src/db.ts";
import {
  AgentToolClient,
  FakeToolGateway,
  InMemoryLeases,
  LedgerInference,
  PgAudit,
  PgLeases,
  ScriptedProvider,
  Supervisor,
  ToolCallMeter,
  INVESTIGATION_GRANT,
  loadRoles,
  makePolicy,
  scenarioHandlers,
  runRoleTask,
  type Policy,
  type PlannedChild,
  type ScriptRule,
} from "../../src/index.ts";
import type { AgentRole } from "@nearesis/contracts";
import { setupCheckpointer } from "../../src/index.ts";

export interface Rt {
  db: TestDatabase;
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  roles: ReturnType<typeof loadRoles>;
  audit: PgAudit;
  sup: Supervisor;
  policy: Policy;
  pool: pg.Pool;
  rootTaskId: string;
  /** gateway whose leases are read from the tasks table */
  gateway(handlers?: ConstructorParameters<typeof FakeToolGateway>[0]["handlers"]): FakeToolGateway;
  spawnTask(
    role: AgentRole,
    tools: string[],
    tokens?: number,
    name?: string,
  ): Promise<{ taskId: string; hypothesisId: string }>;
  runRole(a: {
    role: AgentRole;
    taskId: string;
    hypothesisId: string;
    objective: string;
    rules: ScriptRule[];
    gateway: FakeToolGateway;
    now?: () => number;
    stageDeadlineAt?: number;
    checkpointer?: Parameters<typeof runRoleTask>[0]["checkpointer"];
    provider?: ScriptedProvider;
  }): ReturnType<typeof runRoleTask>;
  stop(): Promise<void>;
}

export async function makeRt(
  policyOverrides: Partial<Policy> = {},
  opts: { checkpointer?: boolean } = {},
): Promise<Rt> {
  const db = await createTestDatabase();
  if (opts.checkpointer) await setupCheckpointer(db.adminUrl);
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const budgetId = randomUUID();
  const runId = randomUUID();
  await withTenant(db.app, tenantId, (c) =>
    c.query(
      "INSERT INTO budgets (id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000000,100000,1000)",
      [budgetId, tenantId, workspaceId],
    ),
  );
  const roles = loadRoles();
  const audit = new PgAudit(db.app);
  const policy = makePolicy(policyOverrides);
  const sup = new Supervisor(db.app, policy, audit, roles);
  const root = await sup.createRootTask({
    tenantId,
    workspaceId,
    runId,
    investigationId: randomUUID(),
    budgetId,
    snapshotRef: "s",
    role: "director",
    capabilities: [...INVESTIGATION_GRANT, ...roles.get("director")!.allowedTools],
    budget: { tokens: 100000, toolCalls: 1000, usd: 10 },
  });
  let n = 0;
  const rt: Rt = {
    db,
    tenantId,
    workspaceId,
    runId,
    budgetId,
    roles,
    audit,
    sup,
    policy,
    pool: db.app,
    rootTaskId: root.taskId,
    gateway: (handlers = scenarioHandlers()) =>
      new FakeToolGateway({
        leases: new PgLeases(db.app),
        audit,
        roles: roles as never,
        handlers,
        pool: db.app,
      }),
    async spawnTask(role, tools, tokens = 50000, name = `t${n++}`) {
      const r = await sup.spawn(
        {
          role,
          objective: name,
          workspaceId,
          allowedCapabilities: tools,
          maxChildDepth: 0,
          budget: { tokens, toolCalls: 100, usd: 5 },
        } as never,
        {
          tenantId,
          runId,
          budgetId,
          parent: {
            taskId: root.taskId,
            depth: 0,
            allowedCapabilities: [...INVESTIGATION_GRANT, "agent.spawn@1"],
          },
          dedupKey: {
            workspaceId,
            investigationId: "inv",
            task: name,
            modelVersion: "m",
            inputSnapshot: "s",
          },
          hypothesisId: `h-${name}`,
        },
      );
      return { taskId: r.taskId, hypothesisId: `h-${name}` };
    },
    async runRole(a) {
      const provider = a.provider ?? new ScriptedProvider(a.rules);
      const meter = new ToolCallMeter(db.app, policy, audit);
      const tools = new AgentToolClient({
        gateway: a.gateway,
        audit,
        meter,
        tenantId,
        workspaceId,
        runId,
        taskId: a.taskId,
        hypothesisId: a.hypothesisId,
        role: a.role,
      });
      const inference = new LedgerInference(provider, db.app, sup, {
        tenantId,
        workspaceId,
        runId,
        budgetId,
        taskId: a.taskId,
        model: "scripted-1",
      });
      return runRoleTask({
        tenantId,
        workspaceId,
        runId,
        taskId: a.taskId,
        role: a.role,
        roleCfg: roles.get(a.role)!,
        hypothesisId: a.hypothesisId,
        objective: a.objective,
        tools,
        inference,
        now: a.now ?? (() => Date.now()),
        stageDeadlineAt: a.stageDeadlineAt ?? Date.now() + 600000,
        ...(a.checkpointer ? { checkpointer: a.checkpointer } : {}),
      });
    },
    async stop() {
      await db.drop();
    },
  };
  return rt;
}

export const leasesUnused = InMemoryLeases;
export type { PlannedChild };
export async function auditRows(rt: Rt, where = "true", params: unknown[] = []) {
  return withTenant(
    rt.pool,
    rt.tenantId,
    async (c) =>
      (
        await c.query(
          `SELECT kind, reason_code, actor, detail, task_id FROM agent_audit WHERE ${where} ORDER BY id`,
          params,
        )
      ).rows as Array<{
        kind: string;
        reason_code: string | null;
        actor: string | null;
        detail: Record<string, unknown>;
        task_id: string | null;
      }>,
  );
}
export async function sql<T = Record<string, unknown>>(
  rt: Rt,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withTenant(rt.pool, rt.tenantId, async (c) => (await c.query(text, params)).rows as T[]);
}
