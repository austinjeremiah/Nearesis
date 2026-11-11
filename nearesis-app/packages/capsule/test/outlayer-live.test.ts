import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifyOutlayerLive, type OutlayerAttestationRecord } from "../src/attest-outlayer.ts";

const dir = new URL("./fixtures/outlayer-live/", import.meta.url);
const rec = JSON.parse(readFileSync(new URL("attestation.json", dir), "utf8")) as OutlayerAttestationRecord;
const inputData = readFileSync(new URL("input_data.txt", dir), "utf8");
const root = createHash("sha256")
  .update(readFileSync(new URL("Intel_SGX_RootCA.cer", dir)))
  .digest("hex");
const policyFile = JSON.parse(
  readFileSync(
    new URL("../../../services/outlayer-verifier/policy/outlayer-live-policy.json", import.meta.url),
    "utf8",
  ),
) as { allowedWasmSha256: string[]; allowedMeasurements: string[]; quoteTrustRootSha256: string[] };
const expect_ = {
  localWasmSha256: "1034c63ed6fd761fa13977544dec59bddcd30009bb1feb363a3d169ddaee901c",
  inputData,
  expectedOutputSha256: "f630f7eef421951291e2de76846a25e6bb581ec578923c60789b461fbfee2ff9",
};

// Recorded from OutLayer testnet request 21428 (tx 3qqeGLV3DrpEbx5bRMr4PpVAtr5twAEe1bDY1WLkRDVt), real TDX quote.
it("accepts the real recorded OutLayer testnet attestation under the shipped policy", () => {
  expect(policyFile.quoteTrustRootSha256).toEqual([root]);
  const d = verifyOutlayerLive(rec, policyFile, expect_);
  expect(d.reasons).toEqual([]);
  expect(d.decision).toBe("accept");
  expect(d.collateralChecked).toBe(false);
});

it("fails closed on every defect", () => {
  const p = policyFile;
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
  expect(verifyOutlayerLive(rec, { ...p, quoteTrustRootSha256: [] }, expect_).reasons).toContain(
    "QUOTE_ROOT_NOT_TRUSTED",
  );
  expect(verifyOutlayerLive(rec, { ...p, allowedMeasurements: [] }, expect_).reasons).toContain(
    "MEASUREMENT_NOT_ALLOWED",
  );
  expect(verifyOutlayerLive(rec, { ...p, allowedWasmSha256: [] }, expect_).reasons).toContain(
    "WASM_HASH_NOT_ALLOWED",
  );
  expect(verifyOutlayerLive({ ...rec, output_hash: flip(rec.output_hash) }, p, expect_).decision).toBe(
    "reject",
  );
  expect(verifyOutlayerLive({ ...rec, task_id: rec.task_id + 1 }, p, expect_).reasons).toContain(
    "RESPONSE_BINDING_MISMATCH",
  );
  expect(verifyOutlayerLive(rec, p, { ...expect_, inputData: inputData + " " }).reasons).toContain(
    "INPUT_HASH_MISMATCH",
  );
  expect(
    verifyOutlayerLive(rec, p, { ...expect_, expectedOutputSha256: flip(expect_.expectedOutputSha256) })
      .reasons,
  ).toContain("OUTPUT_HASH_MISMATCH");
  expect(verifyOutlayerLive({ ...rec, tdx_quote: rec.tdx_quote.slice(0, 400) }, p, expect_).decision).toBe(
    "reject",
  );
  // non-zero bytes after the signature data are refused (only zero padding is tolerated)
  const buf = Buffer.from(rec.tdx_quote, "base64");
  buf[buf.length - 1] = 1;
  expect(verifyOutlayerLive({ ...rec, tdx_quote: buf.toString("base64") }, p, expect_).reasons).toContain(
    "QUOTE_MALFORMED",
  );
});
