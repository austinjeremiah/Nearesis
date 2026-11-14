import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ApprovalStore } from "../../scripts/release/approval.ts";
import type { ApprovalScope } from "../../scripts/release/approval.ts";
import { FixtureChain } from "../../scripts/release/chain.ts";
import type { FixtureOptions, Network } from "../../scripts/release/chain.ts";
import { Ledger } from "../../scripts/release/release.ts";
import type { ReleaseDeps, ReleasePolicy, ReleaseRequest } from "../../scripts/release/release.ts";

export const SIGNER = "release-signer.fixture";
export const CONTRACT = "prereg.fixture";
export const METHOD = "commit_preregistration_hash";
export const PAYLOAD = createHash("sha256").update("fixture preregistration").digest("hex");
export const OWNERS = ["owner-1", "owner-2"];

export const policy = (o: Partial<ReleasePolicy> = {}): ReleasePolicy => ({
  expectedChainId: { sandbox: "sandbox", testnet: "testnet", mainnet: "mainnet" },
  allowlist: { contracts: [CONTRACT], methods: [METHOD] },
  balanceCeiling: 2_000n,
  feeCeiling: 5n,
  signer: SIGNER,
  approvalRequiredOn: [],
  intentWindow: 5,
  ...o,
});
export const request = (network: Network, o: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
  network,
  contract: CONTRACT,
  method: METHOD,
  payloadHash: PAYLOAD,
  maxCost: "10",
  mode: "execute",
  ...o,
});
export const scopeOf = (r: ReleaseRequest, pol: ReleasePolicy = policy()): ApprovalScope => ({
  network: r.network,
  contract: r.contract,
  method: r.method,
  payloadHash: r.payloadHash,
  maxCost: r.maxCost,
  signer: pol.signer,
  feeCeiling: pol.feeCeiling.toString(),
});

export interface Rig {
  dir: string;
  chain: FixtureChain;
  approvals: ApprovalStore;
  now: { t: number };
  deps: (o?: Partial<ReleaseDeps>) => ReleaseDeps;
  audit: Array<{ kind: string; detail: string }>;
  cleanup: () => void;
}
export function rig(
  network: Network,
  chainOpts: Partial<FixtureOptions> = {},
  pol: Partial<ReleasePolicy> = {},
  twoPerson = false,
): Rig {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const chain = new FixtureChain({ network, ...chainOpts });
  const now = { t: 1_000_000 };
  const approvals = new ApprovalStore(OWNERS, { twoPerson, now: () => now.t });
  const audit: Array<{ kind: string; detail: string }> = [];
  return {
    dir,
    chain,
    approvals,
    now,
    audit,
    deps: (o = {}) => ({
      chain,
      approvals,
      ledger: new Ledger(join(dir, "ledger.json")),
      policy: policy(pol),
      tick: () => chain.advance(1),
      audit,
      ...o,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
