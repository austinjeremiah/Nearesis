import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, type ScriptRule } from "../../src/index.ts";
import { auditRows, makeRt, sql, type Rt } from "../helpers/rt.ts";

let rt: Rt;
beforeAll(async () => {
  rt = await makeRt();
}, 60_000);
afterAll(async () => rt.stop());

// fx: the model hallucinates a tool, sends a malformed call, then calls a real tool it was never granted
const calls = [
  { tool: "wire.transfer@1", input: { to: "attacker", amount: "1000000" } },
  { tool: "semantic.query@1", input: { metric: "intents.swap_count_24h", unexpected: "field" } },
  { tool: "semantic.query@1", input: { metric: 42 } },
  { tool: "canvas.patch@1", input: { panelId: "p", spec: {} } },
];
const rules: ScriptRule[] = [
  {
    match: (r) => /\[step=(\d)\]/.test(r.prompt),
    respond: (r) => {
      const n = Number(/\[step=(\d+)\]/.exec(r.prompt)![1]);
      const c = calls[n];
      if (c) return { action: "tool", tool: c.tool, input: c.input };
      return {
        action: "finish",
        status: "insufficient_data",
        statement: "No tool call could be executed.",
        facts: [],
        limitations: [],
      };
    },
  },
];

it("A04: an unknown or invalid generated tool call is rejected with no execution", async () => {
  const gateway = rt.gateway();
  const t = await rt.spawnTask("semantic_analyst", ["semantic.query@1"]);
  const result = await rt.runRole({ role: "semantic_analyst", ...t, objective: "probe", rules, gateway });
  expect(result.status).toBe("finished");
  expect(result.toolLog.map((l) => l.reasonCode)).toEqual([
    "UNKNOWN_TOOL",
    "TOOL_INPUT_INVALID",
    "TOOL_INPUT_INVALID",
    "TOOL_NOT_GRANTED",
  ]);
  expect(result.toolLog.every((l) => !l.ok)).toBe(true);
  // no execution anywhere: gateway handlers never ran, ledger has no gw effect rows
  expect([...gateway.executed.values()].reduce((a, b) => a + b, 0)).toBe(0);
  const gw = await sql<{ n: string }>(
    rt,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE kind LIKE 'gw:%'",
  );
  expect(Number(gw[0]!.n)).toBe(0);
  const audits = await auditRows(rt, "task_id=$1", [t.taskId]);
  const codes = audits
    .filter((a) => a.kind.endsWith("rejected") || a.kind.endsWith("denied"))
    .map((a) => a.reason_code);
  expect(codes).toEqual(["UNKNOWN_TOOL", "TOOL_INPUT_INVALID", "TOOL_INPUT_INVALID", "TOOL_NOT_GRANTED"]);
  expect(audits.some((a) => a.kind === "gateway.executed")).toBe(false);
  // the unknown tool never even reached the gateway (policy rejection before dispatch); the ungranted one did and was denied
  expect(gateway.decisions.map((d) => d.decision)).toEqual(["deny"]);

  observe({
    testId: "A04",
    observed: `4 generated calls (1 unknown tool, 2 schema-invalid, 1 ungranted real tool): rejection reasons ${JSON.stringify(codes)}; gateway executions 0, gw ledger rows ${gw[0]!.n}, audit rows ${codes.length}, no gateway.executed audit row; agent run still finished`,
    fixtureHash: hashOf(calls),
    evidence: { toolLog: result.toolLog, auditReasons: codes, gatewayDecisions: gateway.decisions },
  });
}, 60_000);
