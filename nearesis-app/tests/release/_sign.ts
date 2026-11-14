/** Test-only signing: an ephemeral Ed25519 key for fixture-mode operator signatures. Never a production key. */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { manifestHash } from "../../scripts/release/manifest.ts";
import type { ReleaseManifest } from "../../scripts/release/manifest.ts";

export function signManifest(m: ReleaseManifest, privateKeyPem: string): string {
  return edSign(null, Buffer.from(manifestHash(m), "hex"), privateKeyPem).toString("base64");
}
export function testSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const k = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
