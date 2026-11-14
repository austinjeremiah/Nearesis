import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { PluginManifest } from "@nearesis/contracts";
import { canonicalJson } from "./canonical.ts";

/** Keys travel as base64 DER: public = SPKI, private = PKCS8. */
export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** The exact bytes that are signed: canonical JSON of the manifest without `signature`. */
export function manifestSigningInput(manifest: Omit<PluginManifest, "signature"> | PluginManifest): Buffer {
  const rest: Record<string, unknown> = { ...manifest };
  delete rest.signature;
  return Buffer.from(canonicalJson(rest), "utf8");
}

export function signManifest(
  manifest: Omit<PluginManifest, "signature"> | PluginManifest,
  privateKeyB64: string,
): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, manifestSigningInput(manifest), key).toString("base64");
}

export type SignatureCheck =
  | { ok: true; keyIndex: number }
  | { ok: false; reason: "MISSING_SIGNATURE" | "UNTRUSTED_PUBLISHER" | "INVALID_SIGNATURE" };

/**
 * Verify against the trusted public keys of the manifest's publisher. Never throws on malformed signatures or keys:
 * any failure is a rejection.
 */
export function verifyManifestSignature(
  manifest: PluginManifest,
  trustedKeys: Readonly<Record<string, readonly string[]>>,
): SignatureCheck {
  if (!manifest.signature) return { ok: false, reason: "MISSING_SIGNATURE" };
  const keys = trustedKeys[manifest.publisher];
  if (!keys || keys.length === 0) return { ok: false, reason: "UNTRUSTED_PUBLISHER" };
  const input = manifestSigningInput(manifest);
  const sig = Buffer.from(manifest.signature, "base64");
  for (const [keyIndex, k] of keys.entries()) {
    try {
      const pub = createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
      if (verify(null, input, pub, sig)) return { ok: true, keyIndex };
    } catch {
      /* try next key */
    }
  }
  return { ok: false, reason: "INVALID_SIGNATURE" };
}
