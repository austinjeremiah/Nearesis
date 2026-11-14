/**
 * near-thesis through the real kernel: signed install (production trust), workspace enablement, lease-scoped
 * invocation of semantic.discover@1, semantic.query@1 and canvas.preview@1 via the ToolGateway, plus a negative
 * check that client-supplied security context is rejected by the input schema. Needs Postgres, Redis, Cube.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cubeReady, CUBE_URL_DEFAULT } from "@nearesis/analytics";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  execReq,
  giveLease,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  TEST_KEY,
  TEST_PUBLISHER,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";
import { buildManifest, PLUGIN_ROOT } from "../src/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
let ws: string;
const cube = await cubeReady(CUBE_URL_DEFAULT);

beforeAll(async () => {
  db = await createTestDb();
  const org = await seedOrg(db.admin, "nt", { alice: "owner" });
  k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  await k.boot();
  s = await loginSession(k, org.users.alice!.subject);
  const w = await createWs(k, s);
  ws = w.workspaceId;
  await k.plugins.install(
    s.principal.actorId,
    buildManifest({ publisher: TEST_PUBLISHER, privateKey: TEST_KEY.privateKey }),
  );
  await k.plugins.enable(s.principal.actorId, "near-thesis");
  await pluginUp(k, s, ws, w.version, "near-thesis");
  for (const [cap, action] of [
    ["semantic.discover@1", "discover"],
    ["semantic.query@1", "query"],
    ["canvas.preview@1", "preview"],
  ] as const)
    await giveLease(k, s, ws, cap, [
      grant({ resource: cap.startsWith("canvas") ? "canvas" : "semantic", action }),
    ]);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const AST = {
  semanticVersion: "1.0.0",
  measures: ["intents.oneclick_completed_swap_count"],
  dimensions: [],
  time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", grain: "day" },
  filters: [],
  order: [],
  limit: 1000,
};

describe("near-thesis plugin via kernel ToolGateway", () => {
  it.skipIf(!cube)(
    "discovers, queries and previews through leased capabilities",
    async () => {
      const d = await k.gateway.invoke(s.principal, execReq(s, ws, "semantic.discover@1", {}));
      expect(d.state).toBe("ok");
      expect((d.payload as { metrics: unknown[] }).metrics.length).toBeGreaterThanOrEqual(20);

      const q = await k.gateway.invoke(
        s.principal,
        execReq(s, ws, "semantic.query@1", AST, { deadlineMs: 30_000 }),
      );
      expect(q.state, JSON.stringify(q).slice(0, 500)).toBe("ok");
      const env = (q.payload as { envelope: { columns: Array<{ name: string }> } }).envelope;
      expect(env.columns.map((c) => c.name)).toEqual([
        "intents.day",
        "intents.oneclick_completed_swap_count",
      ]);

      const p = await k.gateway.invoke(
        s.principal,
        execReq(
          s,
          ws,
          "canvas.preview@1",
          {
            expectedRevision: 0,
            requests: [
              {
                panelId: crypto.randomUUID(),
                title: "Completed swaps",
                mark: "line",
                query: AST,
                x: "intents.day",
                y: ["intents.oneclick_completed_swap_count"],
                layout: { x: 0, y: 0, w: 6, h: 6 },
              },
            ],
          },
          { deadlineMs: 30_000 },
        ),
      );
      expect(p.state, JSON.stringify(p).slice(0, 800)).toBe("ok");
      const prev = p.payload as {
        ok: boolean;
        patch: {
          operations: Array<{ panel: { kind: string; dataBinding: { units: Record<string, string> } } }>;
        };
      };
      expect(prev.ok).toBe(true);
      expect(prev.patch.operations[0]!.panel.kind).toBe("timeSeries");
      expect(prev.patch.operations[0]!.panel.dataBinding.units["intents.oneclick_completed_swap_count"]).toBe(
        "swaps",
      );
    },
    60_000,
  );

  it("rejects client-supplied security context before execution", async () => {
    const r = await k.gateway.invoke(
      s.principal,
      execReq(s, ws, "semantic.query@1", {
        ...AST,
        workspaceId: "00000000-0000-4000-8000-000000000999",
        securityContext: { tenantId: "x" },
      }),
    );
    expect(r.state).not.toBe("ok");
  });
});
