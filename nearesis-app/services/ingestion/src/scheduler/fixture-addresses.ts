import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ADDRESS_LABEL = "quote-only fixture, non-owned";
const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "quote-fixture-addresses.json",
);

export interface FixtureChain {
  status: "available" | "unavailable";
  format: "evm" | "solana" | "near" | "bitcoin";
  address: string | null;
  provenance: string;
}
export interface FixtureAddresses {
  label: string;
  chains: Record<string, FixtureChain>;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58ByteLength(s: string): number | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let len = 0;
  for (; n > 0n; n >>= 8n) len++;
  return len + (s.length - s.replace(/^1+/, "").length);
}

/** Format check per chain (no checksum libraries; EIP-55 was verified once and is recorded in the config). */
export function validAddressFormat(format: FixtureChain["format"], a: string): boolean {
  switch (format) {
    case "evm":
      return /^0x[0-9a-fA-F]{40}$/.test(a);
    case "solana":
      return base58ByteLength(a) === 32;
    case "bitcoin":
      return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
    case "near":
      return (
        /^([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/.test(a) && a.length >= 2 && a.length <= 64
      );
  }
}

let cache: FixtureAddresses | null = null;
export function loadFixtureAddresses(path: string = CONFIG_PATH): FixtureAddresses {
  if (path === CONFIG_PATH && cache) return cache;
  const j = JSON.parse(readFileSync(path, "utf8")) as FixtureAddresses;
  if (j.label !== FIXTURE_ADDRESS_LABEL)
    throw new Error("fixture address config must carry the non-owned label");
  for (const [chain, c] of Object.entries(j.chains)) {
    if (c.status === "available") {
      if (!c.address || !validAddressFormat(c.format, c.address))
        throw new Error(`fixture address for ${chain} is not a valid ${c.format} address`);
      if (!c.provenance) throw new Error(`fixture address for ${chain} has no provenance`);
    } else if (c.address !== null) throw new Error(`unavailable chain ${chain} must not carry an address`);
  }
  if (path === CONFIG_PATH) cache = j;
  return j;
}

export const fixtureAddress = (chain: string): string | null => {
  const c = loadFixtureAddresses().chains[chain.toLowerCase()];
  return c?.status === "available" ? c.address : null;
};
