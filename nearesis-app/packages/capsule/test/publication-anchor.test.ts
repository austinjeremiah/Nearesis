import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  addTrustedKey,
  anchoredTimeFor,
  buildPublishManifest,
  entryHashOf,
  newChallenge,
  publishStatic,
  revokeTrustedKey,
  signChallenge,
  verifyAnchorChain,
  verifyPublishManifest,
} from "../src/index.ts";
import type { AnchorEntry } from "../src/index.ts";
import { RESEARCH_BUNDLE, SNAPSHOT, tmp } from "./helpers.ts";

const mk = (prev: AnchorEntry | null, o: Partial<AnchorEntry> & { manifestHash: string }): AnchorEntry => {
  const base = {
    seq: (prev?.seq ?? 0) + 1,
    kind: "publish" as const,
    signedAt: "",
    payload: "{}",
    anchoredAt: "2026-11-01T00:00:00.000000Z",
    prevHash: prev?.entryHash ?? GENESIS_HASH,
    ...o,
  };
  return { ...base, entryHash: entryHashOf(base) };
};

describe("publication anchor chain", () => {
  const a = mk(null, { manifestHash: "a".repeat(64) });
  const b = mk(a, { manifestHash: "b".repeat(64) });
  it("an intact chain verifies; edited, reordered, dropped and re-linked entries are detected", () => {
    expect(verifyAnchorChain([a, b])).toEqual([]);
    expect(verifyAnchorChain([a, { ...b, anchoredAt: "2020-01-01T00:00:00.000000Z" }])).not.toEqual([]);
    expect(verifyAnchorChain([b, a])).not.toEqual([]);
    expect(verifyAnchorChain([b])).not.toEqual([]);
    expect(verifyAnchorChain([{ ...a, prevHash: "1".repeat(64) }, b])).not.toEqual([]);
  });
  it("a broken chain proves nothing; a chain-commit entry can only move the proven time earlier", () => {
    expect(anchoredTimeFor([a, { ...b, payload: "x" }], "a".repeat(64))).toBeNull();
    const c = mk(b, {
      kind: "chain-commit",
      manifestHash: "b".repeat(64),
      payload: JSON.stringify({
        network: "testnet",
        contract: "c",
        txHash: "t",
        viewTimestampNs: "1700000000000000000",
      }),
    });
    expect(anchoredTimeFor([a, b, c], "b".repeat(64))).toBe(new Date(1_700_000_000_000).toISOString());
    expect(anchoredTimeFor([a, b, c], "c".repeat(64))).toBeNull();
  });
});

describe("revocation with an independent publication log (throwaway key)", () => {
  const kp = generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const reg = join(tmp("anchor-"), "reg.json");
  const challenge = newChallenge();
  addTrustedKey(reg, { publicKeyPem: pub, challenge, signature: signChallenge(challenge, kp.privateKey) });
  const r = publishStatic({
    snapshotDir: SNAPSHOT,
    researchBundleDir: RESEARCH_BUNDLE,
    root: tmp("anchor-pub-"),
    signer: { privateKeyPem: priv },
  });
  const mh = r.manifest.manifestHash;
  const T0 = Date.parse("2026-11-05T00:00:00Z");
  const log = (anchoredAt: string, manifestHash = mh): AnchorEntry[] => [
    mk(null, { manifestHash, anchoredAt }),
  ];

  it("signed and logged before revocation stays trusted; signed after is untrusted; a backdated signedAt is caught by the log", () => {
    const before = buildPublishManifest(r.bundle, { privateKeyPem: priv }, new Date(T0 - 86_400_000));
    const after = buildPublishManifest(r.bundle, { privateKeyPem: priv }, new Date(T0 + 86_400_000));
    // the manifest body is identical, so both share manifestHash; write each manifest to its own file
    const dir = tmp("anchor-m-");
    const fb = join(dir, "before.json");
    const fa = join(dir, "after.json");
    writeFileSync(fb, JSON.stringify(before));
    writeFileSync(fa, JSON.stringify(after));
    const fpr = JSON.parse(readFileSync(reg, "utf8")).keys[0].fingerprint as string;
    // active key, no log consulted
    expect(verifyPublishManifest(r.bundle.dir, fb, { registry: reg }).trusted).toBe(true);
    revokeTrustedKey(reg, fpr, "throwaway test key revoked", new Date(T0));
    // legacy (signer-asserted time only)
    expect(verifyPublishManifest(r.bundle.dir, fb, { registry: reg }).trusted).toBe(true);
    expect(verifyPublishManifest(r.bundle.dir, fa, { registry: reg }).trusted).toBe(false);
    // with the independent log: logged before revocation -> trusted
    const early = log("2026-11-04T12:00:00.000000Z");
    expect(verifyPublishManifest(r.bundle.dir, fb, { registry: reg, anchors: early }).trusted).toBe(true);
    // backdated: the attacker claims signedAt before revocation, but the log saw it only after -> untrusted
    const late = log("2026-11-06T12:00:00.000000Z");
    const v = verifyPublishManifest(r.bundle.dir, fb, { registry: reg, anchors: late });
    expect(v.trusted).toBe(false);
    expect(v.trustReason).toMatch(/log time\) after the key was revoked/);
    // not in the log at all -> untrusted once a log is consulted
    const none = verifyPublishManifest(r.bundle.dir, fb, {
      registry: reg,
      anchors: log("2026-11-04T00:00:00.000000Z", "d".repeat(64)),
    });
    expect(none.trusted).toBe(false);
    // signed after revocation stays untrusted even if logged early
    expect(verifyPublishManifest(r.bundle.dir, fa, { registry: reg, anchors: early }).trusted).toBe(false);
    // a tampered chain yields no trust
    expect(
      verifyPublishManifest(r.bundle.dir, fb, { registry: reg, anchors: [{ ...early[0]!, payload: "x" }] })
        .trusted,
    ).toBe(false);
  });

  it("a manifest that fails integrity is never trusted, even with an active trusted key", () => {
    const kp2 = generateKeyPairSync("ed25519");
    const reg2 = join(tmp("anchor-"), "reg.json");
    const c = newChallenge();
    addTrustedKey(reg2, {
      publicKeyPem: kp2.publicKey.export({ type: "spki", format: "pem" }).toString(),
      challenge: c,
      signature: signChallenge(c, kp2.privateKey),
    });
    const r2 = publishStatic({
      snapshotDir: SNAPSHOT,
      researchBundleDir: RESEARCH_BUNDLE,
      root: tmp("anchor-pub2-"),
      signer: { privateKeyPem: kp2.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    });
    expect(verifyPublishManifest(r2.bundle.dir, r2.manifestPath, { registry: reg2 }).trusted).toBe(true);
    const m = JSON.parse(readFileSync(r2.manifestPath, "utf8"));
    m.manifestHash = "0".repeat(64);
    const bad = join(tmp("anchor-t-"), "m.json");
    writeFileSync(bad, JSON.stringify(m));
    const v = verifyPublishManifest(r2.bundle.dir, bad, { registry: reg2 });
    expect(v.ok).toBe(false);
    expect(v.trusted).toBe(false);
  });
});
