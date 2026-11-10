/**
 * Composer path behind the InferenceProvider interface with a deterministic SCRIPTED provider (not a model), using
 * the real kernel ToolGateway (semantic.discover@1, canvas.preview@1 -> gateway -> Cube) and persisting the patch
 * with the real canvas.apply_patch command. This is a development check of the C01 path; C01 itself is recorded only
 * through Engine A's agent runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { InferenceProvider, StructuredResult } from "@nearesis/contracts";
import { CUBE_URL_DEFAULT, cubeReady } from "@nearesis/analytics";
import { validatePanelSpec } from "@nearesis/canvas-schema";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  execReq,
  giveLease,
  grant,
  loginSession,
  pluginUp,
  runCmd,
  seedOrg,
  TEST_KEY,
  TEST_PUBLISHER,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";
import { buildManifest, composeCanvas, type ComposerPlan, PLUGIN_ROOT } from "../src/index.ts";

const C01_PROMPT = "investigate NEAR Intents activity after the private-settlement change";
const W = { from: "2026-10-13T00:00:00Z", to: "2026-11-10T00:00:00Z" };
const PLAN: ComposerPlan = {
  rationale:
    "Compare completed, private-settlement and volume series around 2026-10-27, plus completion rate.",
  panels: [
    {
      title: "Completed 1Click swaps per day",
      mark: "line",
      measures: ["intents.oneclick_completed_swap_count"],
      grain: "day",
      ...W,
    },
    {
      title: "Private-settlement swaps per day",
      mark: "bar",
      measures: ["intents.oneclick_private_settlement_swap_count"],
      grain: "day",
      ...W,
    },
    {
      title: "1Click volume (USD) per day",
      mark: "line",
      measures: ["intents.oneclick_volume_usd"],
      grain: "day",
      ...W,
    },
    {
      title: "1Click completion rate",
      mark: "line",
      measures: ["intents.oneclick_completion_rate"],
      grain: "day",
      ...W,
    },
  ],
};

/** Deterministic scripted provider: returns the fixed plan for the C01 prompt, an empty plan otherwise. */
class ScriptedProvider implements InferenceProvider {
  readonly id = "scripted";
  calls = 0;
  async health() {
    return { ok: true, detail: "scripted (unattested_dev)" };
  }
  async listModels() {
    return [{ id: "scripted-1", attestation: "unsupported" as const, outputModes: ["json_schema"] }];
  }
  async generateStructured<T>(a: { prompt: string; schema: z.ZodType<T> }): Promise<StructuredResult<T>> {
    this.calls++;
    const out = a.prompt.includes(C01_PROMPT) ? PLAN : { panels: [], rationale: "catalog cannot answer" };
    return {
      output: a.schema.parse(out),
      provider: this.id,
      model: "scripted-1",
      requestId: `scripted-${this.calls}`,
      usage: { inputTokens: 0, outputTokens: 0 },
      evidence: null,
      rawResponseSha256: "0".repeat(64),
    };
  }
  // eslint-disable-next-line require-yield
  async *streamText(): AsyncIterable<string> {
    return;
  }
  async verifyResponse() {
    return { verified: false, status: "unattested_dev" as const, checks: [] };
  }
}

let db: TestDb;
let k: Kernel;
let s: Session;
let ws: { workspaceId: string; version: number };
const cube = await cubeReady(CUBE_URL_DEFAULT);

beforeAll(async () => {
  db = await createTestDb();
  const org = await seedOrg(db.admin, "nc", { alice: "owner" });
  k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  await k.boot();
  s = await loginSession(k, org.users.alice!.subject);
  ws = await createWs(k, s);
  await k.plugins.install(
    s.principal.actorId,
    buildManifest({ publisher: TEST_PUBLISHER, privateKey: TEST_KEY.privateKey }),
  );
  await k.plugins.enable(s.principal.actorId, "near-thesis");
  ws.version = await pluginUp(k, s, ws.workspaceId, ws.version, "near-thesis");
  for (const [cap, res, action] of [
    ["semantic.discover@1", "semantic", "discover"],
    ["semantic.query@1", "semantic", "query"],
    ["canvas.preview@1", "canvas", "preview"],
  ] as const)
    await giveLease(k, s, ws.workspaceId, cap, [grant({ resource: res, action })]);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe("composer path (scripted provider, real kernel tools)", () => {
  it.skipIf(!cube)(
    "turns the C01 request into four valid fixture-backed panels with query provenance",
    async () => {
      const invoke = async (capability: string, input: unknown) => {
        const r = await k.gateway.invoke(
          s.principal,
          execReq(s, ws.workspaceId, capability, input, { deadlineMs: 60_000 }),
        );
        if (r.state !== "ok") throw new Error(`${capability}: ${r.state} ${r.reasonCode ?? ""}`);
        return r.payload;
      };
      const provider = new ScriptedProvider();
      const res = await composeCanvas({
        prompt: C01_PROMPT,
        provider,
        model: "scripted-1",
        invoke,
        expectedRevision: 0,
        idempotencyKey: "c01-dev-run",
      });
      expect(res.status, JSON.stringify(res.issues)).toBe("ok");
      const ops = res.patch!.operations;
      expect(ops).toHaveLength(4);
      for (const op of ops) {
        expect(op.op).toBe("addPanel");
        const panel = (op as { panel: unknown }).panel;
        expect(validatePanelSpec(panel).ok).toBe(true);
        expect((panel as { queryRef: { hash: string } }).queryRef.hash).toMatch(/^[0-9a-f]{64}$/);
        expect((panel as { provenanceRequired: boolean }).provenanceRequired).toBe(true);
      }
      await runCmd(k, s, ws.workspaceId, "canvas.apply_patch", res.patch as never, ws.version);
      const doc = await k.canvas.get(s, ws.workspaceId);
      expect(doc.panels).toHaveLength(4);
      expect(doc.documentRevision).toBe(1);

      // Abstention: an unanswerable request yields cannot_compute and no patch.
      const none = await composeCanvas({
        prompt: "price of a token not in the catalog",
        provider,
        model: "scripted-1",
        invoke,
        expectedRevision: 1,
        idempotencyKey: "c01-dev-none",
      });
      expect(none.status).toBe("cannot_compute");
      expect(none.patch).toBeNull();
    },
    120_000,
  );
});
