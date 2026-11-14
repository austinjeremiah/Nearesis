/** Child process for A14: `start` runs a director graph until its interrupt; `resume` continues the same thread in a fresh process. */
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import {
  CompositeLeases,
  FakeLeaseBroker,
  FakeToolGateway,
  LedgerInference,
  PgAudit,
  PgLeases,
  ScriptedProvider,
  Supervisor,
  buildDirectorGraph,
  hashOf,
  loadRoles,
  makePolicy,
  openCheckpointer,
  scenarioHandlers,
  scenarioRules,
  validatorActorId,
} from "../../src/index.ts";
import { makePool } from "../../../workflow/src/db.ts";

const [mode, appUrl, tenantId, workspaceId, runId, budgetId, taskId] = process.argv.slice(2) as string[];
const pool = makePool(appUrl!, 4);
const roles = loadRoles();
const audit = new PgAudit(pool);
const sup = new Supervisor(pool, makePolicy(), audit, roles);
const broker = new FakeLeaseBroker();
const gateway = new FakeToolGateway({
  leases: new CompositeLeases([new PgLeases(pool), broker]),
  audit,
  roles: roles as never,
  handlers: scenarioHandlers(),
  pool,
});
const saver = openCheckpointer(appUrl!);
const graph = buildDirectorGraph({
  mode: "plan",
  question: "[scenario=A14] what drove swap activity?",
  taskId: taskId!,
  roles,
  inference: new LedgerInference(new ScriptedProvider(scenarioRules()), pool, sup, {
    tenantId: tenantId!,
    workspaceId: workspaceId!,
    runId: runId!,
    budgetId: budgetId!,
    taskId: taskId!,
    model: "scripted-1",
  }),
  checkpointer: saver,
  // FND-20261110-030: plan validation runs as a semantic_analyst principal with its own derived lease (no service principal).
  discoverMetrics: async (metrics, key) => {
    const validator = validatorActorId(runId!);
    await broker.ensureChild({
      tenantId: tenantId!,
      workspaceId: workspaceId!,
      runId: runId!,
      parentTaskId: taskId!,
      taskId: validator,
      role: "semantic_analyst",
      capabilities: ["semantic.discover@1"],
    });
    const r = await gateway.invoke(
      { kind: "agent", actorId: validator, orgId: tenantId!, parentRunId: runId! },
      {
        requestId: randomUUID(),
        idempotencyKey: key,
        tenantId: tenantId!,
        workspaceId: workspaceId!,
        actor: { kind: "agent", actorId: validator, parentRunId: runId! },
        capability: "semantic.discover@1",
        input: {},
        deadlineMs: 60000,
        trace: { traceId: "t", researchRunId: runId! },
      },
    );
    const catalog = new Set(
      ((r.payload as { metrics: Array<{ id: string }> }).metrics ?? []).map((m) => m.id),
    );
    return {
      available: metrics.filter((m) => catalog.has(m)),
      missing: metrics.filter((m) => !catalog.has(m)),
    };
  },
});
const cfg = { configurable: { thread_id: taskId! }, recursionLimit: 50 };
const stateHash = (v: Record<string, unknown>) => hashOf({ plan: v.plan, validation: v.validation });
if (mode === "start") {
  const out = (await graph.invoke({}, cfg)) as Record<string, unknown>;
  const snap = await graph.getState(cfg);
  console.log(
    "INTERRUPTED " +
      JSON.stringify({
        interrupt: Boolean(out.__interrupt__),
        next: snap.next,
        stateHash: stateHash(snap.values as never),
      }),
  );
  setInterval(() => undefined, 1000); // stay alive until SIGKILLed
} else {
  const before = await graph.getState(cfg);
  const beforeHash = stateHash(before.values as never);
  const out = (await graph.invoke(new Command({ resume: "approved by human" }), cfg)) as Record<
    string,
    unknown
  >;
  console.log(
    "RESUMED " +
      JSON.stringify({
        beforeHash,
        nextBefore: before.next,
        plan: out.plan,
        humanInput: out.humanInput,
        afterHash: stateHash(out),
      }),
  );
  await saver.end();
  await pool.end();
  process.exit(0);
}
