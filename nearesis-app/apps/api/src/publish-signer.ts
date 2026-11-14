import { existsSync } from "node:fs";
import { loadSigningKey } from "@nearesis/capsule";
import type { KeySource } from "@nearesis/capsule";

/**
 * Where the API gets its publish signing key. Hardened sources: the macOS Keychain (`NEARESIS_PUBLISH_KEYCHAIN=1`) or an
 * encrypted PKCS#8 file (`NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE` + `NEARESIS_PUBLISH_KEY_PASSPHRASE`). A plain PEM file
 * (`NEARESIS_PUBLISH_KEY_FILE`) is refused unless `NEARESIS_ALLOW_PLAIN_PUBLISH_KEY=1` (dev), and then every response and
 * log line says `hardened: false`. With no source configured the manifest is honestly unsigned (also not hardened).
 */
export type SignerResolution =
  | {
      kind: "signer";
      privateKeyPem: string;
      source: "keychain" | "encrypted-file" | "plain-file";
      hardened: boolean;
      warnings: string[];
    }
  | { kind: "unsigned"; hardened: false; source: "none" }
  | { kind: "refused"; reason: string; hardened: false; source: "plain-file" };

export function resolvePublishSigner(env: NodeJS.ProcessEnv = process.env): SignerResolution {
  let src: KeySource | null = null;
  if (env.NEARESIS_PUBLISH_KEYCHAIN === "1") src = { kind: "keychain" };
  else if (env.NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE)
    src = { kind: "encrypted-file", path: env.NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE };
  else if (env.NEARESIS_PUBLISH_KEY_FILE && existsSync(env.NEARESIS_PUBLISH_KEY_FILE)) {
    if (env.NEARESIS_ALLOW_PLAIN_PUBLISH_KEY !== "1")
      return {
        kind: "refused",
        source: "plain-file",
        hardened: false,
        reason:
          "a plaintext publish key file is refused; use the macOS Keychain (NEARESIS_PUBLISH_KEYCHAIN=1) or an encrypted key, or set NEARESIS_ALLOW_PLAIN_PUBLISH_KEY=1 for development",
      };
    src = { kind: "plain-file", path: env.NEARESIS_PUBLISH_KEY_FILE, allowPlain: true };
  }
  if (!src) return { kind: "unsigned", hardened: false, source: "none" };
  const k = loadSigningKey(src, () => undefined);
  return {
    kind: "signer",
    privateKeyPem: k.privateKeyPem,
    source: k.source,
    hardened: k.source !== "plain-file",
    warnings: k.warnings,
  };
}
