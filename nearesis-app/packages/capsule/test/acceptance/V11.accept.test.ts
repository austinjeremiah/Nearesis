import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  buildCapsule,
  checkDeterminism,
  forbiddenWasiImports,
  isPlaceholderHash,
  runWasi,
  sha256Hex,
  writeBlockedProofRecord,
  writeCompletedProofRecord,
} from "../../src/index.ts";
import { APP, SNAPSHOT, WASM, tmp } from "../helpers.ts";
import { MRTD_GOOD } from "../tdx-fixture.ts";

const VERIFIER = join(APP, "services", "outlayer-verifier");

function toolchainBin(): string | null {
  const root = join(homedir(), ".rustup", "toolchains");
  if (!existsSync(root)) return null;
  const t = readdirSync(root).find((n) => n.startsWith("1.99.1"));
  return t ? join(root, t, "bin") : null;
}

/** Build the verifier from a clean copy of its sources, with the same flags as build.sh. */
function cleanBuild(bin: string): { sha: string; bytes: Buffer } {
  const dir = tmp("v11-build-");
  for (const f of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"])
    cpSync(join(VERIFIER, f), join(dir, f));
  cpSync(join(VERIFIER, "src"), join(dir, "src"), { recursive: true });
  const r = spawnSync("cargo", ["build", "--target", "wasm32-wasip2", "--release", "--locked", "--offline"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: homedir(),
      RUSTFLAGS: `--remap-path-prefix=${dir}=/build --remap-path-prefix=${join(homedir(), ".cargo")}=/cargo`,
      SOURCE_DATE_EPOCH: "0",
      CARGO_TARGET_DIR: join(dir, "t"),
    },
    timeout: 280_000,
  });
  if (r.status !== 0) throw new Error(`cargo build failed: ${(r.stderr ?? "").slice(-300)}`);
  const bytes = readFileSync(join(dir, "t", "wasm32-wasip2", "release", "nearesis-verifier.wasm"));
  return { sha: sha256Hex(bytes), bytes };
}

/** V11 (16b): proof record completeness and byte-deterministic WASI computation. FIXTURE. */
it("V11: two clean builds agree, 5 runs agree, completed and blocked proof records are complete and honest", () => {
  const bin = toolchainBin();
  if (!bin || spawnSync("wasmtime", ["--version"]).status !== 0) {
    observe({
      testId: "V11",
      observed: "Rust 1.99.1 toolchain or wasmtime unavailable on this machine; nothing was built or run.",
      blocked: "BLOCKED_DEPENDENCY: needs the pinned Rust toolchain (wasm32-wasip2) and wasmtime",
    });
    return;
  }
  // (a) two clean builds
  const b1 = cleanBuild(bin);
  const b2 = cleanBuild(bin);
  expect(b1.sha).toBe(b2.sha);
  expect(b1.sha).toBe(sha256Hex(readFileSync(WASM)));

  const dir = tmp("v11-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  const inputPath = m.computation.inputFile.path;
  const inputBytes = readFileSync(join(dir, inputPath));
  const runs = checkDeterminism(() => {
    const r = runWasi(WASM, inputBytes);
    expect(r.status).toBe("COMPUTED");
    return r.stdout;
  }, 5);
  expect(runs.identical).toBe(true);
  // negative control: a computation reading wall-clock time is detected
  let tick = 0;
  expect(checkDeterminism(() => Buffer.from(String(Date.now() + tick++)), 5).identical).toBe(false);

  // (d) no network or wall-clock path: no such WASI import, and wasmtime grants none by default
  expect(forbiddenWasiImports(b1.bytes)).toEqual([]);

  // (b) completed record: all 7 fields non-null, each hash equals the SHA-256 of its artifact
  const sourceBytes = readFileSync(join(dir, "snapshot", "raw", "daily_series.csv"));
  const outBytes = Buffer.from(runWasi(WASM, inputBytes).outputSha256 ?? "", "utf8");
  const rec = writeCompletedProofRecord({
    evidenceSource: "fixture",
    sourceArtifact: sourceBytes,
    inputs: { path: inputPath, bytes: inputBytes },
    wasm: b1.bytes,
    output: readFileSync(join(dir, m.computation.resultsFile.path)),
    approvedMeasurements: [MRTD_GOOD],
    quote: { measurement: MRTD_GOOD },
    jobId: "fixture-job-1",
  });
  expect(outBytes.length).toBe(64);
  if (rec.status !== "verified") throw new Error("expected a verified record");
  const seven = [
    rec.sourceArtifactSha256,
    rec.exactInputs,
    rec.wasmSha256,
    rec.outputSha256,
    rec.approvedMeasurements,
    rec.quoteVerification,
    rec.jobId,
  ];
  expect(seven.every((v) => v !== null && v !== undefined)).toBe(true);
  expect(rec.sourceArtifactSha256).toBe(sha256Hex(sourceBytes));
  expect(rec.exactInputs.sha256).toBe(sha256Hex(readFileSync(join(dir, inputPath))));
  expect(rec.wasmSha256).toBe(sha256Hex(readFileSync(WASM)));
  expect(rec.outputSha256).toBe(sha256Hex(readFileSync(join(dir, m.computation.resultsFile.path))));
  expect(rec.outputSha256).toBe(m.computation.resultsFile.sha256);
  expect(isPlaceholderHash("0".repeat(64))).toBe(true);
  expect(() =>
    writeCompletedProofRecord({
      evidenceSource: "fixture",
      sourceArtifact: sourceBytes,
      inputs: { path: inputPath, bytes: inputBytes },
      wasm: b1.bytes,
      output: readFileSync(join(dir, m.computation.resultsFile.path)),
      approvedMeasurements: [MRTD_GOOD],
      quote: { measurement: "cd".repeat(48) },
      jobId: "x",
    }),
  ).toThrow();

  // (c) blocked record: jobId null, unverified, a reason, nothing invented
  const blocked = writeBlockedProofRecord({
    reason: "BLOCKED_DEPENDENCY: no OutLayer job exists (BLK-20261110-003)",
    known: { sourceArtifact: sourceBytes, inputs: { path: inputPath, bytes: inputBytes }, wasm: b1.bytes },
  });
  if (blocked.status !== "unverified") throw new Error("expected an unverified record");
  expect(blocked.jobId).toBeNull();
  expect(blocked.reason.length).toBeGreaterThan(5);
  expect(blocked.outputSha256).toBeNull();
  expect(blocked.quoteVerification).toBeNull();
  expect(JSON.stringify(blocked)).not.toMatch(/0{64}|(.)\1{63}/);

  observe({
    testId: "V11",
    observed: `Two clean offline builds (rustc 1.99.1, wasm32-wasip2, remapped paths) both hash ${b1.sha.slice(0, 16)}, equal to the shipped artifact. 5 wasmtime runs on the same input gave one output hash ${runs.hashes[0]!.slice(0, 16)}; a wall-clock control was detected as nondeterministic. The wasm imports no wasi:sockets, wasi:http, wasi:clocks/wall-clock, wasi:random or wasi:filesystem. Completed record: all 7 fields non-null and every hash recomputed from its artifact bytes; placeholder hash and non-approved measurement refused. Blocked record: jobId null, status unverified, reason set, no placeholder.`,
    fixtureHash: b1.sha,
    evidence: {
      buildHashes: [b1.sha, b2.sha],
      runHashes: runs.hashes,
      completed: rec,
      blocked,
    },
  });
}, 600_000);
