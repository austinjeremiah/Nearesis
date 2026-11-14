import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { sha256Hex } from "./canonical.ts";
import { findWasmtime, scrubbedEnv } from "./verify.ts";

/**
 * Local WASI runner for the verifier component. wasmtime grants no sockets, no filesystem and no environment by
 * default, so the computation has no network path (V11(d)); this module adds none.
 */
export interface WasiRun {
  ran: boolean;
  reason?: string;
  stdout: Buffer;
  status: string | null;
  inputSha256: string | null;
  outputSha256: string | null;
}

export function runWasi(wasmPath: string, input: Buffer): WasiRun {
  const wt = findWasmtime();
  if (!wt || !existsSync(wasmPath))
    return {
      ran: false,
      reason: "wasmtime or the wasm artifact is unavailable",
      stdout: Buffer.alloc(0),
      status: null,
      inputSha256: null,
      outputSha256: null,
    };
  const r = spawnSync(wt, ["run", "-W", "fuel=1000000000", wasmPath], {
    input,
    env: scrubbedEnv(),
    timeout: 120_000,
    maxBuffer: 16_000_000,
  });
  const stdout = r.stdout ?? Buffer.alloc(0);
  try {
    const o = JSON.parse(stdout.toString("utf8")) as {
      status?: string;
      input_sha256?: string;
      results_sha256?: string;
    };
    return {
      ran: true,
      stdout,
      status: o.status ?? null,
      inputSha256: o.input_sha256 ?? null,
      outputSha256: o.results_sha256 ?? null,
    };
  } catch {
    return {
      ran: true,
      reason: "unparseable output",
      stdout,
      status: null,
      inputSha256: null,
      outputSha256: null,
    };
  }
}

/** Wasm component imports that would give a computation wall-clock time, randomness or a network path. */
export function forbiddenWasiImports(wasm: Buffer): string[] {
  const text = wasm.toString("latin1");
  return ["wasi:sockets", "wasi:http", "wasi:clocks/wall-clock", "wasi:random", "wasi:filesystem"].filter(
    (p) => text.includes(p),
  );
}

/** Runs `run` n times; identical iff every output hashes the same. A nondeterministic computation reports false. */
export function checkDeterminism(run: () => Buffer, n: number): { identical: boolean; hashes: string[] } {
  const hashes = Array.from({ length: n }, () => sha256Hex(run()));
  return { identical: new Set(hashes).size === 1, hashes };
}

export const wasmBytes = (p: string): Buffer => readFileSync(p);
