import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, type ScriptRule } from "../../src/index.ts";
import { auditRows, makeRt, sql, type Rt } from "../helpers/rt.ts";

let rt: Rt;
beforeAll(async () => {
  rt = await makeRt();
}, 60_000);
afterAll(async () => rt.stop());

it("A03: after the agent lease is revoked the next tool request is denied despite an unchanged (cached) prompt", async () => {
  const gateway = rt.gateway();
  const t = await rt.spawnTask("semantic_analyst", ["semantic.discover@1", "semantic.query@1"]);
  const prompts: string[] = [];
  // the scripted "model" keeps emitting the same semantic.query call from its cached plan; the lease is revoked after the first
  const rules: ScriptRule[] = [
    {
      match: () => true,
      respond: async (r) => {
        prompts.push(r.prompt);
        const n = Number(/\[step=(\d+)\]/.exec(r.prompt)![1]);
        if (n === 1) await rt.db.admin.query("UPDATE tasks SET lease_revoked=true WHERE id=$1", [t.taskId]); // revocation lands between turns
        if (n < 3)
          return { action: "tool", tool: "semantic.query@1", input: { metric: "intents.swap_count_24h" } };
        return {
          action: "finish",
          status: "insufficient_data",
          statement: "Lease revoked; stopped.",
          facts: [],
          limitations: ["lease revoked"],
        };
      },
    },
  ];
  const res = await rt.runRole({ role: "semantic_analyst", ...t, objective: "query swaps", rules, gateway });
  expect(res.toolLog.map((l) => [l.ok, l.reasonCode])).toEqual([
    [true, null],
    [false, "TOOL_NOT_GRANTED"],
    [false, "TOOL_NOT_GRANTED"],
  ]);
  expect(gateway.executed.get("semantic.query@1")).toBe(1);
  const exec = await sql<{ n: string }>(
    rt,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE kind='gw:semantic.query@1'",
  );
  expect(Number(exec[0]!.n)).toBe(1);
  const denied = await auditRows(rt, "task_id=$1 AND kind='gateway.denied'", [t.taskId]);
  expect(denied).toHaveLength(2);
  expect(
    denied.every(
      (d) => d.reason_code === "TOOL_NOT_GRANTED" && (d.detail as { revoked: boolean }).revoked === true,
    ),
  ).toBe(true);
  // the denied turn used the same cached-prompt shape (only the step marker and observation differ), i.e. model output did not change authority
  expect(prompts.length).toBe(4);
  observe({
    testId: "A03",
    blocked:
      "Lease store under test is the fake gateway's PgLeases (tasks.lease_revoked), not the kernel capability_leases/K10 revocation path (not yet connected). Criteria asserted and held against the fake; switch to KernelToolGateway with a revoked kernel lease to record PASS.",
    observed: `call 1 allowed and executed once; lease revoked between turns; calls 2 and 3 (same cached tool call) denied TOOL_NOT_GRANTED with revoked=true audit rows (${denied.length}); gateway executions of semantic.query=1`,
    fixtureHash: hashOf(prompts.length),
    evidence: { toolLog: res.toolLog, deniedAudit: denied.length, executions: 1 },
  });
}, 60_000);
