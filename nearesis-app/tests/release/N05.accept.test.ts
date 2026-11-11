/**
 * N05: Base adapter chain ID, only if enabled. Enabled means NEARESIS_BASE_RPC_URL is configured and `--live` is passed;
 * then exactly one eth_chainId and at most one finalized header are read through the allowlisted adapter. Otherwise the test
 * is NOT_RUN (not enabled) and is intentionally left unbound from TEST_INDEX.json, so the runner reports NOT_RUN rather than
 * recording a verdict.
 */
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { BASE_CHAIN_ID, BaseReadonly } from "../../scripts/release/base.ts";

const url = process.env.NEARESIS_BASE_RPC_URL;
const live = !!process.env.NEARESIS_ACCEPT_LIVE;

it.skipIf(!(url && live))(
  "N05: the configured Base RPC reports chain id 8453 through the read-only adapter",
  async () => {
    const seen: string[] = [];
    const transport = async (method: string, params: unknown[]) => {
      seen.push(method);
      const r = await fetch(url!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      return ((await r.json()) as { result: unknown }).result;
    };
    const res = await new BaseReadonly(transport).smoke();
    expect(res.chainId).toBe(BASE_CHAIN_ID);
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    observe({
      testId: "N05",
      observed: `Base RPC reported ${res.chainId} (8453) through the read-only adapter; methods called: ${seen.join(", ")}`,
      evidence: { chainId: res.chainId, methods: seen },
    });
  },
);

it.skipIf(!!(url && live))(
  "N05: NOT_RUN, Base adapter not enabled; the adapter still refuses non-8453 and writes (fixture)",
  async () => {
    const wrong = await new BaseReadonly(async () => "0x1").smoke();
    expect(wrong.ok).toBe(false);
    await expect(new BaseReadonly(async () => "0x2105").call("eth_sendRawTransaction")).rejects.toThrow(
      /denied/,
    );
    observe({
      testId: "N05",
      blocked: "NOT_RUN: Base adapter not enabled (NEARESIS_BASE_RPC_URL not configured or --live not given)",
      observed:
        "NOT_RUN: adapter not enabled; no live read made. Fixture check: chain id other than 0x2105 fails and write methods are denied",
    });
  },
);
