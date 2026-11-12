import { createPrivateKey, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Loading the publish signing key. Order of preference: macOS Keychain, then an encrypted PKCS#8 file with the passphrase
 * in the environment, then (explicit dev fallback only) a plain PKCS#8 file that must be mode 0600. Key material is never
 * logged; errors name the source, never its content.
 */
export const KEYCHAIN_SERVICE = "nearesis-publish-key";
export const PASSPHRASE_ENV = "NEARESIS_PUBLISH_KEY_PASSPHRASE";

export type KeySource =
  | { kind: "keychain"; service?: string; account?: string }
  | { kind: "encrypted-file"; path: string; passphraseEnv?: string }
  | { kind: "plain-file"; path: string; allowPlain: true };

export interface LoadedKey {
  privateKey: KeyObject;
  /** PKCS#8 PEM re-exported unencrypted, for `PublishSigner`. Hold in memory only. */
  privateKeyPem: string;
  source: KeySource["kind"];
  warnings: string[];
}

const pem = (k: KeyObject): string => k.export({ type: "pkcs8", format: "pem" }).toString();

export function loadSigningKey(
  src: KeySource,
  warn: (m: string) => void = (m) => console.error(m),
): LoadedKey {
  const warnings: string[] = [];
  if (src.kind === "keychain") {
    if (process.platform !== "darwin") throw new Error("keychain key source requires macOS");
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", src.service ?? KEYCHAIN_SERVICE, "-a", src.account ?? "publish", "-w"],
      { encoding: "utf8" },
    );
    if (r.status !== 0)
      throw new Error(`keychain item ${src.service ?? KEYCHAIN_SERVICE} not found or not readable`);
    const out = r.stdout.trim();
    // the item holds the PKCS#8 PEM directly or base64 of it (security -w prints a hex blob for multi-line secrets)
    const text = /^-----BEGIN/.test(out)
      ? out
      : /^[0-9a-f]+$/i.test(out) && out.length % 2 === 0
        ? Buffer.from(out, "hex").toString("utf8")
        : Buffer.from(out, "base64").toString("utf8");
    const key = createPrivateKey(text);
    return { privateKey: key, privateKeyPem: pem(key), source: "keychain", warnings };
  }
  if (src.kind === "encrypted-file") {
    const pass = process.env[src.passphraseEnv ?? PASSPHRASE_ENV];
    if (!pass) throw new Error(`${src.passphraseEnv ?? PASSPHRASE_ENV} is not set`);
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: readFileSync(src.path), format: "pem", passphrase: pass });
    } catch {
      throw new Error(`cannot decrypt ${src.path} (wrong passphrase or not an encrypted PKCS#8 PEM)`);
    }
    return { privateKey: key, privateKeyPem: pem(key), source: "encrypted-file", warnings };
  }
  if (!src.allowPlain) throw new Error("plain key files require an explicit dev fallback");
  const mode = statSync(src.path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${src.path} must be mode 0600 (is ${mode.toString(8)})`);
  const w = `WARNING: loading the publish key from a plain file (${src.path}); dev fallback only, use the Keychain or an encrypted key`;
  warnings.push(w);
  warn(w);
  const key = createPrivateKey(readFileSync(src.path, "utf8"));
  return { privateKey: key, privateKeyPem: pem(key), source: "plain-file", warnings };
}

/** Resolve a key source from flags/environment: keychain > encrypted file > plain file (needs allowPlain). */
export function resolveKeySource(o: {
  keychain?: boolean;
  keychainAccount?: string;
  encryptedFile?: string;
  plainFile?: string;
  allowPlain?: boolean;
}): KeySource {
  if (o.keychain) return { kind: "keychain", ...(o.keychainAccount ? { account: o.keychainAccount } : {}) };
  if (o.encryptedFile) return { kind: "encrypted-file", path: o.encryptedFile };
  if (o.plainFile) {
    if (!o.allowPlain) throw new Error("plain key file needs --allow-plain-dev-key (dev fallback)");
    return { kind: "plain-file", path: o.plainFile, allowPlain: true };
  }
  throw new Error(
    "no key source: use --keychain, --encrypted-key <file> or --plain-key <file> --allow-plain-dev-key",
  );
}
