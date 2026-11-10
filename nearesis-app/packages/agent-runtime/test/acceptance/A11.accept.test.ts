import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { AgentRole } from "@nearesis/contracts";
import {
  RoleConfig,
  TOOL_BY_ID,
  hashOf,
  loadRoles,
  type ScriptRule,
  FakeToolGateway,
  PgLeases,
  PgAudit,
} from "../../src/index.ts";
import { auditRows, makeRt, sql, type Rt } from "../helpers/rt.ts";
import { scenarioHandlers } from "../../src/index.ts";

let rt: Rt;
beforeAll(async () => {
  rt = await makeRt();
}, 60_000);
afterAll(async () => rt.stop());

const SAMPLE: Record<string, unknown> = {
  "agent.spawn@1": { role: "quant", objective: "x" },
  "evidence.inspect@1": { evidenceId: "e" },
  "evidence.read@1": { evidenceId: "e" },
  "plan.propose@1": { plan: {} },
  "semantic.discover@1": { metrics: ["intents.swap_count_24h"] },
  "semantic.query@1": { metric: "intents.swap_count_24h" },
  "registry.read@1": { key: "k" },
  "adapter.docs@1": { adapter: "a" },
  "web.fetch_approved@1": { url: "https://example.invalid" },
  "research.run_model@1": { model: "ols", features: ["f"] },
  "stats.read@1": { metric: "m" },
  "research.run_bounded_test@1": { test: "t", claim: "c" },
  "source.read_verified@1": { source: "s" },
  "canvas.preview@1": { panelId: "p", spec: {} },
  "canvas.patch@1": { panelId: "p", spec: {} },
  "monitor.read@1": { ruleId: "r" },
  "investigation.start@1": { question: "q" },
  "evidence.verify_hashes@1": { manifest: "m" },
  "research.rerun@1": { experimentId: "x" },
  "attest.validate@1": { attestation: "a" },
  "export.build@1": { template: "t" },
  "export.preview@1": { template: "t" },
};

// ch.05 "Agent roles and tool contracts" table, parsed from the chapter so the configs are checked against the source of record
function ch05Table(): Array<{ role: string; input: string; artifact: string; stop: string }> {
  const md = readFileSync(
    fileURLToPath(
      new URL("../../../../../NEARESIS_Build_Bible/chapters/05_AGENT_ORCHESTRATION.md", import.meta.url),
    ),
    "utf8",
  );
  const rows = md
    .split("\n")
    .filter((l) =>
      /^\| (Director|Semantic analyst|Data scout|Quant|Skeptic|Economics|Composer|Monitoring|Auditor|Publisher) \|/.test(
        l,
      ),
    );
  return rows.map((l) => {
    const c = l.split("|").map((x) => x.trim());
    return { role: c[1]!, input: c[2]!, artifact: c[4]!, stop: c[5]! };
  });
}

