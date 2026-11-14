/**
 * Deterministic ensure-build for the OutLayer verifier component (services/outlayer-verifier/out is gitignored build
 * output). Tests and CI call `ensureWasm()` / `pnpm exec tsx scripts/tests/ensure-wasm.ts`; it runs the reproducible
 * `build.sh` (pinned Rust 1.99.1, wasm32-wasip2, path-remapped, SOURCE_DATE_EPOCH=0) only when the artifact is missing or
 * its SHA-256 is not one the attestation policy pins, then verifies the result is a pinned hash. A hash that is not
 * pinned after a build is an error: the policy is never loosened to match.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFIER = join(APP, "services", "outlayer-verifier");
export const WASM_PATH = join(VERIFIER, "out", "nearesis-verifier.wasm");
const POLICY = join(VERIFIER, "policy", "attestation-policy.json");
const TOOLCHAIN = "1.99.1";
const LOCK = join(VERIFIER, "out", ".ensure-wasm.lock");

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const pinned = (): string[] =>
  (JSON.parse(readFileSync(POLICY, "utf8")) as { allowedWasmSha256: string[] }).allowedWasmSha256;
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function toolchainBin(): string | null {
  const root = join(homedir(), ".rustup", "toolchains");
  if (!existsSync(root)) return null;
  const t = readdirSync(root).find((n) => n.startsWith(`${TOOLCHAIN}-`));
  return t ? join(root, t, "bin") : null;
}

function build(): void {
  let bin = toolchainBin();
  if (!bin) {
    const r = spawnSync(
      "rustup",
      ["toolchain", "install", TOOLCHAIN, "--profile", "minimal", "--target", "wasm32-wasip2"],
      { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
    );
    if (r.status !== 0) throw new Error(`ensure-wasm: cannot install Rust ${TOOLCHAIN} (needs rustup)`);
    bin = toolchainBin();
  }
  if (!bin) throw new Error(`ensure-wasm: Rust ${TOOLCHAIN} not found under ~/.rustup/toolchains`);
  const r = spawnSync("sh", ["build.sh"], {
    cwd: VERIFIER,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    timeout: 280_000,
  });
  if (r.status !== 0) throw new Error(`ensure-wasm: build.sh failed: ${(r.stderr ?? "").slice(-400)}`);
}

/** Returns the path of a pinned-hash verifier artifact, building it reproducibly when absent. */
export function ensureWasm(): string {
  const ok = (): boolean => existsSync(WASM_PATH) && pinned().includes(sha(WASM_PATH));
  if (ok()) return WASM_PATH;
  mkdirSync(join(VERIFIER, "out"), { recursive: true });
  const deadline = Date.now() + 290_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      // another process is building; steal a lock older than the build timeout
      if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 300_000)
        rmSync(LOCK, { recursive: true });
      if (ok()) return WASM_PATH;
      if (Date.now() > deadline) throw new Error("ensure-wasm: timed out waiting for another build");
      sleep(500);
    }
  }
  try {
    if (!ok()) build();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
  if (!ok())
    throw new Error(
      `ensure-wasm: built artifact sha256 ${existsSync(WASM_PATH) ? sha(WASM_PATH) : "(missing)"} is not pinned in attestation-policy.json`,
    );
  return WASM_PATH;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`${sha(ensureWasm())}  ${WASM_PATH}`);
}
