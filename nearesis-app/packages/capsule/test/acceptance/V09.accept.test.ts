import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  buildCapsule,
  createTdxQuoteVerifier,
  loadCapsuleView,
  scanFixtureClaims,
  sha256Hex,
  verifyAttestation,
  verifyOutlayerLive,
  verifyTdxQuote,
} from "../../src/index.ts";
import { SNAPSHOT, WASM, committedPolicy, liveOutlayerV10, testSigner, tmp } from "../helpers.ts";
import { MRTD_GOOD, MRTD_OTHER, fixturePki, mintOutlayerEvidence, mintTdxQuote } from "../tdx-fixture.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttestationEvidence } from "@nearesis/contracts";

/** V09 (16b): attestation policy matrix fails closed. Mode FIXTURE: a test trust root, never an OutLayer claim. */
it("V09: every attestation defect is rejected with a distinct reason code; nothing unverified is marked verified", async () => {
  const wasm = sha256Hex(readFileSync(WASM));
  const dir = tmp("v09-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  const io = {
    wasmSha256: wasm,
    inputSha256: m.computation.inputSha256,
    outputSha256: m.computation.resultsSha256,
  };
  const pki = fixturePki();
  const signer = testSigner();
  const policy = {
    ...committedPolicy([signer.signer]),
    allowedMeasurements: [MRTD_GOOD],
  };
  // the shipped policy pins no production root, so nothing here can be live
  expect(committedPolicy([]).quoteTrustRootSha256).toEqual([]);
  const quoteVerifier = createTdxQuoteVerifier({ production: [], fixture: [pki.rootSha256] });
  const now = new Date();
  const ctx = {
    localWasmSha256: wasm,
    expectedInputSha256: io.inputSha256,
    expectedOutputSha256: io.outputSha256,
    expectedJobId: "fixture-job-1",
    now,
    quoteVerifier,
  };

  // (a) valid evidence verifies and the record carries all fields
  const good = mintOutlayerEvidence(signer, io, { at: now });
  const control = await verifyAttestation(good, policy, ctx);
  expect(control).toMatchObject({
    decision: "accept",
    proofLabel: "fixture_attested",
    evidenceSource: "fixture",
    measurement: MRTD_GOOD,
  });
  expect(control.proofLabel).not.toBe("outlayer_attested");

  // (b) 8 mutated copies, each minted so that exactly one defect is present
  const wrongJob = mintOutlayerEvidence(signer, io, { at: now, jobId: "someone-elses-job" });
  const cases: Array<[string, AttestationEvidence, string]> = [
    [
      "input hash changed",
      mintOutlayerEvidence(signer, { ...io, inputSha256: "1".repeat(64) }, { at: now }),
      "INPUT_HASH_MISMATCH",
    ],
    [
      "output hash changed",
      mintOutlayerEvidence(signer, { ...io, outputSha256: "2".repeat(64) }, { at: now }),
      "OUTPUT_HASH_MISMATCH",
    ],
    [
      "unapproved measurement",
      mintOutlayerEvidence(signer, io, { at: now, quote: { mrTd: MRTD_OTHER } }),
      "MEASUREMENT_NOT_ALLOWED",
    ],
    [
      "debug-mode quote",
      mintOutlayerEvidence(signer, io, { at: now, quote: { debug: true } }),
      "QUOTE_DEBUG_MODE",
    ],
    [
      "stale evidence",
      mintOutlayerEvidence(signer, io, { at: new Date(now.getTime() - 3 * 86_400_000) }),
      "EVIDENCE_STALE_OR_FUTURE",
    ],
    [
      "missing response binding",
      mintOutlayerEvidence(signer, io, { at: now, bindToPayload: false }),
      "RESPONSE_BINDING_MISSING",
    ],
    ["quote for another job id", wrongJob, "JOB_ID_MISMATCH"],
    ["truncated quote", mintOutlayerEvidence(signer, io, { at: now, truncateQuote: 700 }), "QUOTE_MALFORMED"],
  ];
  const records: Array<{ name: string; decision: string; reasonCode: string | null; reasons: string[] }> = [];
  for (const [name, ev, code] of cases) {
    const d = await verifyAttestation(ev, policy, ctx);
    expect(d.decision, name).toBe("reject");
    expect(d.proofLabel, name).toBe("none");
    expect(d.reasonCode, name).toBe(code);
    expect(d.reasons, name).toEqual([code]);
    records.push({ name, decision: d.decision, reasonCode: d.reasonCode ?? null, reasons: d.reasons });
  }
  expect(new Set(records.map((r) => r.reasonCode)).size).toBe(8);
  // extra defects found by the verifier itself: a quote signed by the wrong key, and a root that is not pinned
  const forgedQuote = mintOutlayerEvidence(signer, io, { at: now, quote: { badQuoteSignature: true } });
  expect((await verifyAttestation(forgedQuote, policy, ctx)).reasonCode).toBe("QUOTE_SIGNATURE_INVALID");
  const unpinned = createTdxQuoteVerifier({ production: [], fixture: [] });
  expect((await verifyAttestation(good, policy, { ...ctx, quoteVerifier: unpinned })).reasonCode).toBe(
    "QUOTE_ROOT_NOT_TRUSTED",
  );
  // a verifier that checks only the output hash must NOT be accepted: with the output right and other defects present
  // the full verifier still rejects (negative control for "checks only the output hash")
  const onlyOutput = (e: AttestationEvidence) => e.outputSha256 === io.outputSha256;
  const debugEv = cases[3]![1];
  expect(onlyOutput(debugEv)).toBe(true);
  expect((await verifyAttestation(debugEv, policy, ctx)).decision).toBe("reject");

  // direct quote parser check on real structure
  const q = mintTdxQuote();
  expect(verifyTdxQuote(q, { trustedRootSha256: [pki.rootSha256] }).ok).toBe(true);
  expect(verifyTdxQuote(q.subarray(0, q.length - 1), { trustedRootSha256: [pki.rootSha256] })).toMatchObject({
    ok: false,
    reason: "QUOTE_MALFORMED",
  });

  // (c) capsule status is never `verified` after any failure, and fixture evidence never reaches `verified`
  const dirs: string[] = [];
  const statuses: string[] = [];
  const texts: string[] = [];
  for (const ev of [good, ...cases.map((c) => c[1])]) {
    const d = tmp("v09c-");
    buildCapsule({ snapshotDir: SNAPSHOT, outDir: d });
    mkdirSync(join(d, "attestation"), { recursive: true });
    writeFileSync(join(d, "attestation", "evidence.json"), JSON.stringify(ev));
    const view = await loadCapsuleView(d, {
      research: "skip",
      wasm: "skip",
      policy,
      quoteVerifier,
      now,
      expectedJobId: "fixture-job-1",
    });
    dirs.push(d);
    statuses.push(view!.verification.outlayer.status);
    texts.push(JSON.stringify(view));
  }
  expect(statuses).not.toContain("verified");
  expect(statuses[0]).toBe("unverified"); // valid fixture evidence: fixture, not OutLayer-backed
  expect(statuses.slice(1).every((s) => s === "failed")).toBe(true);

  // (d)/(e) wording: no "OutLayer-verified" / "TEE-verified" / unqualified attested badge; the allowed wording is present
  const view0 = await loadCapsuleView(dirs[0]!, {
    research: "skip",
    wasm: "skip",
    policy,
    quoteVerifier,
    now,
    expectedJobId: "fixture-job-1",
  });
  const exportsText = ["THESIS.md", "DATA.md", "LIMITATIONS.md"].map((n) =>
    readFileSync(join(dirs[0]!, "exports", n), "utf8"),
  );
  const site = readFileSync(join(dirs[0]!, "exports", "site", "index.html"), "utf8");
  const scan = scanFixtureClaims([...texts, ...exportsText, site]);
  expect(scan.violations).toEqual([]);
  expect(view0!.verification.outlayer.detail).toContain("not OutLayer-backed");
  expect(texts.join("\n")).not.toMatch(/accuracy of the (third-party|source)|makes the .* data accurate/i);
  // negative control: a render that calls fixture evidence OutLayer-verified, TEE-verified or `attested` is caught
  for (const bad of [
    "Status: OutLayer-verified",
    "TEE-verified computation",
    "badge: attested",
    '<span class="badge">attested</span>',
  ])
    expect(scanFixtureClaims([bad]).violations.length, bad).toBeGreaterThan(0);
  expect(scanFixtureClaims(["attested (fixture trust root, not OutLayer-backed)"]).violations).toEqual([]);
  // a record that is fixture can never be upgraded: with no pinned production root the label can never be outlayer_attested
  const everything = await Promise.all(
    [good, forgedQuote, ...cases.map((c) => c[1])].map((e) => verifyAttestation(e, policy, ctx)),
  );
  expect(everything.some((d) => d.proofLabel === "outlayer_attested" || d.evidenceSource === "live")).toBe(
    false,
  );

  // LIVE half (--live): the real OutLayer testnet record under the shipped live policy and pinned Intel root
  let liveEvidence: Record<string, unknown> | null = null;
  if (process.env.NEARESIS_ACCEPT_LIVE === "1") {
    const live = liveOutlayerV10();
    const exp = {
      localWasmSha256: wasm,
      inputData: live.inputData,
      expectedOutputSha256: sha256Hex(live.outputText),
    };
    const real = verifyOutlayerLive(live.record, live.policy, exp);
    expect(real.reasons).toEqual([]);
    expect(real).toMatchObject({ decision: "accept", evidenceSource: "live", collateralChecked: false });
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
    const buf = Buffer.from(live.record.tdx_quote, "base64");
    buf[buf.length - 1] = 1;
    const liveCases: Array<[string, ReturnType<typeof verifyOutlayerLive>, string]> = [
      [
        "unpinned root",
        verifyOutlayerLive(live.record, { ...live.policy, quoteTrustRootSha256: [] }, exp),
        "QUOTE_ROOT_NOT_TRUSTED",
      ],
      [
        "unapproved measurement",
        verifyOutlayerLive(live.record, { ...live.policy, allowedMeasurements: [] }, exp),
        "MEASUREMENT_NOT_ALLOWED",
      ],
      [
        "unapproved wasm",
        verifyOutlayerLive(live.record, { ...live.policy, allowedWasmSha256: [] }, exp),
        "WASM_HASH_NOT_ALLOWED",
      ],
      [
        "output hash changed",
        verifyOutlayerLive({ ...live.record, output_hash: flip(live.record.output_hash) }, live.policy, exp),
        "RESPONSE_BINDING_MISMATCH",
      ],
      [
        "binding altered",
        verifyOutlayerLive({ ...live.record, task_id: live.record.task_id + 1 }, live.policy, exp),
        "RESPONSE_BINDING_MISMATCH",
      ],
      [
        "input changed",
        verifyOutlayerLive(live.record, live.policy, { ...exp, inputData: live.inputData + " " }),
        "INPUT_HASH_MISMATCH",
      ],
      [
        "expected output changed",
        verifyOutlayerLive(live.record, live.policy, {
          ...exp,
          expectedOutputSha256: flip(exp.expectedOutputSha256),
        }),
        "OUTPUT_HASH_MISMATCH",
      ],
      [
        "truncated quote",
        verifyOutlayerLive(
          { ...live.record, tdx_quote: live.record.tdx_quote.slice(0, 400) },
          live.policy,
          exp,
        ),
        "QUOTE_MALFORMED",
      ],
      [
        "trailing bytes in quote",
        verifyOutlayerLive({ ...live.record, tdx_quote: buf.toString("base64") }, live.policy, exp),
        "QUOTE_MALFORMED",
      ],
    ];
    for (const [name, d, code] of liveCases) {
      expect(d.decision, name).toBe("reject");
      expect(d.evidenceSource, name).toBe("fixture");
      expect(d.reasons, name).toContain(code);
    }
    // the fixture-minted evidence still never reaches live: the fixture trust root is not the pinned Intel root
    expect(everything.some((d) => d.evidenceSource === "live")).toBe(false);
    liveEvidence = {
      requestId: live.record.request_id,
      txHash: live.record.transaction_hash,
      mrTd: real.mrTd,
      pinnedRootSha256: live.policy.quoteTrustRootSha256[0],
      collateralChecked: false,
      rejectedDefects: liveCases.map(([n, , c]) => ({ name: n, reason: c })),
    };
  }

  observe({
    testId: "V09",
    observed: `Valid fixture evidence accepted as fixture_attested (evidenceSource fixture, MRTD ${MRTD_GOOD.slice(0, 12)}..). 8 mutated copies each rejected with a distinct single reason code [${records.map((r) => r.reasonCode).join(", ")}]; quote signed by the wrong key -> QUOTE_SIGNATURE_INVALID; unpinned root -> QUOTE_ROOT_NOT_TRUSTED. Capsule outlayer.status over 9 cases: ${statuses.join(",")} (never verified). Text scan of ${texts.length + exportsText.length + 1} outputs found 0 forbidden claims; negative-control wordings (4) all caught. ${liveEvidence ? "" : "Trust root is a locally minted test root, so "}${liveEvidence ? `LIVE half: the real OutLayer testnet record (request ${String(liveEvidence.requestId)}, tx ${String(liveEvidence.txHash)}) is accepted under the shipped live policy with the TDX quote chained to the pinned Intel SGX root (evidenceSource live, Intel PCS collateral NOT checked); 9 defect mutations of it are each rejected with the expected reason. The fixture-minted evidence above remains fixture and is never upgraded.` : "no result is OutLayer-backed (BLK-20261110-003)."}`,
    fixtureHash: wasm,
    evidence: {
      records,
      capsuleStatuses: statuses,
      evidenceSource: "fixture",
      collateralChecked: false,
      ...(liveEvidence ? { liveHalf: liveEvidence } : {}),
    },
  });
}, 300_000);
