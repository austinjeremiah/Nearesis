import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AttestationPolicy } from "@nearesis/contracts";
import type { AttestationEvidence } from "@nearesis/contracts";
import { attestationPayload, sha256Hex } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PKG = join(here, "..");
export const APP = join(PKG, "..", "..");
export const SNAPSHOT = join(PKG, "fixtures", "snapshot-synthetic");
export const RESEARCH_BUNDLE = join(APP, "packages", "test-fixtures", "research", "signal-bundle");
export const WASM = join(APP, "services", "outlayer-verifier", "out", "nearesis-verifier.wasm");
export const POLICY_FILE = join(APP, "services", "outlayer-verifier", "policy", "attestation-policy.json");

export const tmp = (p = "capsule-"): string => mkdtempSync(join(tmpdir(), p));

export function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = sha256Hex(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** A locally generated ed25519 key standing in for a TEE signer. TEST-ONLY: it is never an OutLayer signer. */
export function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { signer: Buffer.from(raw).toString("base64url"), privateKey };
}

export function makeEvidence(
  s: ReturnType<typeof testSigner>,
  over: Partial<AttestationEvidence> & { wasmSha256: string; inputSha256: string; outputSha256: string },
  now = new Date(),
): AttestationEvidence {
  const base: AttestationEvidence = {
    provenance: "synthetic",
    jobId: "synthetic-job-1",
    network: "none",
    signer: s.signer,
    signature: "x",
    quote: null,
    issuedAt: now.toISOString(),
    ...over,
  };
  base.signature = sign(null, Buffer.from(attestationPayload(base)), s.privateKey).toString("base64url");
  return base;
}

export const committedPolicy = (signers: string[]): AttestationPolicy =>
  AttestationPolicy.parse({ ...JSON.parse(readFileSync(POLICY_FILE, "utf8")), allowedSigners: signers });
