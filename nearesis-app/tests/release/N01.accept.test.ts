/** N01: testnet commitment readback. Needs a signed testnet transaction: HUMAN-required, so BLOCKED_DEPENDENCY. Nothing is sent. */
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { liveCommitEvidence } from "../../plugins/chain-commit/src/live-evidence.ts";
import { NEAR_READ_METHODS } from "../../scripts/release/chain.ts";

it("N01: testnet commitment readback; final tx status and hash match after finality (LIVE under ADR-20261111-005/-006)", async () => {
  expect((NEAR_READ_METHODS as readonly string[]).some((m) => /broadcast|send/.test(m))).toBe(false);
  const live = await liveCommitEvidence(
    new URL("../../../NEARESIS_Build_Bible/reports/TESTS/TESTNET-LIVE/prereg-commit.json", import.meta.url)
      .pathname,
  );
  if (live) {
    expect(live.finality).toBe("FINAL");
    expect(live.succeeded).toBe(true);
    expect(live.method).toBe("commit_hash");
    expect(live.deposit).toBe("0");
    expect(live.equal).toBe(true);
    observe({
      testId: "N01",
      observed: `LIVE NEAR testnet: tx ${live.txHash} to ${live.contract} method ${live.method} has final_execution_status ${live.finality} and succeeded; the contract view get_commitment at FINAL returns a block timestamp ${live.viewTimestampNs} for hash ${live.payloadHash}, and the transaction args hash equals the committed canonical preregistration hash.`,
      fixtureHash: live.payloadHash,
      evidence: { ...live },
    });
    return;
  }
  observe({
    testId: "N01",
    blocked:
      "HUMAN-required: a testnet commitment needs a signed testnet write from a funded testnet signer; agents may not sign, broadcast or touch wallets. Release tooling for it exists (preflight, idempotent release, receipt verifier) and is exercised on fixtures by N04, N08 to N11",
    observed:
      "not run: no testnet write was attempted; the repository's only RPC client is read-only and has no broadcast method",
  });
}, 120_000);
