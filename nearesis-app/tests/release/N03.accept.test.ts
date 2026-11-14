/** N03: minimal NEAR mainnet commitment. HUMAN ONLY (owner correction 5): HUMAN-required, so BLOCKED_DEPENDENCY. Nothing is sent. */
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { NEAR_READ_METHODS } from "../../scripts/release/chain.ts";

it("N03: blocked, a mainnet write needs the operator, an approval record and a real signer that agents may not use", () => {
  expect((NEAR_READ_METHODS as readonly string[]).some((m) => /broadcast|send/.test(m))).toBe(false);
  observe({
    testId: "N03",
    blocked:
      "HUMAN-required: the single mainnet write is performed by the operator after the human approval record; agents may not sign, broadcast or touch wallets. Release tooling for it exists (preflight, idempotent release, receipt verifier) and is exercised on fixtures by N04, N08 to N11",
    observed:
      "not run: no mainnet write was attempted; the repository's only RPC client is read-only and has no broadcast method",
  });
});
