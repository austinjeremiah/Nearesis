import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { AgentRole } from "@nearesis/contracts";
import {
  RoleConfig,
  TOOL_BY_ID,
  grantFor,
  hashOf,
  loadRoles,
  primaryQuery,
  vizRequests,
  type ScriptRule,
} from "../../src/index.ts";
import { inHours } from "./kernel-helpers.ts";
import { makeKrt, type Krt } from "../helpers/krt.ts";

let krt: Krt;
beforeAll(async () => {
  // the matrix exercises every role, so the run grant (root leases) covers the whole catalog
  krt = await makeKrt({ rootCapabilities: [...TOOL_BY_ID.keys()] });
}, 120_000);
afterAll(async () => krt.stop());

/** Schema-valid sample input per catalog tool (the real near-thesis schemas for semantic.* and canvas.preview). */
const SAMPLE: Record<string, unknown> = {
  "agent.spawn@1": { role: "quant", objective: "x" },
  "evidence.inspect@1": { evidenceId: "e" },
  "evidence.read@1": { evidenceId: "e" },
  "plan.propose@1": { plan: {} },
  "semantic.discover@1": {},
  "semantic.query@1": primaryQuery(),
  "registry.read@1": { key: "k" },
  "adapter.docs@1": { adapter: "a" },
  "web.fetch_approved@1": { url: "https://example.invalid" },
  "research.run_model@1": { model: "ols", features: ["f"] },
  "stats.read@1": { metric: "m" },
  "research.run_bounded_test@1": { test: "t", claim: "c" },
  "source.read_verified@1": { source: "s" },
  "canvas.preview@1": { expectedRevision: 0, requests: vizRequests() },
  "canvas.patch@1": { proposal: "p" },
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
  const rowRe =
    /^\| (Director|Semantic analyst|Data scout|Quant|Skeptic|Economics|Composer|Monitoring|Auditor|Publisher) \|/;
  const vendored = readFileSync(
    fileURLToPath(new URL("../fixtures/ch05_roles_table.md", import.meta.url)),
    "utf8",
  );
  // when the Bible is present locally, the vendored snapshot must not have drifted
  const bible = fileURLToPath(
    new URL("../../../../../NEARESIS_Build_Bible/chapters/05_AGENT_ORCHESTRATION.md", import.meta.url),
  );
  if (existsSync(bible)) {
    const live = readFileSync(bible, "utf8")
      .split("\n")
      .filter((l) => rowRe.test(l));
    expect(vendored.split("\n").filter((l) => rowRe.test(l))).toEqual(live);
  }
  const md = vendored;
  const rows = md.split("\n").filter((l) => rowRe.test(l));
  return rows.map((l) => {
    const c = l.split("|").map((x) => x.trim());
    return { role: c[1]!, input: c[2]!, artifact: c[4]!, stop: c[5]! };
  });
}

type Row = {
  pass: string;
  role: string;
  tool: string;
  expected: "allow" | "deny";
  got: string;
  reason: string | null;
};

