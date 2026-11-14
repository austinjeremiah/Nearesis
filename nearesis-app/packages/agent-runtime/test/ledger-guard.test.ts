import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { InferenceProvider } from "@nearesis/contracts";
import { KernelError, withDataLabel } from "@nearesis/kernel";
import { LedgerInference } from "../src/index.ts";
import { makeRt, type Rt } from "./helpers/rt.ts";

/** FND-073: LedgerInference (all workflow agents and research roles) guards whatever provider it is given. */
let rt: Rt;
let srv: Server;
let url: string;
const bodies: string[] = [];
beforeAll(async () => {
  rt = await makeRt();
  srv = createServer((rq, rs) => {
    const c: Buffer[] = [];
    rq.on("data", (x: Buffer) => c.push(x));
    rq.on("end", () => {
      bodies.push(Buffer.concat(c).toString("utf8"));
      rs.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
}, 120_000);
afterEach(() => {
  delete process.env.NEARESIS_APPROVED_MODEL_BINDINGS;
  bodies.length = 0;
});
afterAll(async () => {
  srv?.close();
  await rt?.stop();
});

const httpProvider = (id: string): InferenceProvider =>
  ({
    id,
    health: async () => ({ ok: true, detail: "x" }),
    listModels: async () => [],
    verifyResponse: async () => ({ verified: false, status: "unsupported", checks: [] }),
    streamText: (async function* () {})() as never,
    generateStructured: async (a: { prompt: string; schema: z.ZodType }) => {
      await fetch(url, { method: "POST", body: a.prompt });
      return {
        output: a.schema.parse({ ok: true }),
        provider: id,
        model: "m",
        requestId: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        evidence: null,
        rawResponseSha256: "",
      };
    },
  }) as unknown as InferenceProvider;

const mk = (p: InferenceProvider, taskId = rt.rootTaskId) =>
  new LedgerInference(p, rt.pool, rt.sup, {
    tenantId: rt.tenantId,
    workspaceId: rt.workspaceId,
    runId: rt.runId,
    budgetId: rt.budgetId,
    taskId,
    model: "m",
  });
const gen = (inf: LedgerInference, key: string, prompt: string) =>
  inf.generate({ key, system: "s", prompt, schema: z.object({ ok: z.boolean() }) });

describe("LedgerInference applies the classification guard to an unguarded provider", () => {
  it("refuses a private payload for an unapproved binding before any request is sent, with a typed error", async () => {
    const err = await gen(mk(httpProvider("rogue-binding")), "g-1", "PRIVATE-NOTE-aaa111").catch((e) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect(err).toMatchObject({ code: "FORBIDDEN", reasonCode: "CLASSIFICATION_DENIED" });
    expect(bodies).toEqual([]);
  });

  it("an operator can narrow private egress to NEAR AI: openrouter is then refused unless the prompt is declared public", async () => {
    process.env.NEARESIS_APPROVED_MODEL_BINDINGS = "near-ai";
    const err = await gen(mk(httpProvider("openrouter")), "g-2", "PRIVATE-NOTE-bbb222").catch((e) => e);
    expect(err).toMatchObject({ reasonCode: "CLASSIFICATION_DENIED" });
    expect(bodies).toEqual([]);
    await withDataLabel("public", () => gen(mk(httpProvider("openrouter")), "g-3", "public prompt"));
    expect(bodies).toEqual(["public prompt"]);
  });

  it("an approved binding (default: near-ai, openrouter) still works for undeclared prompts", async () => {
    await gen(mk(httpProvider("near-ai")), "g-4", "ok");
    expect(bodies).toEqual(["ok"]);
  });
});
