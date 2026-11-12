/**
 * pnpm research:publish-key list
 * pnpm research:publish-key add (--keychain [--account A] | --encrypted-key <file> | --plain-key <file> --allow-plain-dev-key)
 * pnpm research:publish-key revoke --fingerprint <sha256|prefix> --reason <text>
 *
 * `add` loads the private key, signs a fresh challenge, verifies it and only then writes the public entry to the registry
 * (packages/capsule/trusted-publish-keys.json, or NEARESIS_TRUSTED_KEYS_FILE). Never prints key material.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadSigningKey, resolveKeySource } from "./publish-key.ts";
import {
  addTrustedKey,
  newChallenge,
  readRegistry,
  registryPathFromEnv,
  revokeTrustedKey,
  signChallenge,
} from "./trusted-keys.ts";
import { createPublicKey } from "node:crypto";

const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  options: {
    keychain: { type: "boolean" },
    account: { type: "string" },
    "encrypted-key": { type: "string" },
    "plain-key": { type: "string" },
    "allow-plain-dev-key": { type: "boolean" },
    fingerprint: { type: "string" },
    reason: { type: "string" },
    registry: { type: "string" },
  },
});
const abs = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
const file = a.registry ? abs(a.registry) : registryPathFromEnv();

try {
  if (cmd === "list") {
    for (const k of readRegistry(file).keys)
      console.log(
        `${k.fingerprint}  keyId=${k.fingerprint.slice(0, 16)}  ${k.status}  created=${k.created}${k.revokedAt ? `  revokedAt=${k.revokedAt}  reason=${k.reason}` : ""}`,
      );
  } else if (cmd === "add") {
    const src = resolveKeySource({
      keychain: a.keychain ?? false,
      ...(a.account ? { keychainAccount: a.account } : {}),
      ...(a["encrypted-key"] ? { encryptedFile: abs(a["encrypted-key"]) } : {}),
      ...(a["plain-key"] ? { plainFile: abs(a["plain-key"]) } : {}),
      allowPlain: a["allow-plain-dev-key"] ?? false,
    });
    const key = loadSigningKey(src);
    const challenge = newChallenge();
    const entry = addTrustedKey(file, {
      publicKeyPem: createPublicKey(key.privateKey).export({ type: "spki", format: "pem" }).toString(),
      challenge,
      signature: signChallenge(challenge, key.privateKey),
    });
    console.log(`added ${entry.fingerprint} (keyId ${entry.fingerprint.slice(0, 16)}) to ${file}`);
  } else if (cmd === "revoke") {
    if (!a.fingerprint || !a.reason)
      throw new Error("usage: revoke --fingerprint <sha256|prefix> --reason <text>");
    const k = revokeTrustedKey(file, a.fingerprint, a.reason);
    console.log(`revoked ${k.fingerprint} at ${k.revokedAt}`);
  } else {
    console.error(
      "usage: list | add (--keychain | --encrypted-key f | --plain-key f --allow-plain-dev-key) | revoke --fingerprint F --reason R",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