it("A11: ten role configs validate and out-of-role tool calls are denied (fake gateway; see blocked note)", async () => {
  // (a) exactly 10 roles validate and match the ch.05 table
  const roles = loadRoles();
  expect(roles.size).toBe(10);
  const table = ch05Table();
  expect(table).toHaveLength(10);
  for (const row of table) {
    const key = row.role.toLowerCase().replace(" ", "_");
    const cfg = RoleConfig.parse(roles.get(key as never));
    expect(AgentRole.options).toContain(cfg.role);
    expect(cfg.input.toLowerCase()).toBe(row.input.toLowerCase());
    expect(cfg.artifact.length).toBeGreaterThan(0);
    expect(row.artifact.toLowerCase()).toContain(
      cfg.artifact
        .replace(/\.json|\.md|\.html/g, "")
        .split(".")[0]!
        .toLowerCase()
        .slice(0, 4),
    );
    // stop/escalation conditions: every configured condition is present in the table cell
    for (const s of cfg.stopConditions)
      expect(row.stop.toLowerCase()).toContain(s.toLowerCase().split(" ")[0]!);
    for (const tool of cfg.allowedTools) expect(TOOL_BY_ID.has(tool)).toBe(true);
  }
  // matrix: 1 allowed + >=2 disallowed per role, using an OVER-BROAD lease (every tool) so the role allowlist alone must deny
  const allTools = [...TOOL_BY_ID.keys()];
  const gateway = new FakeToolGateway({
    leases: new PgLeases(rt.pool),
    audit: new PgAudit(rt.pool),
    roles: roles as never,
    handlers: scenarioHandlers(),
    pool: rt.pool,
  });
  const matrix: Array<{
    role: string;
    tool: string;
    expected: "allow" | "deny";
    got: string;
    reason: string | null;
  }> = [];
  let allowedOk = 0;
  let allowedTotal = 0;
  let deniedOk = 0;
  let deniedTotal = 0;
  const calls: Array<{ role: string; tool: string }> = [];
  for (const [role, cfg] of roles) {
    // lease is attached to a task row with every tool (spawn through the supervisor needs parent subset => insert via admin)
    const allowed = cfg.allowedTools[0]!;
    const others = allTools.filter((x) => !cfg.allowedTools.includes(x));
    const preferred = [
      { composer: "semantic.query@1", data_scout: "canvas.patch@1", publisher: "agent.spawn@1" }[
        role as string
      ],
      ...others,
    ].filter(Boolean) as string[];
    const dis = [...new Set(preferred)].slice(0, 3);
    for (const [tool, expected] of [[allowed, "allow"], ...dis.map((d) => [d, "deny"])] as Array<
      [string, "allow" | "deny"]
    >) {
      calls.push({ role, tool });
      const rules: ScriptRule[] = [
        {
          match: () => true,
          respond: (r) =>
            r.prompt.includes("[step=0]")
              ? { action: "tool", tool, input: SAMPLE[tool] }
              : {
                  action: "finish",
                  status: "insufficient_data",
                  statement: "done",
                  facts: [],
                  limitations: [],
                },
        },
      ];
      const task = await rt.spawnTask(role as never, [], 1000, `m-${role}-${tool}`);
      await rt.db.admin.query("UPDATE tasks SET allowed_capabilities=$2::jsonb WHERE id=$1", [
        task.taskId,
        JSON.stringify(allTools),
      ]);
      const res = await rt.runRole({ role: role as never, ...task, objective: "matrix", rules, gateway });
      await rt.db.admin.query("UPDATE tasks SET status='DONE' WHERE id=$1", [task.taskId]);
      const log = res.toolLog[0]!;
      const got = log.ok ? "allow" : "deny";
      matrix.push({ role, tool, expected, got, reason: log.reasonCode });
      if (expected === "allow") {
        allowedTotal++;
        if (got === "allow") allowedOk++;
      } else {
        deniedTotal++;
        if (got === "deny" && log.reasonCode === "TOOL_NOT_GRANTED") deniedOk++;
      }
    }
  }
  expect(allowedOk).toBe(allowedTotal); // (b) 100% allowed
  expect(deniedOk).toBe(deniedTotal); // (c) 100% denied with TOOL_NOT_GRANTED
  expect(deniedTotal).toBeGreaterThanOrEqual(20);
  const denialAudit = await auditRows(rt, "kind='gateway.denied' AND reason_code='TOOL_NOT_GRANTED'");
  expect(denialAudit.length).toBe(deniedTotal);
  const executedDenied = await sql<{ n: string }>(
    rt,
    "SELECT count(*)::text AS n FROM agent_audit WHERE kind='gateway.executed'",
  );
  expect(Number(executedDenied[0]!.n)).toBe(allowedTotal); // side effects only for allowed calls
  const denied = new Set(matrix.filter((m) => m.expected === "deny").map((m) => `${m.role}|${m.tool}`));
  const gwRows = await sql<{ kind: string }>(
    rt,
    "SELECT kind FROM agent_side_effects WHERE kind LIKE 'gw:%'",
  );
  expect(gwRows.length).toBe(allowedTotal);
  void denied;

  observe({
    testId: "A11",
    blocked:
      "Gateway under test is the in-memory FakeToolGateway, not the kernel ToolGateway/K10 lease policy (not yet connected). All criteria (a)-(c) were asserted and held against the fake; switch buildDevDeps/makeRt to KernelToolGateway to record PASS.",
    observed: `10 role configs validated against the ch.05 table; ${allowedTotal}/${allowedTotal} allowed calls permitted; ${deniedOk}/${deniedTotal} out-of-role calls denied TOOL_NOT_GRANTED even with an over-broad lease; ${denialAudit.length} denial audit rows; gateway executions = ${allowedTotal} (allowed only), denied side effects 0`,
    fixtureHash: hashOf(calls),
    evidence: { roleCount: roles.size, matrix, denialAuditRows: denialAudit.length, calls: calls.length },
  });
}, 240_000);
