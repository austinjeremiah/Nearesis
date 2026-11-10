/** Real-kernel runtime fixture for A03 and A11: kernel gateway + kernel capability leases + near-thesis and role-tools plugins. */
import { randomUUID } from "node:crypto";
import type { AgentRole } from "@nearesis/contracts";
import {
  AgentToolClient,
  KernelLeaseBroker,
  LedgerInference,
  PgAudit,
  ScriptedProvider,
  Supervisor,
  ToolCallMeter,
  INVESTIGATION_GRANT,
  loadRoles,
  makePolicy,
  requesterFromRuns,
  runRoleTask,
  type ScriptRule,
} from "../../src/index.ts";
import { withTenant } from "../../../workflow/src/db.ts";
import { makeKernelEnv, type KernelEnv } from "../../src/testing/kernel-env.ts";

export interface Krt {
  env: KernelEnv;
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  rootTaskId: string;
  audit: PgAudit;
  broker: KernelLeaseBroker;
  roles: ReturnType<typeof loadRoles>;
  spawnTask(
    role: AgentRole,
    tools: string[],
    name?: string,
    tokens?: number,
  ): Promise<{ taskId: string; hypothesisId: string }>;
  runRole(a: {
    role: AgentRole;
    taskId: string;
    hypothesisId: string;
    objective: string;
    rules: ScriptRule[];
    /** enforce the role allowlist client-side (default true, as in production) */
    roleAllowlist?: boolean;
  }): ReturnType<typeof runRoleTask>;
  /** kernel ground truth */
  kq<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  rq<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

export async function makeKrt(opts: { rootCapabilities?: string[] } = {}): Promise<Krt> {
  const env = await makeKernelEnv();
  const pool = env.rtdb.app;
  const tenantId = env.orgId;
  const workspaceId = env.workspaceId;
  const budgetId = randomUUID();
  const runId = randomUUID();
  await withTenant(pool, tenantId, async (c) => {
    await c.query(
      "INSERT INTO budgets (id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000000,100000,1000)",
      [budgetId, tenantId, workspaceId],
    );
    await c.query(
      `INSERT INTO runs (id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, scenario, state, requested_by, requested_role)
       VALUES ($1,$2,$3,$4,$5,'s',$6,$7,'krt','REQUESTED',$8,'owner')`,
      [runId, tenantId, workspaceId, randomUUID(), randomUUID(), budgetId, `wf-${runId}`, env.userId],
    );
  });
  const roles = loadRoles();
  const audit = new PgAudit(pool);
  const policy = makePolicy();
  const sup = new Supervisor(pool, policy, audit, roles);
  const broker = new KernelLeaseBroker({ kernel: env.kernel, requesterOf: requesterFromRuns(pool) });
  const rootCaps = opts.rootCapabilities ?? [
    ...new Set([...INVESTIGATION_GRANT, ...roles.get("director")!.allowedTools]),
  ];
  const root = await sup.createRootTask({
    tenantId,
    workspaceId,
    runId,
    investigationId: randomUUID(),
    budgetId,
    snapshotRef: "s",
    role: "director",
    capabilities: rootCaps,
    budget: { tokens: 100000, toolCalls: 1000, usd: 10 },
  });
  await broker.ensureRoot({
    tenantId,
    workspaceId,
    runId,
    taskId: root.taskId,
    role: "director",
    capabilities: rootCaps,
  });
  let n = 0;
  const krt: Krt = {
    env,
    tenantId,
    workspaceId,
    runId,
    budgetId,
    rootTaskId: root.taskId,
    audit,
    broker,
    roles,
    async spawnTask(role, tools, name = `t${n++}`, tokens = 50000) {
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
          parent: { taskId: root.taskId, depth: 0, allowedCapabilities: rootCaps },
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
      await broker.ensureChild({
        tenantId,
        workspaceId,
        runId,
        parentTaskId: root.taskId,
        taskId: r.taskId,
        role,
        capabilities: tools,
      });
      return { taskId: r.taskId, hypothesisId: `h-${name}` };
    },
    async runRole(a) {
      const provider = new ScriptedProvider(a.rules);
      const tools = new AgentToolClient({
        gateway: env.kernel.gateway,
        audit,
        meter: new ToolCallMeter(pool, policy, audit),
        tenantId,
        workspaceId,
        runId,
        taskId: a.taskId,
        hypothesisId: a.hypothesisId,
        role: a.role,
        auditGatewayDenials: true,
        ...(a.roleAllowlist === false ? {} : { roleAllowed: roles.get(a.role)!.allowedTools }),
        local: {
          "canvas.patch@1": async ({ principal, request }) => ({
            granted: await broker.hasGrant({
              tenantId,
              workspaceId: request.workspaceId,
              taskId: principal.actorId,
              capability: "canvas.patch@1",
            }),
          }),
        },
      });
      const inference = new LedgerInference(provider, pool, sup, {
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
        now: () => Date.now(),
        stageDeadlineAt: Date.now() + 600000,
      });
    },
    async kq(text, params = []) {
      return (await env.kernelAdmin.query(text, params)).rows as never;
    },
    async rq(text, params = []) {
      return withTenant(pool, tenantId, async (c) => (await c.query(text, params)).rows as never);
    },
    async stop() {
      await env.stop();
    },
  };
  return krt;
}