it("A11: ten role configs validate and out-of-role tool calls are denied by the real kernel gateway and lease policy", async () => {
  // (a) exactly 10 roles validate and match the ch.05 table
  const roles = loadRoles();
  expect(roles.size).toBe(10);
  const tableRows = ch05Table();
  expect(tableRows).toHaveLength(10);
  for (const row of tableRows) {
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
    for (const s of cfg.stopConditions)
      expect(row.stop.toLowerCase()).toContain(s.toLowerCase().split(" ")[0]!);
    for (const tool of cfg.allowedTools) expect(TOOL_BY_ID.has(tool)).toBe(true);
  }

  const allTools = [...TOOL_BY_ID.keys()];
  const matrix: Row[] = [];
  const calls: Array<{ pass: string; role: string; tool: string }> = [];
  const taskPass = new Map<string, string>();
  const scripted = (tool: string): ScriptRule[] => [
    {
      match: () => true,
      respond: (r) =>
        r.prompt.includes("[step=0]")
          ? { action: "tool", tool, input: SAMPLE[tool] }
          : { action: "finish", status: "insufficient_data", statement: "done", facts: [], limitations: [] },
    },
  ];
  // Pass K: the lease equals the role allowlist (how the supervisor issues it) and the KERNEL alone decides.
  // Pass B: an over-broad lease (every tool) is issued by a human admin; the runtime role allowlist must still deny.
  for (const pass of ["K", "B"] as const) {
    for (const [role, cfg] of roles) {
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
        calls.push({ pass, role, tool });
        const task = await krt.spawnTask(role as never, cfg.allowedTools, `m-${pass}-${role}-${tool}`, 1000);
        taskPass.set(task.taskId, pass);
        if (pass === "B") {
          for (const cap of others) {
            const g = grantFor(cap);
            await krt.env.kernel.leases.issue(
              {
                principal: { kind: "human", actorId: krt.env.userId, orgId: krt.tenantId } as never,
                userId: krt.env.userId,
              },
              {
                workspaceId: krt.workspaceId,
                holderActorId: task.taskId,
                capability: cap,
                grants: [{ ...g, maxCost: 10, expiresAt: inHours(1) }],
                expiresAt: inHours(1),
              },
            );
          }
        }
        const res = await krt.runRole({
          role: role as never,
          ...task,
          objective: "matrix",
          rules: scripted(tool),
          roleAllowlist: pass === "B",
        });
        await krt.rq("UPDATE tasks SET status='DONE' WHERE id=$1", [task.taskId]);
        const log = res.toolLog[0]!;
        matrix.push({ pass, role, tool, expected, got: log.ok ? "allow" : "deny", reason: log.reasonCode });
      }
    }
  }
  const allowedRows = matrix.filter((m) => m.expected === "allow");
  const deniedRows = matrix.filter((m) => m.expected === "deny");
  expect(allowedRows.every((m) => m.got === "allow")).toBe(true); // (b) 100% allowed
  expect(deniedRows.every((m) => m.got === "deny" && m.reason === "TOOL_NOT_GRANTED")).toBe(true); // (c)
  expect(deniedRows.length).toBeGreaterThanOrEqual(40); // >= 20 per pass

  // (c) audit record for every denial (runtime decision trace) and kernel ground truth
  const rdenied = await krt.rq<{ reason_code: string; detail: { layer: string } }>(
    "SELECT reason_code, detail FROM agent_audit WHERE kind='gateway.denied'",
  );
  expect(rdenied).toHaveLength(deniedRows.length);
  expect(rdenied.every((d) => d.reason_code === "TOOL_NOT_GRANTED")).toBe(true);
  const kPassDenied = deniedRows.filter((m) => m.pass === "K");
  // canvas.patch@1 is a runtime command tool gated by the same kernel lease table, so the kernel gateway never sees it
  const kernelDeniedExpected = kPassDenied.filter((m) => m.tool !== "canvas.patch@1").length;
  const kdenied = await krt.kq<{ actor_id: string; reason_code: string; subject: string }>(
    "SELECT actor_id, reason_code, subject FROM audit_events WHERE action='tool.invoke.denied'",
  );
  expect(kdenied).toHaveLength(kernelDeniedExpected);
  expect(kdenied.every((d) => d.reason_code === "TOOL_NOT_GRANTED" && taskPass.get(d.actor_id) === "K")).toBe(
    true,
  );
  const layerCounts = rdenied.reduce<Record<string, number>>(
    (a, d) => ((a[d.detail.layer] = (a[d.detail.layer] ?? 0) + 1), a),
    {},
  );
  expect(layerCounts.role_allowlist).toBe(deniedRows.filter((m) => m.pass === "B").length);
  expect((layerCounts.gateway ?? 0) + (layerCounts.kernel_lease ?? 0)).toBe(kPassDenied.length);

  // side-effect counters: executed invocations exist only for allowed calls; denied tools never executed
  const okInv = await krt.kq<{ capability: string; n: string }>(
    "SELECT capability, count(*)::text AS n FROM tool_invocations WHERE state='ok' GROUP BY capability",
  );
  const okByCap = Object.fromEntries(okInv.map((r) => [r.capability, Number(r.n)]));
  const allowedByCap: Record<string, number> = {};
  for (const m of allowedRows)
    if (m.tool !== "canvas.patch@1") allowedByCap[m.tool] = (allowedByCap[m.tool] ?? 0) + 1;
  expect(okByCap).toEqual(allowedByCap);
  const fx = (globalThis as unknown as { __roleToolsExec?: Record<string, number> }).__roleToolsExec ?? {};
  for (const tool of allTools)
    if (!["semantic.query@1", "semantic.discover@1", "canvas.preview@1", "canvas.patch@1"].includes(tool))
      expect(fx[tool] ?? 0).toBe(allowedByCap[tool] ?? 0);

  observe({
    testId: "A11",
    observed: `10 role configs validated against the ch.05 table; real KernelToolGateway + kernel leases, two passes (K: lease == role allowlist, kernel decides; B: over-broad lease issued by an admin, role allowlist decides): ${allowedRows.length}/${allowedRows.length} allowed calls permitted; ${deniedRows.length}/${deniedRows.length} out-of-role calls denied TOOL_NOT_GRANTED; ${rdenied.length} runtime denial audit rows and ${kdenied.length} kernel tool.invoke.denied audit rows (pass K, decided by kernel leases); kernel executed invocations per capability == allowed calls ${JSON.stringify(allowedByCap)}; fixture plugin executions for denied tools = 0`,
    fixtureHash: hashOf(calls),
    evidence: {
      roleCount: roles.size,
      matrix,
      runtimeDenialAuditRows: rdenied.length,
      kernelDenialAuditRows: kdenied.length,
      layerCounts,
      kernelOkByCapability: okByCap,
    },
  });
}, 600_000);
