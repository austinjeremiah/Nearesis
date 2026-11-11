import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Runs the real commit.wasm under a JS model of the NEAR host functions it imports (state, registers, panics). */
const wasmPath = new URL("../contract/out/commit.wasm", import.meta.url).pathname;
execFileSync(new URL("../contract/build.sh", import.meta.url).pathname, { stdio: "ignore" });
const module = new WebAssembly.Module(readFileSync(wasmPath));
const OWNER = "majorlynx5104.testnet";

function host(state: Map<string, Buffer>) {
  return (method: string, input: string, predecessor: string, ts = 1234n) => {
    const regs = new Map<bigint, Buffer>();
    let mem!: WebAssembly.Memory;
    let ret: Buffer | null = null;
    const m = () => Buffer.from(mem.buffer);
    const imports = {
      env: {
        input: (r: bigint) => regs.set(r, Buffer.from(input)),
        register_len: (r: bigint) => BigInt(regs.get(r)?.length ?? -1),
        read_register: (r: bigint, p: bigint) => regs.get(r)!.copy(m(), Number(p)),
        predecessor_account_id: (r: bigint) => regs.set(r, Buffer.from(predecessor)),
        block_timestamp: () => ts,
        storage_write: (kl: bigint, kp: bigint, vl: bigint, vp: bigint, _r: bigint) => {
          state.set(
            m()
              .subarray(Number(kp), Number(kp + kl))
              .toString("hex"),
            Buffer.from(m().subarray(Number(vp), Number(vp + vl))),
          );
          return 0n;
        },
        storage_read: (kl: bigint, kp: bigint, r: bigint) => {
          const v = state.get(
            m()
              .subarray(Number(kp), Number(kp + kl))
              .toString("hex"),
          );
          if (!v) return 0n;
          regs.set(r, v);
          return 1n;
        },
        storage_has_key: (kl: bigint, kp: bigint) =>
          state.has(
            m()
              .subarray(Number(kp), Number(kp + kl))
              .toString("hex"),
          )
            ? 1n
            : 0n,
        value_return: (l: bigint, p: bigint) => {
          ret = Buffer.from(m().subarray(Number(p), Number(p + l)));
        },
        panic: () => {
          throw new Error("PANIC");
        },
      },
    };
    const inst = new WebAssembly.Instance(module, imports);
    mem = inst.exports.memory as WebAssembly.Memory;
    (inst.exports[method] as () => void)();
    return ret as Buffer | null;
  };
}

describe("commit.wasm", () => {
  const h = "ab".repeat(32);
  const arg = (x: string) => JSON.stringify({ hash: x });
  it("owner commits once, anyone reads, first commit wins", () => {
    const state = new Map<string, Buffer>();
    const call = host(state);
    expect(call("get_commitment", arg(h), "anyone.testnet")?.toString()).toBe("null");
    call("commit_hash", arg(h), OWNER, 99n);
    expect(call("get_commitment", arg(h), "anyone.testnet")?.readBigUInt64LE()).toBe(99n);
    expect(() => call("commit_hash", arg(h), OWNER)).toThrow("PANIC");
    expect(state.size).toBe(1);
  });
  it("refuses other callers and malformed input", () => {
    const state = new Map<string, Buffer>();
    const call = host(state);
    expect(() => call("commit_hash", arg(h), "evil.testnet")).toThrow("PANIC");
    for (const bad of [
      arg("AB".repeat(32)),
      arg("ab".repeat(31)),
      `{"hash":"${h}","x":1}`,
      `{"HASH":"${h}"}`,
      "",
      arg("zz".repeat(32)),
    ])
      expect(() => call("commit_hash", bad, OWNER)).toThrow();
    expect(state.size).toBe(0);
  });
});
