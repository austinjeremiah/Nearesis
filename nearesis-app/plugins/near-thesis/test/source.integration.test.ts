/**
 * Per-run semantic source: the plugin answers from the layer the run was submitted with (runtime.runs.source), never
 * from anything in the invocation input. Needs the dev Postgres with the runtime schema migrated (pnpm dev:seed).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPg } from "@nearesis/analytics";
import type { InvocationContext } from "@nearesis/plugin-sdk";
import { gateway, sourceOf } from "../src/entry.ts";

const pool = createPg();
const made: string[] = [];
afterAll(async () => {
  for (const id of made) await pool.query("DELETE FROM runtime.runs WHERE id = $1", [id]);
  await pool.end();
});

async function run(source: "fixture" | "live"): Promise<string> {
  const id = randomUUID();
  made.push(id);
  await pool.query(
    `INSERT INTO runtime.runs (id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, source)
     VALUES ($1,$2,$3,$4,$5,'pinned:ws-v1',$6,$7,'REQUESTED',$8)`,
    [id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), `wf-${id}`, source],
  );
  return id;
}
const ctx = (parentRunId?: string) =>
  ({
    principal: {
      kind: "agent",
      actorId: randomUUID(),
      orgId: randomUUID(),
      ...(parentRunId ? { parentRunId } : {}),
    },
    workspaceId: randomUUID(),
  }) as unknown as InvocationContext;

describe("sourceOf", () => {
  it("returns the stored source of the principal's run", async () => {
    expect(await sourceOf(ctx(await run("live")))).toBe("live");
    expect(await sourceOf(ctx(await run("fixture")))).toBe("fixture");
  });
  it("falls back to fixture, never live, without a run or for an unknown run", async () => {
    expect(await sourceOf(ctx())).toBe("fixture");
    expect(await sourceOf(ctx(randomUUID()))).toBe("fixture");
  });
});

describe("gateway(source)", () => {
  it("wires distinct registries: live metrics are live.*, fixture metrics are not", () => {
    const live = gateway("live").registry.metrics.map((m) => m.id);
    const fx = gateway("fixture").registry.metrics.map((m) => m.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((id) => id.startsWith("live."))).toBe(true);
    expect(fx.some((id) => id.startsWith("live."))).toBe(false);
    expect(gateway("live")).toBe(gateway("live"));
  });
});
