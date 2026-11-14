/** withRunSource registers the run's stored source for the plugin before each gateway call (dev Postgres, runtime schema). */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionRequest, Principal, ToolGateway } from "@nearesis/contracts";
import { sourceOf } from "@nearesis/near-thesis";
import { DEFAULT_ADMIN_URL, DEFAULT_APP_URL, makePool, migrate } from "../src/index.ts";
import { withRunSource } from "../src/kernel-deps.ts";

const pool = makePool(process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL, 2);
// the app role is subject to row level security, like the worker
const appPool = makePool(process.env.DATABASE_APP_URL ?? DEFAULT_APP_URL, 2);
await migrate(pool);
const made: string[] = [];
afterAll(async () => {
  for (const id of made) await pool.query("DELETE FROM runs WHERE id = $1", [id]);
  await pool.end();
  await appPool.end();
});

const insert = async (tenantId: string, source: "fixture" | "live") => {
  const id = randomUUID();
  made.push(id);
  await pool.query(
    `INSERT INTO runs (id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, source)
     VALUES ($1,$2,$3,$4,$5,'pinned:ws-v1',$6,$7,'REQUESTED',$8)`,
    [id, tenantId, randomUUID(), randomUUID(), randomUUID(), randomUUID(), `wf-${id}`, source],
  );
  return id;
};
const seen: Array<string | undefined> = [];
const inner: ToolGateway = {
  invoke: async (p) => {
    seen.push(p.parentRunId);
    return { state: "ok" } as never;
  },
};
const principal = (orgId: string, parentRunId?: string): Principal =>
  ({ kind: "agent", actorId: randomUUID(), orgId, ...(parentRunId ? { parentRunId } : {}) }) as Principal;
const ctxFor = (p: Principal) => ({ principal: p }) as never;

describe("withRunSource", () => {
  const gw = withRunSource(inner, appPool);
  it("registers the stored source of the principal's run, then delegates", async () => {
    const org = randomUUID();
    const live = await insert(org, "live");
    const fx = await insert(org, "fixture");
    for (const id of [live, fx]) await gw.invoke(principal(org, id), {} as ExecutionRequest);
    expect(seen).toEqual([live, fx]);
    expect(sourceOf(ctxFor(principal(org, live)))).toBe("live");
    expect(sourceOf(ctxFor(principal(org, fx)))).toBe("fixture");
  });
  it("a run that is not in this tenant stays fixture (no cross-tenant source)", async () => {
    const id = await insert(randomUUID(), "live");
    await gw.invoke(principal(randomUUID(), id), {} as ExecutionRequest);
    expect(sourceOf(ctxFor(principal(randomUUID(), id)))).toBe("fixture");
  });
});
