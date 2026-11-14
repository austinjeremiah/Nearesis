import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  generateSigningKeyPair,
  parseManifest,
  signManifest,
  verifyManifestSignature,
  sha256Hex,
} from "../src/index.ts";

const base = {
  pluginId: "unit-plugin",
  version: "1.0.0",
  apiVersion: 1,
  publisher: "unit",
  artifactSha256: sha256Hex("x"),
  capabilities: [
    {
      id: "unit.say@1",
      category: "tool.provider",
      sideEffect: "read_only",
      idempotent: true,
      latencyClass: "interactive",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      requiredGrants: [],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    },
  ],
  permissions: [],
  networkHosts: [],
  resourceLimits: { memoryMb: 64, cpuMs: 1000, concurrency: 1 },
  configurationSchema: {},
  healthCheck: { intervalMs: 1000 },
  entrypoint: "x.ts",
  rollbackStrategy: "previous_version",
};

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"z":1}]},"b":1}',
    );
  });
  it("is insensitive to key order", () => {
    expect(canonicalJson({ a: 1, b: { x: 1, y: 2 } })).toBe(canonicalJson({ b: { y: 2, x: 1 }, a: 1 }));
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("manifest signing", () => {
  const kp = generateSigningKeyPair();
  const m = parseManifest(base);
  const signed = { ...m, signature: signManifest(m, kp.privateKey) };
  it("verifies a valid signature", () => {
    expect(verifyManifestSignature(signed, { unit: [kp.publicKey] }).ok).toBe(true);
  });
  it("rejects tampering", () => {
    const t = { ...signed, version: "1.0.1" };
    expect(verifyManifestSignature(t, { unit: [kp.publicKey] })).toEqual({
      ok: false,
      reason: "INVALID_SIGNATURE",
    });
  });
  it("rejects missing signature, untrusted publisher and wrong key", () => {
    expect(verifyManifestSignature(m, { unit: [kp.publicKey] })).toEqual({
      ok: false,
      reason: "MISSING_SIGNATURE",
    });
    expect(verifyManifestSignature(signed, {})).toEqual({ ok: false, reason: "UNTRUSTED_PUBLISHER" });
    const other = generateSigningKeyPair();
    expect(verifyManifestSignature(signed, { unit: [other.publicKey] }).ok).toBe(false);
  });
  it("tolerates garbage keys and signatures", () => {
    expect(verifyManifestSignature(signed, { unit: ["not-a-key"] }).ok).toBe(false);
    expect(verifyManifestSignature({ ...signed, signature: "@@@" }, { unit: [kp.publicKey] }).ok).toBe(false);
  });
  it("rejects a manifest without rollbackStrategy", () => {
    const { rollbackStrategy: _r, ...rest } = base;
    expect(() => parseManifest(rest)).toThrow(/rollbackStrategy/);
  });
});
