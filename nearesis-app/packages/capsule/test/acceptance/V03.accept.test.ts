import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildCapsule, sha256Hex, verifyAttestation, verifyCapsule } from "../../src/index.ts";
import { SNAPSHOT, WASM, committedPolicy, makeEvidence, testSigner, tmp } from "../helpers.ts";

/** V03 (ch.16): alter the WASM binary; the attestation binary hash mismatches and the evidence is rejected. */
it("V03: an altered WASM binary is rejected by the attestation policy", async () => {
  const goodBytes = readFileSync(WASM);
  const goodHash = sha256Hex(goodBytes);
  const signer = testSigner();
  const policy = committedPolicy([signer.signer]);
  const dir = tmp("v03-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  expect(m.computation.verifier.wasmSha256).toBe(goodHash);
  const io = { inputSha256: m.computation.inputSha256, outputSha256: m.computation.resultsSha256 };
  const ctx = (localWasmSha256: string) => ({
    localWasmSha256,
    expectedInputSha256: io.inputSha256,
    expectedOutputSha256: io.outputSha256,
    now: new Date(),
  });

  // control: the real binary with correctly signed synthetic evidence passes the policy (and is labelled synthetic)
  const control = await verifyAttestation(
    makeEvidence(signer, { wasmSha256: goodHash, ...io }),
    policy,
    ctx(goodHash),
  );
  expect(control).toEqual({ decision: "accept", reasons: [], proofLabel: "policy_checked_synthetic" });

  // tamper: flip one byte of a copy of the real binary
  const tampered = Buffer.from(goodBytes);
  const mid = Math.floor(tampered.length / 2);
  tampered.writeUInt8(tampered.readUInt8(mid) ^ 0xff, mid);
  const tamperedHash = sha256Hex(tampered);
  expect(tamperedHash).not.toBe(goodHash);

  // (a) evidence honestly reports the original hash but the binary on disk is the tampered one
  const a = await verifyAttestation(
    makeEvidence(signer, { wasmSha256: goodHash, ...io }),
    policy,
    ctx(tamperedHash),
  );
  expect(a.decision).toBe("reject");
  expect(a.reasons).toContain("WASM_HASH_MISMATCH");
  // (b) evidence reports the tampered hash (attacker re-signs): the pinned allowlist rejects it
  const b = await verifyAttestation(
    makeEvidence(signer, { wasmSha256: tamperedHash, ...io }),
    policy,
    ctx(tamperedHash),
  );
  expect(b.decision).toBe("reject");
  expect(b.reasons).toContain("WASM_HASH_NOT_ALLOWED");
  // (c) tampered output hash is rejected too
  const c = await verifyAttestation(
    makeEvidence(signer, { wasmSha256: goodHash, ...io, outputSha256: "0".repeat(64) }),
    policy,
    ctx(goodHash),
  );
  expect(c.reasons).toContain("OUTPUT_HASH_MISMATCH");
  // (d) the capsule itself refuses a swapped binary at cross-check time
  const wasmPath = join(tmp("v03-wasm-"), "nearesis-verifier.wasm");
  writeFileSync(wasmPath, tampered);
  const rep = await verifyCapsule(dir, { research: "skip", wasm: "crosscheck", wasmPath });
  expect(rep.failures.map((f) => f.kind)).toContain("WASM_CROSSCHECK_MISMATCH");

  observe({
    testId: "V03",
    observed: `Pinned wasm ${goodHash.slice(0, 16)} accepted (control, synthetic evidence). One byte flipped -> ${tamperedHash.slice(0, 16)}: honest evidence rejected [${a.reasons.join(",")}]; re-signed evidence rejected [${b.reasons.join(",")}]; altered output hash rejected [${c.reasons.join(",")}]; capsule cross-check [${rep.failures.map((f) => f.kind).join(",")}]. Evidence is synthetic (local test key), not an OutLayer proof.`,
    fixtureHash: goodHash,
    evidence: {
      goodHash,
      tamperedHash,
      honestReasons: a.reasons,
      resignedReasons: b.reasons,
      outputReasons: c.reasons,
    },
  });
}, 120_000);
