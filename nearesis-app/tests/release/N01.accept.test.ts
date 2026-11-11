/** N01: testnet commitment readback. Needs a signed testnet transaction: HUMAN-required, so BLOCKED_DEPENDENCY. Nothing is sent. */
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { NEAR_READ_METHODS } from "../../scripts/release/chain.ts";

it("N01: blocked, a testnet write needs a real signer and funded testnet account that agents may not use", () => {
  expect((NEAR_READ_METHODS as readonly string[]).some((m) => /broadcast|send/.test(m))).toBe(false);
  observe({
    testId: "N01",
    blocked:
      "HUMAN-required: a testnet commitment needs a signed testnet write from a funded testnet signer; agents may not sign, broadcast or touch wallets. Release tooling for it exists (preflight, idempotent release, receipt verifier) and is exercised on fixtures by N04, N08 to N11",
    observed:
      "not run: no testnet write was attempted; the repository's only RPC client is read-only and has no broadcast method",
  });
});
