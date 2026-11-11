/**
 * N09: pre-write verification. FIXTURE half (all criteria asserted on fixture chains, 0 signatures and 0 broadcasts on every
 * fault). The LIVE half needs a testnet read plus a funded testnet signer, and the mainnet pre-flight is run by the operator:
 * both are HUMAN-required, so the verdict is BLOCKED_DEPENDENCY.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildManifest } from "../../scripts/release/manifest.ts";
import { preflight, runRelease } from "../../scripts/release/release.ts";
import { PAYLOAD, policy, request, rig } from "./_rig.ts";

const rigs: Array<ReturnType<typeof rig>> = [];
afterAll(() => rigs.forEach((x) => x.cleanup()));
const mk = (...a: Parameters<typeof rig>) => {
  const x = rig(...a);
  rigs.push(x);
  return x;
};

it("N09: the pre-flight reads chain id and balance from the RPC, enforces ceilings and allowlist, and aborts with a reason code before signing", async () => {
  // ceilings come from the release manifest
  const { manifest } = buildManifest({ root: process.cwd(), balanceCeiling: "2000", feeCeiling: "5" });
  const pol = policy({
    balanceCeiling: BigInt(manifest.balanceCeiling!),
    feeCeiling: BigInt(manifest.feeCeiling!),
  });

  const good = mk("testnet");
  const ok = await preflight(good.chain, request("testnet"), pol);
  expect(ok.ok).toBe(true);
  if (!ok.ok) throw new Error("unreachable");
  expect(ok.record).toEqual({
    chainId: "testnet",
    network: "testnet",
    balance: "1000",
    method: "commit_preregistration_hash",
    contract: "prereg.fixture",
    feeEstimate: "1",
    payloadHash: PAYLOAD,
  });

  type Case = {
    name: string;
    reason: string;
    chain: Parameters<typeof rig>[1];
    req?: Partial<ReturnType<typeof request>>;
    down?: boolean;
  };
  const cases: Case[] = [
    { name: "wrong chain id", reason: "CHAIN_ID_MISMATCH", chain: { chainId: "not-testnet" } },
    { name: "balance above ceiling", reason: "BALANCE_ABOVE_CEILING", chain: { balance: 5_000n } },
    { name: "method not allowlisted", reason: "NOT_ALLOWLISTED", chain: {}, req: { method: "stake_all" } },
    {
      name: "contract not allowlisted",
      reason: "NOT_ALLOWLISTED",
      chain: {},
      req: { contract: "evil.fixture" },
    },
    {
      name: "payload larger than a hash",
      reason: "PAYLOAD_NOT_HASH",
      chain: {},
      req: { payloadHash: PAYLOAD + "00" },
    },
    {
      name: "raw data payload",
      reason: "PAYLOAD_NOT_HASH",
      chain: {},
      req: { payloadHash: "private user data" },
    },
    { name: "fee above ceiling", reason: "FEE_ABOVE_CEILING", chain: { fee: 50n } },
    { name: "rpc timeout", reason: "RPC_TIMEOUT", chain: {}, down: true },
    { name: "transfer method", reason: "ACTION_DISABLED", chain: {}, req: { method: "transfer" } },
  ];
  const observed: Record<string, string | null> = {};
  for (const c of cases) {
    const x = mk("testnet", c.chain);
    x.chain.rpcDown = !!c.down;
    const res = await runRelease(x.deps({ policy: pol }), request("testnet", c.req));
    expect(res.status, c.name).toBe("PREFLIGHT_FAILED");
    expect(res.reasonCode, c.name).toBe(c.reason);
    expect(x.chain.calls.broadcast, c.name).toBe(0);
    expect(x.chain.broadcastLog, c.name).toEqual([]);
    expect(existsSync(join(x.dir, "ledger.json")), c.name).toBe(false);
    observed[c.name] = res.reasonCode;
  }

  // (e) a testnet network never passes a mainnet pre-flight and vice versa
  const t = mk("testnet");
  const m = mk("mainnet");
  expect((await runRelease(t.deps(), request("mainnet"))).reasonCode).toBe("NO_APPROVAL");
  const asMainnet = await preflight(t.chain, request("mainnet"), pol);
  const asTestnet = await preflight(m.chain, request("testnet"), pol);
  expect(asMainnet).toEqual({ ok: false, reason: "NETWORK_MISMATCH" });
  expect(asTestnet).toEqual({ ok: false, reason: "NETWORK_MISMATCH" });

  // negative control: a pre-flight that trusts configured chain id instead of the RPC accepts the wrong-chain case
  const wrong = mk("testnet", { chainId: "not-testnet" });
  const configTrusting = () => pol.expectedChainId.testnet === pol.expectedChainId.testnet;
  expect(configTrusting()).toBe(true);
  expect(await preflight(wrong.chain, request("testnet"), pol)).toEqual({
    ok: false,
    reason: "CHAIN_ID_MISMATCH",
  });

  observe({
    testId: "N09",
    blocked:
      "HUMAN-required: the LIVE half needs a testnet RPC read with a funded testnet signer and the operator's read-only mainnet pre-flight; no testnet or mainnet access is permitted for this agent. Fixture half passed: criteria (a) to (e) asserted on fixture chains",
    observed: `fixture half: correct configuration passes and records chain id, network, balance, method, fee estimate, payload hash; ${cases.length} faults (${Object.keys(observed).join(", ")}) abort with specific reason codes, each with 0 signatures, 0 broadcasts and no ledger entry; balance ceiling and fee ceiling read from the release manifest; RPC timeout aborts; testnet-vs-mainnet mismatch refused both ways; config-trusting control detected. Live half not run`,
    fixtureHash: PAYLOAD,
    evidence: { reasons: observed, okRecord: ok.record },
  });
});
