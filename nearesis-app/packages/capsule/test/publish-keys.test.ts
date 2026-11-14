import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addTrustedKey,
  buildPublishManifest,
  fingerprintOf,
  loadSigningKey,
  newChallenge,
  publishStatic,
  readRegistry,
  revokeTrustedKey,
  signChallenge,
  trustDecision,
  verifyPublishManifest,
} from "../src/index.ts";
import { RESEARCH_BUNDLE, SNAPSHOT, tmp } from "./helpers.ts";

const kp = () => generateKeyPairSync("ed25519");
const pubPem = (k: ReturnType<typeof kp>) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const privPem = (k: ReturnType<typeof kp>) =>
  k.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const add = (reg: string, k: ReturnType<typeof kp>, now = new Date()) => {
  const challenge = newChallenge(now);
  return addTrustedKey(
    reg,
    { publicKeyPem: pubPem(k), challenge, signature: signChallenge(challenge, k.privateKey) },
    now,
  );
};

describe("trusted publish-key registry", () => {
  const dir = tmp("keys-");
  const reg = join(dir, "reg.json");
  const k = kp();
  const root = tmp("pubkeys-");
  const at = new Date("2026-11-01T00:00:00Z");
  const r = publishStatic({
    snapshotDir: SNAPSHOT,
    researchBundleDir: RESEARCH_BUNDLE,
    root,
    signer: { privateKeyPem: privPem(k) },
  });
  // re-sign the same bundle at a chosen time
  const signedAtManifest = (t: Date, key = k) =>
    buildPublishManifest(r.bundle, { privateKeyPem: privPem(key) }, t);

  it("an unknown key is untrusted; an added active key is trusted; the full fingerprint is stored", () => {
    expect(verifyPublishManifest(r.bundle.dir, r.manifestPath, { registry: reg }).trusted).toBe(false);
    const e = add(reg, k, new Date());
    expect(e.fingerprint).toBe(fingerprintOf(pubPem(k)));
    expect(e.fingerprint).toHaveLength(64);
    const v = verifyPublishManifest(r.bundle.dir, r.manifestPath, { registry: reg });
    expect(v.trusted).toBe(true);
    expect(v.trustReason).toBe("active key");
    expect(JSON.stringify(readRegistry(reg))).not.toMatch(/PRIVATE KEY/);
  });

  it("proof of possession: a wrong signature, a stale challenge and a reused challenge are rejected and write nothing", () => {
    const other = kp();
    const stranger = kp();
    const c = newChallenge();
    const before = readFileSync(reg, "utf8");
    // signed by a different key than the one being added
    expect(() =>
      addTrustedKey(reg, {
        publicKeyPem: pubPem(other),
        challenge: c,
        signature: signChallenge(c, stranger.privateKey),
      }),
    ).toThrow(/proof of possession/);
    // stale challenge
    const old = newChallenge(new Date(Date.now() - 3_600_000));
    expect(() =>
      addTrustedKey(reg, {
        publicKeyPem: pubPem(other),
        challenge: old,
        signature: signChallenge(old, other.privateKey),
      }),
    ).toThrow(/not fresh/);
    expect(() => addTrustedKey(reg, { publicKeyPem: pubPem(other), challenge: "x", signature: "" })).toThrow(
      /malformed/,
    );
    expect(readFileSync(reg, "utf8")).toBe(before);
    // replay of an already used challenge by a different key
    const used = readRegistry(reg).keys[0]!.proofOfPossession;
    expect(() => addTrustedKey(reg, { publicKeyPem: pubPem(other), ...used })).toThrow();
    // a valid proof adds the key; adding the same key twice fails
    add(reg, other);
    expect(() => add(reg, other)).toThrow(/already/);
  });

  it("revocation: signed after revokedAt is untrusted, before is still trusted, unproven time is untrusted", () => {
    const rk = kp();
    const rreg = join(dir, "rev.json");
    add(rreg, rk);
    revokeTrustedKey(
      rreg,
      fingerprintOf(pubPem(rk)).slice(0, 16),
      "key exposed in a log",
      new Date("2026-11-10T00:00:00Z"),
    );
    const e = readRegistry(rreg).keys[0]!;
    expect(e).toMatchObject({
      status: "revoked",
      revokedAt: "2026-11-10T00:00:00.000Z",
      reason: "key exposed in a log",
    });
    const write = (t: Date) => {
      const m = signedAtManifest(t, rk);
      const p = join(dir, `m-${t.getTime()}.json`);
      writeFileSync(p, JSON.stringify(m));
      return { m, p };
    };
    const verify = (p: string) => verifyPublishManifest(r.bundle.dir, p, { registry: rreg });
    // the manifest body is identical to the published one, so only the signature differs
    const before = write(new Date("2026-11-05T00:00:00Z"));
    const after = write(new Date("2026-11-11T00:00:00Z"));
    expect(verify(before.p)).toMatchObject({
      signature: "valid",
      trusted: true,
      trustReason: "signed before the key was revoked",
    });
    expect(verify(after.p)).toMatchObject({
      signature: "valid",
      trusted: false,
      trustReason: "signed after the key was revoked",
    });
    // backdating signedAt without the key breaks the time signature, so the time is not proven
    const forged = {
      ...after.m,
      signature: { ...(after.m.signature as object), signedAt: "2026-11-05T00:00:00.000Z" },
    };
    const fp = join(dir, "forged.json");
    writeFileSync(fp, JSON.stringify(forged));
    expect(verify(fp)).toMatchObject({
      trusted: false,
      trustReason: expect.stringMatching(/no proven signing time/),
    });
    // a manifest without a signing time (older format) from a revoked key is untrusted
    const legacy = { ...after.m, signature: { ...(after.m.signature as Record<string, unknown>) } } as {
      signature: Record<string, unknown>;
    };
    delete legacy.signature.signedAt;
    delete legacy.signature.signedAtSignature;
    const lp = join(dir, "legacy.json");
    writeFileSync(lp, JSON.stringify(legacy));
    expect(verify(lp).trusted).toBe(false);
    expect(() => revokeTrustedKey(rreg, e.fingerprint, "again, again")).toThrow(/already revoked/);
    expect(() => revokeTrustedKey(rreg, e.fingerprint.slice(0, 16), "x")).toThrow(/reason/);
  });

  it("trustDecision is false for a key not in the registry", () => {
    expect(
      trustDecision({ schema: "nearesis.trusted-publish-keys.v1", keys: [] }, pubPem(kp()), at.toISOString())
        .trusted,
    ).toBe(false);
  });
});

