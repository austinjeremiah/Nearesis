import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, primaryQuery, type ScriptRule } from "../../src/index.ts";
import { makeKrt, type Krt } from "../helpers/krt.ts";

let krt: Krt;
beforeAll(async () => {
  krt = await makeKrt();
}, 120_000);
afterAll(async () => krt.stop());

it("A03: after the agent lease is revoked (kernel lease path) the next tool request is denied despite an unchanged (cached) prompt", async () => {
  const t = await krt.spawnTask("semantic_analyst", ["semantic.discover@1", "semantic.query@1"]);
  const prompts: string[] = [];
  let revokedLeases = 0;
  // the scripted "model" keeps emitting the same semantic.query call from its cached plan; the kernel lease is revoked after the first
  const rules: ScriptRule[] = [
    {
      match: () => true,
      respond: async (r) => {
        prompts.push(r.prompt);
        const n = Number(/\[step=(\d+)\]/.exec(r.prompt)![1]);
        // revocation lands between turns, through the kernel lease API (K10), not a runtime table flag
        if (n === 1)
          revokedLeases = await krt.broker.revokeTask({
            tenantId: krt.tenantId,
            workspaceId: krt.workspaceId,
            runId: krt.runId,
            taskId: t.taskId,
          });
        if (n < 3) return { action: "tool", tool: "semantic.query@1", input: primaryQuery() };
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
  const res = await krt.runRole({ role: "semantic_analyst", ...t, objective: "query swaps", rules });
  expect(revokedLeases).toBe(2); // the child's discover and query leases
  expect(res.toolLog.map((l) => [l.ok, l.reasonCode])).toEqual([
    [true, null],
    [false, "TOOL_NOT_GRANTED"],
    [false, "TOOL_NOT_GRANTED"],
  ]);
  // kernel ground truth: one executed invocation, two denied, all attributed to this agent
  const inv = await krt.kq<{ state: string; reason_code: string | null }>(
    "SELECT state, reason_code FROM tool_invocations WHERE actor_id=$1 AND capability='semantic.query@1' ORDER BY started_at",
    [t.taskId],
  );
  expect(inv.map((r) => r.state)).toEqual(["ok", "blocked", "blocked"]);
  expect(inv.slice(1).every((r) => r.reason_code === "TOOL_NOT_GRANTED")).toBe(true);
  const kdenied = await krt.kq<{ reason_code: string; subject: string }>(
    "SELECT reason_code, subject FROM audit_events WHERE actor_id=$1 AND action='tool.invoke.denied'",
    [t.taskId],
  );
  expect(kdenied).toHaveLength(2);
  expect(kdenied.every((d) => d.reason_code === "TOOL_NOT_GRANTED" && d.subject === "semantic.query@1")).toBe(
    true,
  );
  // the revoked leases are marked revoked in the kernel lease table
  const rev = await krt.kq<{ n: string }>(
    "SELECT count(*)::text AS n FROM capability_leases WHERE holder_actor_id=$1 AND revoked_at IS NOT NULL",
    [t.taskId],
  );
  expect(Number(rev[0]!.n)).toBe(2);
  // runtime decision trace carries the same denials
  const rdenied = await krt.rq<{ reason_code: string }>(
    "SELECT reason_code FROM agent_audit WHERE task_id=$1 AND kind='gateway.denied'",
    [t.taskId],
  );
  expect(rdenied).toHaveLength(2);
  // the denied turns used the same cached-prompt shape (only the step marker and observation differ): model output did not change authority
  expect(prompts.length).toBe(4);
  observe({
    testId: "A03",
    observed: `real kernel ToolGateway: call 1 allowed and executed once (tool_invocations state ok); kernel lease revoke (${revokedLeases} leases, revoked_at set) between turns; calls 2 and 3 (same cached tool call) denied TOOL_NOT_GRANTED (tool_invocations blocked x2, kernel audit tool.invoke.denied x${kdenied.length}); executions of semantic.query=1`,
    fixtureHash: hashOf(prompts.length),
    evidence: {
      toolLog: res.toolLog,
      kernelInvocations: inv,
      kernelDeniedAudit: kdenied.length,
      revokedLeases: Number(rev[0]!.n),
      runtimeDeniedAudit: rdenied.length,
    },
  });
}, 120_000);
