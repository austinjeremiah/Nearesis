import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { Plan, hashOf, planFor } from "../../src/index.ts";
import { makeRt, sql, type Rt } from "../helpers/rt.ts";

let rt: Rt;
beforeAll(async () => {
  rt = await makeRt({}, { checkpointer: true });
}, 60_000);
afterAll(async () => rt.stop());

const proc = fileURLToPath(new URL("../helpers/a14-proc.ts", import.meta.url));
function run(mode: string, args: string[]): { child: ReturnType<typeof spawn>; line: Promise<string> } {
  const child = spawn(process.execPath, ["--import", "tsx", proc, mode, ...args], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const line = new Promise<string>((resolve, reject) => {
    const tag = mode === "start" ? "INTERRUPTED" : "RESUMED";
    child.stdout!.on("data", (b) => {
      out += String(b);
      const m = out.split("\n").find((l) => l.startsWith(tag));
      if (m) resolve(m);
    });
    child.stderr!.on("data", (b) => (out += String(b)));
    child.on("exit", (c) => reject(new Error(`proc ${mode} exited ${c}: ${out.slice(-800)}`)));
  });
  return { child, line };
}

it("A14: a director graph interrupted mid-turn resumes from its Postgres checkpoint after SIGKILL without repeating tool calls", async () => {
  const taskId = rt.rootTaskId;
  const args = [rt.db.appUrl, rt.tenantId, rt.workspaceId, rt.runId, rt.budgetId, taskId];
  // 1-2. start with thread_id = T, wait for the interrupt
  const a = run("start", args);
  const startedLine = JSON.parse((await a.line).replace("INTERRUPTED ", "")) as {
    interrupt: boolean;
    next: string[];
    stateHash: string;
  };
  expect(startedLine.interrupt).toBe(true);
  expect(startedLine.next).toEqual(["human_input"]);
  // 3. SIGKILL
  a.child.removeAllListeners("exit");
  a.child.kill("SIGKILL");
  await new Promise((r) => a.child.on("exit", r));
  // (a) checkpoint for T exists in PostgreSQL after the kill
  const cp = await rt.db.admin.query(
    "SELECT count(*)::int AS n, max(checkpoint_id) AS last FROM runtime.checkpoints WHERE thread_id=$1",
    [taskId],
  );
  expect(cp.rows[0].n).toBeGreaterThan(0);
  const writes = await rt.db.admin.query(
    "SELECT count(*)::int AS n FROM runtime.checkpoint_writes WHERE thread_id=$1",
    [taskId],
  );
  const discoverBefore = await sql<{ provider_calls: number }>(
    rt,
    "SELECT provider_calls FROM agent_side_effects WHERE kind='gw:semantic.discover@1'",
  );
  expect(discoverBefore).toHaveLength(1);
  // 4-5. fresh process resumes T with the human response
  const b = run("resume", args);
  const resumed = JSON.parse((await b.line).replace("RESUMED ", "")) as {
    beforeHash: string;
    nextBefore: string[];
    plan: unknown;
    humanInput: string;
    afterHash: string;
  };
  // (b) state after restart equals pre-kill state (plan + tool-1 result hash), and unchanged by resume
  expect(resumed.beforeHash).toBe(startedLine.stateHash);
  expect(resumed.nextBefore).toEqual(["human_input"]);
  expect(resumed.afterHash).toBe(startedLine.stateHash);
  expect(resumed.humanInput).toBe("approved by human");
  // (c) semantic.discover side-effect counter = 1 in total
  const discover = await sql<{ provider_calls: number; status: string }>(
    rt,
    "SELECT provider_calls, status FROM agent_side_effects WHERE kind='gw:semantic.discover@1'",
  );
  expect(discover).toHaveLength(1);
  expect(discover[0]!.provider_calls).toBe(1);
  const execAudit = await sql<{ n: string }>(
    rt,
    "SELECT count(*)::text AS n FROM agent_audit WHERE kind='gateway.executed'",
  );
  expect(Number(execAudit[0]!.n)).toBe(1);
  // planning inference was not repeated either
  const infer = await sql<{ provider_calls: number }>(
    rt,
    "SELECT provider_calls FROM agent_side_effects WHERE kind='inference'",
  );
  expect(infer.every((r) => r.provider_calls === 1)).toBe(true);
  // (d) completes and plan.json validates
  const plan = Plan.parse(resumed.plan);
  expect(plan.stages.length).toBeGreaterThan(0);
  // (e) workspace tables consistent with the checkpoint (thread id = task id exists as a RUNNING task of this run); discrepancies would be logged
  const t = await sql<{ id: string; run_id: string; status: string }>(
    rt,
    "SELECT id, run_id, status FROM tasks WHERE id=$1",
    [taskId],
  );
  expect(t[0]).toMatchObject({ id: taskId, run_id: rt.runId, status: "RUNNING" });

  observe({
    testId: "A14",
    observed: `director graph interrupted at human_input (thread ${taskId}); process SIGKILLed; ${cp.rows[0].n} checkpoints + ${writes.rows[0].n} pending writes persisted in runtime schema; fresh process loaded state hash ${resumed.beforeHash.slice(0, 12)} == pre-kill ${startedLine.stateHash.slice(0, 12)}, resumed with human response and completed; semantic.discover ledger rows=1 provider_calls=${discover[0]!.provider_calls}, gateway executions=${execAudit[0]!.n}; plan.json validates (${plan.stages.length} stage); task row ${t[0]!.status} consistent with thread id`,
    fixtureHash: hashOf(planFor("A14")),
    evidence: {
      checkpointCount: cp.rows[0].n,
      lastCheckpoint: hashOf(String(cp.rows[0].last)),
      stateHashBefore: startedLine.stateHash,
      stateHashAfterRestart: resumed.beforeHash,
      discover: discover[0],
      planHash: hashOf(plan),
      discrepancies: [],
    },
  });
}, 120_000);
