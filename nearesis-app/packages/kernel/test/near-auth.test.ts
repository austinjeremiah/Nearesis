import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { nep413Hash, parseNearPublicKey, verifyNep413Signature, isTestnetAccountId } from "../src/index.ts";

const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("NEP-413 hash", () => {
  it("matches the spec example (known answer, digest computed independently with hashlib)", () => {
    const h = nep413Hash({ message: "hi", nonce, recipient: "myapp.com", callbackUrl: "myapp.com/callback" });
    expect(hex(h)).toBe("c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148");
  });
  it("encodes an absent callbackUrl as Option::None", () => {
    expect(hex(nep413Hash({ message: "hi", nonce, recipient: "myapp.com" }))).toBe(
      "0e80e1606a46e66fcb450f6ceb55803921e465fddee8216463cf7b2680c09f37",
    );
  });
});

describe("NEP-413 signature", () => {
  const sk = ed25519.utils.randomSecretKey();
  const pub = `ed25519:${base58.encode(ed25519.getPublicKey(sk))}`;
  const payload = { message: "Sign in to Nearesis", nonce, recipient: "nearesis" };
  const sig = (p = payload) => Buffer.from(ed25519.sign(nep413Hash(p), sk)).toString("base64");

  it("round-trips with a generated key", () => {
    expect(verifyNep413Signature(payload, pub, sig())).toBe(true);
  });
  it("rejects a different message, recipient, nonce, key and malformed input", () => {
    const s = sig();
    expect(verifyNep413Signature({ ...payload, message: "x" }, pub, s)).toBe(false);
    expect(verifyNep413Signature({ ...payload, recipient: "other" }, pub, s)).toBe(false);
    expect(verifyNep413Signature({ ...payload, nonce: new Uint8Array(32) }, pub, s)).toBe(false);
    const other = `ed25519:${base58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))}`;
    expect(verifyNep413Signature(payload, other, s)).toBe(false);
    expect(verifyNep413Signature(payload, pub, "not base64!")).toBe(false);
    expect(verifyNep413Signature(payload, pub, Buffer.alloc(10).toString("base64"))).toBe(false);
    expect(verifyNep413Signature(payload, "secp256k1:abc", s)).toBe(false);
  });
  it("parses keys strictly and classifies testnet accounts", () => {
    expect(parseNearPublicKey(pub)?.length).toBe(32);
    expect(parseNearPublicKey("ed25519:abc")).toBeNull();
    expect(isTestnetAccountId("alice.testnet")).toBe(true);
    expect(isTestnetAccountId("a".repeat(64))).toBe(true);
    expect(isTestnetAccountId("alice.near")).toBe(false);
    expect(isTestnetAccountId("alice")).toBe(false);
  });
});
