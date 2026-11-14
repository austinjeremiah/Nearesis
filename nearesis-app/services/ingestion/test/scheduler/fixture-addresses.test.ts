import { describe, expect, it } from "vitest";
import { CredentialSource } from "../../src/http/credentials.ts";
import { quoteAddress } from "../../src/scheduler/config.ts";
import {
  FIXTURE_ADDRESS_LABEL,
  loadFixtureAddresses,
  validAddressFormat,
} from "../../src/scheduler/fixture-addresses.ts";

describe("quote-only fixture addresses", () => {
  const cfg = loadFixtureAddresses();
  it("is labelled non-owned and every available address is valid for its chain and has provenance", () => {
    expect(cfg.label).toBe(FIXTURE_ADDRESS_LABEL);
    for (const c of Object.values(cfg.chains)) {
      if (c.status === "available") {
        expect(validAddressFormat(c.format, c.address as string)).toBe(true);
        expect(c.provenance.length).toBeGreaterThan(10);
      } else expect(c.address).toBeNull();
    }
  });
  it("reuses one EVM address for Ethereum, Base and Arbitrum; NEAR and Bitcoin are unavailable", () => {
    expect(new Set(["eth", "base", "arb"].map((c) => cfg.chains[c]!.address)).size).toBe(1);
    expect(cfg.chains.near!.status).toBe("unavailable");
    expect(cfg.chains.btc!.status).toBe("unavailable");
    const none = CredentialSource.fromEnv({});
    expect(quoteAddress(none, "recipient", "near")).toBeNull();
    expect(quoteAddress(none, "refund", "btc")).toBeNull();
    expect(quoteAddress(none, "recipient", "arb")).toBe(cfg.chains.arb!.address);
  });
  it("rejects malformed addresses per chain", () => {
    expect(validAddressFormat("evm", "0x123")).toBe(false);
    expect(validAddressFormat("evm", "2527D02599Ba641c19FEa793cD0F167589a0f10D")).toBe(false);
    expect(validAddressFormat("solana", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D")).toBe(false);
    expect(validAddressFormat("solana", "short")).toBe(false);
    expect(validAddressFormat("bitcoin", "not-a-btc-address")).toBe(false);
  });
  it("an environment address overrides the fixture", () => {
    expect(
      quoteAddress(CredentialSource.fromEnv({ NEARESIS_QUOTE_ADDRESS_ARB: "0xabc" }), "refund", "arb"),
    ).toBe("0xabc");
  });
});
