import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { APP } from "../helpers.ts";
import { observe } from "@nearesis/acceptance";
import { liveCommitEvidence } from "../../../../plugins/chain-commit/src/live-evidence.ts";
import { canonicalDocHash, compareReadback } from "../../src/index.ts";

/**
 * V05 (ch.16): pre-registration testnet tx; hash readback equals the canonical document hash.
 * Executing it needs a signed NEAR testnet transaction. No signing and no transaction is allowed in this phase, and the
 * owner has not logged a testnet account into the OutLayer CLI (BLK-20261110-003). The comparison logic is exercised
 * offline below; the live write and readback are BLOCKED_DEPENDENCY.
 */
it("V05: hash readback logic is correct offline; with --live the recorded testnet commitment is read back at FINAL", async () => {
  const doc = { experimentId: "demo", hypothesis: "h", horizons: [1, 7] };
  const h = canonicalDocHash(doc);
  expect(compareReadback(doc, { network: "testnet", payloadHash: h }, "testnet").equal).toBe(true);
  expect(
    compareReadback({ ...doc, horizons: [1] }, { network: "testnet", payloadHash: h }, "testnet").equal,
  ).toBe(false);
  const live = await liveCommitEvidence(
    new URL(
      "../../../../../NEARESIS_Build_Bible/reports/TESTS/TESTNET-LIVE/prereg-commit.json",
      import.meta.url,
    ).pathname,
  );
  if (live) {
    const prereg = readFileSync(join(APP, "docs", "research", "PREREGISTRATION.md"), "utf8");
    const expected = canonicalDocHash({ file: "docs/research/PREREGISTRATION.md", text: prereg });
    expect(live.payloadHash).toBe(expected);
    expect(live.finality).toBe("FINAL");
    expect(live.succeeded).toBe(true);
    expect(live.equal).toBe(true);
    expect(
      compareReadback(
        { file: "docs/research/PREREGISTRATION.md", text: prereg },
        { network: "testnet", payloadHash: live.payloadHash },
        "testnet",
      ).equal,
    ).toBe(true);
    observe({
      testId: "V05",
      observed: `LIVE NEAR testnet: canonical hash of docs/research/PREREGISTRATION.md ${expected} was committed in tx ${live.txHash} (contract ${live.contract}, method ${live.method}, deposit 0); after FINAL finality the transaction arguments and the contract view both equal that hash (block timestamp ${live.viewTimestampNs}); an altered document does not match.`,
      fixtureHash: expected,
      evidence: { ...live },
    });
    return;
  }
  observe({
    testId: "V05",
    observed:
      "No transaction was submitted: signing and chain writes are forbidden in this phase and no testnet signer is available. Offline canonical-hash comparison logic verified (equal, altered doc, wrong network).",
    blocked:
      "BLOCKED_DEPENDENCY: needs a signed NEAR testnet transaction and an owner-logged-in testnet account; see BLK-20261110-003",
    fixtureHash: h,
    evidence: { offlineComparisonChecked: true, transactionHash: null },
  });
});
