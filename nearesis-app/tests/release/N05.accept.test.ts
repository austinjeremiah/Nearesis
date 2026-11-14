/**
 * N05: Base adapter chain ID, only if enabled. Enabled means NEARESIS_BASE_RPC_URL is configured and `--live` is passed;
 * then exactly one eth_chainId and at most one finalized header are read through the allowlisted adapter. Otherwise the test
 * is NOT_RUN (not enabled) and records BLOCKED_DEPENDENCY, never PASS. With `--live` and no env value, the keyless public
 * endpoint https://mainnet.base.org is used (no API key, no paid provider). The read goes through the real HTTP transport,
 * which only serialises the two allowlisted read methods.
 */
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  BASE_CHAIN_ID,
  BaseReadonly,
  DEFAULT_BASE_PUBLIC_RPC,
  createHttpTransport,
} from "../../scripts/release/base.ts";

const live = !!process.env.NEARESIS_ACCEPT_LIVE;
const url = process.env.NEARESIS_BASE_RPC_URL || (live ? DEFAULT_BASE_PUBLIC_RPC : undefined);

it.skipIf(!(url && live))(
  "N05: the configured Base RPC reports chain id 8453 through the read-only adapter",
  async () => {
    const seen: string[] = [];
    const http = createHttpTransport(url!);
    const transport = async (method: string, params: unknown[]) => {
      seen.push(method);
      return http(method, params);
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
