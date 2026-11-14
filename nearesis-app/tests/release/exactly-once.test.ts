/**
 * Exactly-once safeguards of the release command: on-chain readback by payload before any broadcast and before any retry,
 * the idempotency key in every intent, and an approval that is not consumed by a refused or already-satisfied run. The live
 * block runs the dry pre-flight against NEAR testnet (read-only calls only) with `NEARESIS_ACCEPT_LIVE=1`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../../scripts/release/approval.ts";
import { LiveTestnetPreflightChain } from "../../scripts/release/near-live-chain.ts";
import { Ledger, runRelease } from "../../scripts/release/release.ts";
import { OWNERS, PAYLOAD, policy, request, rig, scopeOf } from "./_rig.ts";

describe("readback before broadcast and before retry", () => {
  it("a payload already on chain is never rewritten, even with an empty ledger and a valid approval; the approval stays unused", async () => {
    const r = rig("sandbox", {}, { approvalRequiredOn: ["sandbox"] });
    const req = request("sandbox");
    const appr = r.approvals.issue(scopeOf(req, r.deps().policy), OWNERS[0]!, [], 60_000);
    const first = await runRelease(r.deps(), { ...req, approvalId: appr.id });
    expect(first.status).toBe("FINAL");
    expect(r.chain.txs).toHaveLength(1);
    // a second operator with a fresh ledger and a fresh approval for the same payload
    const again = r.approvals.issue(scopeOf(req, r.deps().policy), OWNERS[0]!, [], 60_000);
    const second = await runRelease(r.deps({ ledger: new Ledger(join(r.dir, "other.json")) }), {
      ...req,
      approvalId: again.id,
    });
    expect(second.status).toBe("ALREADY_ON_CHAIN");
    expect(second.broadcasts).toBe(0);
    expect(r.chain.txs).toHaveLength(1);
    expect(r.chain.calls.broadcast).toBe(1);
    expect(r.approvals.get(again.id)!.usedAt).toBeNull();
    r.cleanup();
  });

  it("an absent transaction whose payload then shows up on chain under another transaction is held for review, not rebroadcast", async () => {
    const r = rig("sandbox", {}, { intentWindow: 1 });
    r.chain.nextFault = "timeout-absent";
    let reads = 0;
    // hasPayload is false before the first broadcast, true afterwards (the write landed through a path the ledger never saw)
    r.chain.hasPayload = async () => ++reads > 1;
    r.chain.height = 100;
    const first = await runRelease(r.deps(), request("sandbox"));
    expect(first.status).toBe("HELD_UNCERTAIN"); // window still open
    r.chain.advance(10);
    const second = await runRelease(r.deps(), request("sandbox"));
    expect(second.status).toBe("HUMAN_REVIEW");
    expect(second.reasonCode).toBe("PAYLOAD_ON_CHAIN_UNMATCHED");
    expect(r.chain.calls.broadcast).toBe(1);
    r.cleanup();
  });

  it("every intent carries the action hash as its idempotency key", async () => {
    const r = rig("sandbox");
    await runRelease(r.deps(), request("sandbox"));
    expect(r.chain.broadcastLog).toHaveLength(1);
    expect(r.chain.broadcastLog[0]!.nonceKey).toMatch(/^[0-9a-f]{64}$/);
    r.cleanup();
  });
});

const live = process.env.NEARESIS_ACCEPT_LIVE === "1";
const tnPath = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "NEARESIS_Build_Bible",
  "reports",
  "TESTS",
  "TESTNET-LIVE",
  "prereg-commit.json",
);
describe.skipIf(!live)("dry pre-flight against NEAR testnet (read-only)", () => {
  const pol = policy({
    allowlist: { contracts: ["commit.majorlynx5104.testnet"], methods: ["commit_hash"] },
    signer: "majorlynx5104.testnet",
    balanceCeiling: 10n * 10n ** 24n,
    feeCeiling: 10n ** 22n,
    approvalRequiredOn: ["testnet"],
  });
  const base = {
    contract: "commit.majorlynx5104.testnet",
    method: "commit_hash",
    maxCost: (10n ** 22n).toString(),
  };

  it("a fresh payload passes the dry run with 0 broadcasts; the already-committed preregistration is reported as on chain", async () => {
    const chain = new LiveTestnetPreflightChain();
    const approvals = new ApprovalStore(OWNERS, { now: () => Date.now() });
    const deps = {
      chain,
      approvals,
      ledger: new Ledger(join(import.meta.dirname, "..", "..", ".data", "release", "dryrun-ledger.json")),
      policy: pol,
    };
    const fresh = request("testnet", { ...base, payloadHash: PAYLOAD, mode: "dry-run" });
    const ap = approvals.issue(scopeOf(fresh, pol), OWNERS[0]!, [], 60_000);
    const res = await runRelease(deps, { ...fresh, approvalId: ap.id });
    expect(res.status).toBe("DRY_RUN_OK");
    expect(res.broadcasts).toBe(0);
    expect(res.preflight!.chainId).toBe("testnet");
    expect(approvals.get(ap.id)!.usedAt).toBeNull();
    // the dry run cannot write: the live adapter has no broadcast
    await expect(chain.broadcast({} as never)).rejects.toThrow(/not available/);

    if (existsSync(tnPath)) {
      const tn = JSON.parse(readFileSync(tnPath, "utf8")) as { payloadHash: string };
      const done = request("testnet", { ...base, payloadHash: tn.payloadHash, mode: "dry-run" });
      const ap2 = approvals.issue(scopeOf(done, pol), OWNERS[0]!, [], 60_000);
      const res2 = await runRelease(deps, { ...done, approvalId: ap2.id });
      expect(res2.status).toBe("ALREADY_ON_CHAIN");
    }
  }, 120_000);
});
