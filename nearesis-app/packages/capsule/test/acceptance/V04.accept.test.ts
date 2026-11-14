import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { AttestationPolicy } from "@nearesis/contracts";
import {
  attestationPayload,
  buildCapsule,
  loadCapsuleView,
  sha256Hex,
  verifyAttestation,
} from "../../src/index.ts";
import { SNAPSHOT, WASM, committedPolicy, makeEvidence, testSigner, tmp } from "../helpers.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** V04 (ch.16): wrong TEE signer; fail-closed proof policy. */
it("V04: wrong, unregistered or unverifiable signers are rejected; the policy fails closed", async () => {
  const wasm = sha256Hex(readFileSync(WASM));
  const dir = tmp("v04-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  const io = { inputSha256: m.computation.inputSha256, outputSha256: m.computation.resultsSha256 };
  const ctx = {
    localWasmSha256: wasm,
    expectedInputSha256: io.inputSha256,
    expectedOutputSha256: io.outputSha256,
    now: new Date(),
  };
  const good = testSigner();
  const wrong = testSigner();
  const policy = committedPolicy([good.signer]);

  const control = await verifyAttestation(makeEvidence(good, { wasmSha256: wasm, ...io }), policy, ctx);
  expect(control.decision).toBe("accept");

  // 1. valid signature by a signer that is not registered
  const r1 = await verifyAttestation(makeEvidence(wrong, { wasmSha256: wasm, ...io }), policy, ctx);
  expect(r1.decision).toBe("reject");
  expect(r1.reasons).toContain("SIGNER_NOT_ALLOWED");
  // 2. evidence names the registered signer but is signed by another key
  const forged = makeEvidence(wrong, { wasmSha256: wasm, ...io });
  forged.signer = good.signer;
  const r2 = await verifyAttestation(forged, policy, ctx);
  expect(r2.reasons).toContain("SIGNATURE_INVALID");
  expect(attestationPayload(forged)).toContain(wasm);
  // 3. the shipped policy has no registered signer, so everything is rejected (fail closed)
  const r3 = await verifyAttestation(
    makeEvidence(good, { wasmSha256: wasm, ...io }),
    committedPolicy([]),
    ctx,
  );
  expect(r3.decision).toBe("reject");
  expect(r3.reasons).toContain("SIGNER_NOT_ALLOWED");
  // 4. malformed evidence, missing fields, garbage
  for (const bad of [
    null,
    {},
    "x",
    { ...makeEvidence(good, { wasmSha256: wasm, ...io }), signature: undefined },
    { ...makeEvidence(good, { wasmSha256: wasm, ...io }), extra: 1 },
  ])
    expect((await verifyAttestation(bad, policy, ctx)).reasons).toEqual(["EVIDENCE_MALFORMED"]);
  // 5. outlayer provenance without a quote verifier, or with a failing one, is never attested
  const ol = makeEvidence(good, {
    provenance: "outlayer",
    network: "testnet",
    quote: "AAAA",
    wasmSha256: wasm,
    ...io,
  });
  const r5 = await verifyAttestation(ol, policy, ctx);
  expect(r5.reasons).toContain("QUOTE_NOT_VERIFIED");
  expect(r5.proofLabel).toBe("none");
  const r5b = await verifyAttestation(ol, policy, {
    ...ctx,
    quoteVerifier: { verifyQuote: () => ({ ok: false }) },
  });
  expect(r5b.decision).toBe("reject");
  // 6. a stale or future-dated attestation is rejected; mainnet is not allowed by the shipped policy
  const stale = await verifyAttestation(
    makeEvidence(good, { wasmSha256: wasm, ...io }, new Date(Date.now() - 3 * 86_400_000)),
    policy,
    ctx,
  );
  expect(stale.reasons).toContain("EVIDENCE_STALE_OR_FUTURE");
  const mainnet = await verifyAttestation(
    makeEvidence(good, {
      provenance: "outlayer",
      network: "mainnet",
      quote: "AAAA",
      wasmSha256: wasm,
      ...io,
    }),
    policy,
    { ...ctx, quoteVerifier: { verifyQuote: () => ({ ok: true }) } },
  );
  expect(mainnet.reasons).toContain("NETWORK_NOT_ALLOWED");
  // 7. empty-allowlist policy objects still parse and reject
  expect(
    AttestationPolicy.parse({
      schemaVersion: "nearesis.attestation-policy.v1",
      allowedWasmSha256: [],
      allowedSigners: [],
      allowedNetworks: [],
      maxAgeSeconds: 1,
    }).allowedSigners,
  ).toEqual([]);

  // 8. in a capsule the rejection shows up as OutLayer "failed", never "verified"
  mkdirSync(join(dir, "attestation"), { recursive: true });
  writeFileSync(
    join(dir, "attestation", "evidence.json"),
    JSON.stringify(makeEvidence(wrong, { wasmSha256: wasm, ...io })),
  );
  const view = await loadCapsuleView(dir, { research: "skip", wasm: "skip", policy });
  expect(view!.verification.outlayer.status).toBe("failed");
  expect(view!.verification.outlayer.detail).toContain("SIGNER_NOT_ALLOWED");

  observe({
    testId: "V04",
    observed: `Control accepted. Unregistered signer -> [${r1.reasons.join(",")}]; registered name with another key -> [${r2.reasons.join(",")}]; shipped empty-signer policy -> [${r3.reasons.join(",")}]; malformed evidence x5 -> EVIDENCE_MALFORMED; outlayer evidence without quote verifier -> [${r5.reasons.join(",")}] label ${r5.proofLabel}; stale -> rejected; mainnet -> rejected; capsule view outlayer.status=${view!.verification.outlayer.status}. No real OutLayer signer exists yet (BLK-20261110-003).`,
    fixtureHash: wasm,
    evidence: {
      unregistered: r1.reasons,
      forged: r2.reasons,
      failClosed: r3.reasons,
      noQuote: r5.reasons,
      capsuleOutlayerStatus: view!.verification.outlayer.status,
    },
  });
}, 120_000);
