import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { MemoryNotFound, MemoryStore, hashOf } from "../../src/index.ts";
import { createTestDatabase, withTenant, type TestDatabase } from "../../../workflow/src/db.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.drop());

it("A17: memory and recall are confined to (tenant, workspace, role, scope) and recalled claims resolve to evidence", async () => {
  const store = new MemoryStore(db.app);
  const T1 = randomUUID(),
    W1 = randomUUID(),
    T2 = randomUUID(),
    W2 = randomUUID();
  const ns = (t: string, w: string, role: string) => ({ tenantId: t, workspaceId: w, role });
  // evidence index: E1 resolvable, E2 tombstoned
  await withTenant(db.app, T1, (c) =>
    c.query(
      "INSERT INTO agent_evidence_refs (tenant_id, workspace_id, evidence_id, tombstoned) VALUES ($1,$2,'E1',false),($1,$2,'E2',true),($1,$2,'E3',false)",
      [T1, W1],
    ),
  );
  const m1 = await store.store(ns(T1, W1, "skeptic"), {
    scope: "workspace",
    tier: "semantic",
    content: "alpha swap volume rose after the fee change",
    evidenceId: "E1",
  });
  const m2 = await store.store(ns(T1, W1, "skeptic"), {
    scope: "workspace",
    tier: "episodic",
    content: "alpha claim derived from retracted dataset",
    evidenceId: "E2",
  });
  const m3 = await store.store(ns(T1, W1, "quant"), {
    scope: "role",
    tier: "semantic",
    content: "alpha quant-only model hyperparameters",
    evidenceId: "E3",
  });
  await expect(
    store.store(ns(T1, W1, "quant"), {
      scope: "role",
      tier: "semantic",
      content: "no evidence",
      evidenceId: "",
    }),
  ).rejects.toThrow();

  // (a) W2 recall returns 0 W1 items; direct fetch identical to a random id
  const w2 = await store.recall(ns(T2, W2, "skeptic"), "alpha");
  expect(w2).toHaveLength(0);
  const errOf = async (id: string) =>
    store.get(ns(T2, W2, "skeptic"), id).then(
      () => null,
      (e) => e as Error,
    );
  const eReal = await errOf(m1);
  const eRand = await errOf(randomUUID());
  expect(eReal).toBeInstanceOf(MemoryNotFound);
  expect(eReal!.message).toBe(eRand!.message);
  expect(eReal!.name).toBe(eRand!.name);
  // timing (informational): not-found latency real vs random
  const time = async (id: string) => {
    const t = process.hrtime.bigint();
    await errOf(id);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const tReal = await time(m1),
    tRand = await time(randomUUID());
  // same tenant, other workspace: also nothing (RLS app.workspace_id + predicate)
  expect(await store.recall(ns(T1, W2, "skeptic"), "alpha")).toHaveLength(0);

  // (b) role-scoped memory not returned to another role unless scope=workspace
  const sk = await store.recall(ns(T1, W1, "skeptic"), "alpha");
  expect(sk.map((x) => x.id).sort()).toEqual([m1, m2].sort());
  expect(sk.find((x) => x.id === m3)).toBeUndefined();
  await expect(store.get(ns(T1, W1, "skeptic"), m3)).rejects.toBeInstanceOf(MemoryNotFound);
  const q = await store.recall(ns(T1, W1, "quant"), "alpha");
  expect(q.map((x) => x.id).sort()).toEqual([m1, m2, m3].sort()); // workspace-scope items visible to quant too

  // (c) tombstoned evidence flagged and not citable
  const tomb = sk.find((x) => x.id === m2)!;
  expect(tomb.evidenceStatus).toBe("evidence_unresolved");
  expect(tomb.citable).toBe(false);
  expect(sk.find((x) => x.id === m1)!.citable).toBe(true);
  // (d) every item carries its evidence reference
  for (const it of [...sk, ...q]) expect(it.evidenceRef).toMatch(/^E\d$/);

  // (e) DB-level: RLS enabled+forced on memory tables; W2-tenant session sees 0 W1 rows
  const rls = await db.admin.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('agent_memory','agent_evidence_refs') AND relnamespace='runtime'::regnamespace ORDER BY 1",
  );
  for (const r of rls.rows) {
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
  }
  const pol = await db.admin.query(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname='runtime' AND tablename IN ('agent_memory','agent_evidence_refs')",
  );
  expect(pol.rowCount).toBe(2);
  const cross = await withTenant(
    db.app,
    T2,
    async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM agent_memory WHERE workspace_id=$1", [W1])).rows[0].n,
  );
  const crossAll = await withTenant(
    db.app,
    T2,
    async (c) => (await c.query("SELECT count(*)::int AS n FROM agent_memory")).rows[0].n,
  );
  const own = await withTenant(
    db.app,
    T1,
    async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM agent_memory WHERE workspace_id=$1", [W1])).rows[0].n,
  );
  expect(cross).toBe(0);
  expect(crossAll).toBe(0);
  expect(own).toBe(3);
  // a write for another tenant is rejected by WITH CHECK
  await expect(
    withTenant(db.app, T2, (c) =>
      c.query(
        "INSERT INTO agent_memory (id,tenant_id,workspace_id,agent_role,scope,tier,content,evidence_id) VALUES ($1,$2,$3,'x','workspace','episodic','x','E1')",
        [randomUUID(), T1, W1],
      ),
    ),
  ).rejects.toThrow();

  observe({
    testId: "A17",
    observed: `W2 recall of 'alpha': 0 items (also 0 for same-tenant other workspace); direct fetch of W1 memory id from W2 -> '${eReal!.name}: ${eReal!.message}' identical to random id (latency ${tReal.toFixed(1)}ms vs ${tRand.toFixed(1)}ms); skeptic recall excludes quant role-scoped memory (returns ${sk.length}), quant sees ${q.length}; tombstoned-evidence memory flagged evidence_unresolved, citable=false; all items carry evidenceRef; RLS enabled+forced with ${pol.rowCount} policies; W2-session count over W1 rows = ${cross} (all rows ${crossAll}); cross-tenant insert rejected`,
    fixtureHash: hashOf(["workspace/E1", "workspace/E2-tombstoned", "role-quant/E3"]),
    evidence: {
      recallW2: w2.length,
      notFound: { real: eReal!.message, random: eRand!.message, latencyMs: { real: tReal, random: tRand } },
      skeptic: sk.map((x) => ({ scope: x.scope, status: x.evidenceStatus, citable: x.citable })),
      rls: rls.rows,
      policies: pol.rows,
      counts: { cross, crossAll, own },
    },
  });
}, 60_000);
