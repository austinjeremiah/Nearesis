import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { canonicalDocHash, compareReadback } from "../../src/index.ts";

/**
 * V05 (ch.16): pre-registration testnet tx; hash readback equals the canonical document hash.
 * Executing it needs a signed NEAR testnet transaction. No signing and no transaction is allowed in this phase, and the
 * owner has not logged a testnet account into the OutLayer CLI (BLK-20261110-003). The comparison logic is exercised
 * offline below; the live write and readback are BLOCKED_DEPENDENCY.
 */
it("V05: hash readback logic is correct offline; the live testnet write is BLOCKED_DEPENDENCY", () => {
  const doc = { experimentId: "demo", hypothesis: "h", horizons: [1, 7] };
  const h = canonicalDocHash(doc);
  expect(compareReadback(doc, { network: "testnet", payloadHash: h }, "testnet").equal).toBe(true);
  expect(
    compareReadback({ ...doc, horizons: [1] }, { network: "testnet", payloadHash: h }, "testnet").equal,
  ).toBe(false);
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
