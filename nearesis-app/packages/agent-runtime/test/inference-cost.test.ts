import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { InferenceProvider } from "@nearesis/contracts";
import { LedgerInference, actualCostUsd, usdForTokens } from "../src/index.ts";
import { makeRt, type Rt } from "./helpers/rt.ts";

/**
 * The run budget used to charge the dev token price (USD 2 per 1M tokens) for every model call, so a run on a cheap real model
 * reported ~10x the provider's own settled spend. A provider that reports its priced actual is charged that actual.
 */
let rt: Rt;
beforeAll(async () => {
  rt = await makeRt();
}, 120_000);
afterAll(async () => {
  await rt?.stop();
});

const provider = (evidence: unknown, id = "mock"): InferenceProvider =>
  ({
    id,
    health: async () => ({ ok: true, detail: "x" }),
    listModels: async () => [],
    verifyResponse: async () => ({ verified: false, status: "unsupported", checks: [] }),
    streamText: (async function* () {})() as never,
    generateStructured: async (a: { schema: z.ZodType }) => ({
      output: a.schema.parse({ ok: true }),
      provider: id,
      model: "m",
      requestId: null,
      usage: { inputTokens: 3000, outputTokens: 2000 },
      evidence,
      rawResponseSha256: "",
    }),
  }) as unknown as InferenceProvider;

const run = (p: InferenceProvider, key: string) =>
  new LedgerInference(p, rt.pool, rt.sup, {
    tenantId: rt.tenantId,
    workspaceId: rt.workspaceId,
    runId: rt.runId,
    budgetId: rt.budgetId,
    taskId: rt.rootTaskId,
    model: "m",
  }).generate({ key, system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
const charged = async (key: string) =>
  Number(
    (
      await rt.db.admin.query("SELECT usd::text AS u FROM budget_ledger WHERE entry_key=$1", [
        `charge:${key}`,
      ])
    ).rows[0].u,
  );

describe("run budget charges the provider's actual cost", () => {
  it("reads only a finite non-negative priced actual from the evidence", () => {
    expect(actualCostUsd({ estimatedCostUsd: 0.0003 })).toBe(0.0003);
    expect(actualCostUsd(null)).toBeNull();
    expect(actualCostUsd({ estimatedCostUsd: -1 })).toBeNull();
    expect(actualCostUsd({ estimatedCostUsd: Number.NaN })).toBeNull();
    expect(actualCostUsd({ estimatedCostUsd: "0.1" })).toBeNull();
  });

  it("charges the reported actual (not 5000 tokens x USD 0.002/1k) when the provider prices the call", async () => {
    await run(provider({ estimatedCostUsd: 0.0007 }), "c-actual");
    expect(await charged("c-actual")).toBeCloseTo(0.0007, 10);
    expect(usdForTokens(5000)).toBe(0.01); // what the budget used to charge: 14x the provider's actual
  });

  it("falls back to the dev token price when the provider reports no cost", async () => {
    await run(provider(null), "c-dev");
    expect(await charged("c-dev")).toBeCloseTo(usdForTokens(5000), 10);
  });
});
