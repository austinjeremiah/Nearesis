import {
  createHash,
  createPublicKey,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Trusted publish-key registry (public keys only). `verifyPublishManifest` trusts a manifest only when its signing key is
 * `active`, or `revoked` and the manifest was signed strictly before `revokedAt`. A key enters the registry only with a
 * proof of possession: it must sign a fresh, single-use challenge, verified before the entry is written.
 */
export const REGISTRY_SCHEMA = "nearesis.trusted-publish-keys.v1";
export const DEFAULT_REGISTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "trusted-publish-keys.json",
);
export const CHALLENGE_MAX_AGE_MS = 10 * 60_000;

export interface TrustedKeyEntry {
  /** sha256 hex of the SPKI DER (full 64 chars). The 16-char key id is its prefix. */
  fingerprint: string;
  created: string;
  status: "active" | "revoked";
  revokedAt?: string;
  reason?: string;
  publicKeyPem: string;
  proofOfPossession: { challenge: string; signature: string };
}
export interface TrustedKeyRegistry {
  schema: typeof REGISTRY_SCHEMA;
  keys: TrustedKeyEntry[];
}

export const fingerprintOf = (key: KeyObject | string): string =>
  createHash("sha256")
    .update(
      (typeof key !== "string" && key.type === "public" ? key : createPublicKey(key)).export({
        type: "spki",
        format: "der",
      }) as Buffer,
    )
    .digest("hex");

export function readRegistry(file = DEFAULT_REGISTRY): TrustedKeyRegistry {
  if (!existsSync(file)) return { schema: REGISTRY_SCHEMA, keys: [] };
  const r = JSON.parse(readFileSync(file, "utf8")) as TrustedKeyRegistry;
  if (r.schema !== REGISTRY_SCHEMA || !Array.isArray(r.keys)) throw new Error(`bad key registry: ${file}`);
  return r;
}
function writeRegistry(file: string, r: TrustedKeyRegistry): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(tmp, file);
}

export function newChallenge(now = new Date()): string {
  return `nearesis-publish-key-pop:v1:${now.toISOString()}:${randomBytes(16).toString("hex")}`;
}
/** Sign a challenge with the private key (proof of possession). */
export const signChallenge = (challenge: string, privateKey: KeyObject): string =>
  edSign(null, Buffer.from(challenge), privateKey).toString("base64");

/** Add a key after verifying that it signed `challenge`, that the challenge is fresh, and that it was never used. */
export function addTrustedKey(
  file: string,
  input: { publicKeyPem: string; challenge: string; signature: string },
  now = new Date(),
): TrustedKeyEntry {
  const m = /^nearesis-publish-key-pop:v1:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z):[0-9a-f]{32}$/.exec(
    input.challenge,
  );
  const ts = m ? Date.parse(m[1]!) : NaN;
  if (!m || !Number.isFinite(ts)) throw new Error("malformed challenge");
  if (now.getTime() - ts > CHALLENGE_MAX_AGE_MS || ts - now.getTime() > 60_000)
    throw new Error("challenge is not fresh (max 10 minutes)");
  const pub = createPublicKey(input.publicKeyPem);
  if (pub.asymmetricKeyType !== "ed25519") throw new Error("only ed25519 keys are supported");
  let ok: boolean;
  try {
    ok = edVerify(null, Buffer.from(input.challenge), pub, Buffer.from(input.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("proof of possession failed: the challenge signature does not verify");
  const reg = readRegistry(file);
  const fingerprint = fingerprintOf(pub);
  if (reg.keys.some((k) => k.fingerprint === fingerprint)) throw new Error("key is already in the registry");
  if (reg.keys.some((k) => k.proofOfPossession.challenge === input.challenge))
    throw new Error("challenge was already used");
  const entry: TrustedKeyEntry = {
    fingerprint,
    created: now.toISOString(),
    status: "active",
    publicKeyPem: pub.export({ type: "spki", format: "pem" }).toString(),
    proofOfPossession: { challenge: input.challenge, signature: input.signature },
  };
  reg.keys.push(entry);
  writeRegistry(file, reg);
  return entry;
}

export function revokeTrustedKey(
  file: string,
  fingerprintOrId: string,
  reason: string,
  now = new Date(),
): TrustedKeyEntry {
  if (reason.trim().length < 5) throw new Error("a revocation reason is required");
  const reg = readRegistry(file);
  const hits = reg.keys.filter(
    (k) =>
      k.fingerprint === fingerprintOrId ||
      (fingerprintOrId.length >= 16 && k.fingerprint.startsWith(fingerprintOrId)),
  );
  if (hits.length !== 1) throw new Error(`no unique key matches ${fingerprintOrId}`);
  const k = hits[0]!;
  if (k.status === "revoked") throw new Error("key is already revoked");
  k.status = "revoked";
  k.revokedAt = now.toISOString();
  k.reason = reason;
  writeRegistry(file, reg);
  return k;
}

/**
 * Is a manifest signed by `publicKeyPem` at `signedAt` trusted? Active keys: yes. Revoked keys: only when `signedAt` is
 * proven and strictly earlier than `revokedAt`. Unknown keys: no.
 */
export function trustDecision(
  reg: TrustedKeyRegistry,
  publicKeyPem: string,
  signedAt: string | null,
): { trusted: boolean; reason: string } {
  let fp: string;
  try {
    fp = fingerprintOf(publicKeyPem);
  } catch {
    return { trusted: false, reason: "unreadable public key" };
  }
  const k = reg.keys.find((x) => x.fingerprint === fp);
  if (!k) return { trusted: false, reason: "key is not in the trusted-key registry" };
  if (k.status === "active") return { trusted: true, reason: "active key" };
  const rev = Date.parse(k.revokedAt ?? "");
  const at = signedAt ? Date.parse(signedAt) : NaN;
  if (!Number.isFinite(rev)) return { trusted: false, reason: "revoked key without a revocation time" };
  if (!Number.isFinite(at))
    return { trusted: false, reason: "revoked key and the manifest has no proven signing time" };
  return at < rev
    ? { trusted: true, reason: "signed before the key was revoked" }
    : { trusted: false, reason: "signed after the key was revoked" };
}

export const registryPathFromEnv = (): string =>
  resolve(process.env.NEARESIS_TRUSTED_KEYS_FILE ?? DEFAULT_REGISTRY);