describe("signing key loading", () => {
  const dir = tmp("keyload-");
  const k = kp();
  it("encrypted PKCS#8 loads with the env passphrase; wrong or missing passphrase fails without leaking", () => {
    const enc = k.privateKey
      .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "correct horse" })
      .toString();
    const f = join(dir, "enc.pem");
    writeFileSync(f, enc, { mode: 0o600 });
    process.env.TEST_PASS = "correct horse";
    const l = loadSigningKey({ kind: "encrypted-file", path: f, passphraseEnv: "TEST_PASS" });
    expect(fingerprintOf(createPublicKey(l.privateKey))).toBe(fingerprintOf(pubPem(k)));
    process.env.TEST_PASS = "wrong";
    expect(() => loadSigningKey({ kind: "encrypted-file", path: f, passphraseEnv: "TEST_PASS" })).toThrow(
      /cannot decrypt/,
    );
    delete process.env.TEST_PASS;
    expect(() => loadSigningKey({ kind: "encrypted-file", path: f, passphraseEnv: "TEST_PASS" })).toThrow(
      /not set/,
    );
  });
  it("plain file is a dev fallback: needs 0600, warns, never logs key material", () => {
    const f = join(dir, "plain.pem");
    writeFileSync(f, privPem(k));
    chmodSync(f, 0o644);
    expect(() => loadSigningKey({ kind: "plain-file", path: f, allowPlain: true })).toThrow(/0600/);
    chmodSync(f, 0o600);
    const logs: string[] = [];
    const l = loadSigningKey({ kind: "plain-file", path: f, allowPlain: true }, (m) => logs.push(m));
    expect(l.warnings[0]).toMatch(/dev fallback/);
    expect(logs.join("\n")).not.toMatch(/PRIVATE KEY|MC4C/);
    expect(() =>
      loadSigningKey({ kind: "plain-file", path: f, allowPlain: false as unknown as true }),
    ).toThrow(/explicit/);
  });
});
