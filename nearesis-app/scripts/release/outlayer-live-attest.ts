/**
 * Verifies a REAL OutLayer testnet attestation (fetched from the public coordinator) with the repository's TDX quote
 * verifier, pinned to the Intel SGX Root CA, and recomputes OutLayer's task-hash binding. Prints only public values.
 * Usage: tsx scripts/release/outlayer-live-attest.ts <attestation.json> <intel-root.cer> <input.json> <out.json>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyTdxQuote } from "../../packages/capsule/src/tdx.ts";

const [attFile, rootFile, inputFile, outFile] = process.argv.slice(2) as [string, string, string, string];
const att = JSON.parse(readFileSync(attFile, "utf8")) as Record<string, string | number | null>;
const rootSha = createHash("sha256").update(readFileSync(rootFile)).digest("hex");
const q = verifyTdxQuote(att.tdx_quote as string, { trustedRootSha256: [rootSha] });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const i64 = (v: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};
const u64 = (v: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const s = (v: unknown) => Buffer.from(String(v));
const base = [
  s(att.task_type),
  i64(att.task_id as number),
  s(att.build_target),
  s(att.wasm_hash),
  s(att.input_hash),
  s(att.output_hash),
  u64(att.block_height as number),
];
const v1 = [
  ...base,
  s(att.caller_account_id),
  i64(att.timestamp as number),
  ...(att.attached_usd ? [s(att.attached_usd)] : []),
];
const taskHash = { preV1: sha(Buffer.concat(base)), v1: sha(Buffer.concat(v1)) };

const reportData = q.ok || q.fields ? (q.ok ? q.fields : q.fields)!.reportData : "";
const result = {
  quoteVerified: q.ok,
  quoteReason: q.ok ? null : q.reason,
  quoteDetail: q.ok ? null : q.detail,
  collateralChecked: q.collateralChecked,
  pinnedRootSha256: rootSha,
  chainRootSha256: q.ok ? q.fields.rootSha256 : (q.fields?.rootSha256 ?? null),
  mrTd: q.ok ? q.fields.mrTd : (q.fields?.mrTd ?? null),
  mrTdMatchesWorkerMeasurement: (q.ok ? q.fields.mrTd : q.fields?.mrTd) === att.worker_measurement,
  debug: q.ok ? q.fields.debug : (q.fields?.debug ?? null),
  reportDataPrefix: reportData.slice(0, 64),
  taskHashCandidates: taskHash,
  bindingOk: reportData.slice(0, 64) === taskHash.preV1 || reportData.slice(0, 64) === taskHash.v1,
  wasmHashMatchesLocal: att.executed_wasm_sha256 === att.wasm_hash,
  inputFileSha256: sha(readFileSync(inputFile)),
  attestationInputHash: att.input_hash,
  outputHash: att.output_hash,
  outputFileSha256: sha(readFileSync(outFile)),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(attFile.replace(/\.json$/, ".verification.json"), JSON.stringify(result, null, 2) + "\n");
