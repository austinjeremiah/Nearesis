import { canonicalSha256 } from "./canonical.ts";

/**
 * V05 comparison logic: the hash read back from a chain transaction must equal the canonical SHA-256 of the
 * preregistration document. Pure and offline; fetching the transaction needs a testnet write (BLOCKED_DEPENDENCY,
 * no signing is allowed in this phase), so nothing here claims a transaction exists.
 */
export const canonicalDocHash = (doc: unknown): string => canonicalSha256(doc);

export function compareReadback(
  doc: unknown,
  readback: { network: string; payloadHash: string | null },
  expectedNetwork: "testnet" | "mainnet",
): { equal: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (readback.network !== expectedNetwork) reasons.push("NETWORK_MISMATCH");
  if (readback.payloadHash === null) reasons.push("NO_PAYLOAD");
  else if (readback.payloadHash.replace(/^sha256:/, "") !== canonicalDocHash(doc))
    reasons.push("HASH_MISMATCH");
  return { equal: reasons.length === 0, reasons };
}
