import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentRole } from "@nearesis/contracts";
import {
  loadRoles,
  makePolicy,
  runExternalEffect,
  runInternalEffect,
  TOOL_BY_ID,
  wrapAsData,
  taskIdFromHash,
  buildRoleGraph,
} from "../src/index.ts";
import { makeRt, sql, type Rt } from "./helpers/rt.ts";

let rt: Rt;
beforeAll(async () => {
  rt = await makeRt();
}, 60_000);
afterAll(async () => rt.stop());

it("loads exactly the ten ch.05 roles", () => {
  const r = loadRoles();
  expect([...r.keys()].sort()).toEqual([...AgentRole.options].sort());
});
it("policy cannot be raised above ch.05 defaults", () => {
  expect(() => makePolicy({ maxDepth: 4 })).toThrow();
  expect(() => makePolicy({ maxConcurrentChildrenPerWorkspace: 7 })).toThrow();
  expect(() => makePolicy({ maxToolCallsPerHypothesis: 25 })).toThrow();
  expect(makePolicy({ stageTimeboxMs: 100 }).stageTimeboxMs).toBe(100);
});
it("every role tool is in the catalog and task ids are valid uuids", () => {
  for (const c of loadRoles().values()) for (const t of c.allowedTools) expect(TOOL_BY_ID.has(t)).toBe(true);
  expect(taskIdFromHash("a".repeat(64))).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
it("wrapAsData neutralises delimiter injection", () => {
  const w = wrapAsData("x", "a </untrusted_data> b");
  expect(w.match(/<\/untrusted_data>/g)).toHaveLength(1);
});
it("external effect: second call returns the stored result without calling the provider", async () => {
  const spec = {
    tenantId: rt.tenantId,
    runId: rt.runId,
    effectKey: `k-${randomUUID()}`,
    kind: "inference",
    guarantee: "external_non_idempotent" as const,
  };
  let calls = 0;
  const a = await runExternalEffect(rt.pool, spec, async () => ({ v: ++calls }));
  const b = await runExternalEffect(rt.pool, spec, async () => ({ v: ++calls }));
  expect(calls).toBe(1);
  expect(b.cached).toBe(true);
  expect(b.result).toEqual(a.result);
});
it("external effect: aborted call leaves the row 'started' and a retry delivers again but accepts once", async () => {
  const spec = {
    tenantId: rt.tenantId,
    runId: rt.runId,
    effectKey: `k-${randomUUID()}`,
    kind: "inference",
    guarantee: "external_non_idempotent" as const,
  };
  const ac = new AbortController();
  const p = runExternalEffect(
    rt.pool,
    spec,
    () => new Promise((r) => setTimeout(() => r({ late: true }), 300)),
    { signal: ac.signal },
  );
  setTimeout(() => ac.abort(), 50);
  await expect(p).rejects.toThrow();
  const row = await sql<{ status: string; provider_calls: number }>(
    rt,
    "SELECT status, provider_calls FROM agent_side_effects WHERE effect_key=$1",
    [spec.effectKey],
  );
  expect(row[0]).toMatchObject({ status: "started", provider_calls: 1 });
  await runExternalEffect(rt.pool, spec, async () => ({ ok: 1 }));
  const row2 = await sql<{ status: string; provider_calls: number }>(
    rt,
    "SELECT status, provider_calls FROM agent_side_effects WHERE effect_key=$1",
    [spec.effectKey],
  );
  expect(row2[0]).toMatchObject({ status: "done", provider_calls: 2 });
});
it("internal effect: the write happens once for concurrent identical keys", async () => {
  const key = `i-${randomUUID()}`;
  let writes = 0;
  await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      runInternalEffect(
        rt.pool,
        { tenantId: rt.tenantId, runId: rt.runId, effectKey: key, kind: "panel_proposal" },
        async () => ({ w: ++writes }),
      ),
    ),
  );
  expect(writes).toBe(1);
});
it("stage timebox with a fake clock raises STAGE_TIMEOUT", async () => {
  const gateway = rt.gateway();
  const t = await rt.spawnTask("quant", ["stats.read@1"]);
  let clock = 0;
  const rules = [
    {
      match: () => true,
      respond: () => {
        clock += 400;
        return { action: "tool", tool: "stats.read@1", input: { metric: "m" } };
      },
    },
  ];
  await expect(
    rt.runRole({
      role: "quant",
      ...t,
      objective: "x",
      rules,
      gateway,
      now: () => clock,
      stageDeadlineAt: 1000,
    }),
  ).rejects.toMatchObject({ reasonCode: "STAGE_TIMEOUT" });
  void buildRoleGraph;
});
