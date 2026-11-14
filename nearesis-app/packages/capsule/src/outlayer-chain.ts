import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OutlayerAttestationRecord } from "./attest-outlayer.ts";

/**
 * NEAR testnet client for the OutLayer job path (ch.14, ch.20). Testnet only: the RPC and the coordinator API are fixed to
 * testnet hosts. The signing key is read from the repo-root `.env` into this process, used to sign one transaction
 * (hand-rolled borsh, ed25519 from node:crypto) and never printed, logged or returned. The class implements
 * `OutlayerChain`, which tests replace with an injected fake.
 */
export const OUTLAYER_CONTRACT = "outlayer.testnet";
export const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
export const OUTLAYER_ATTESTATION_API = "https://testnet-api.outlayer.ai";
export const BUILD_TARGET = "wasm32-wasip2";

export interface ResourceLimits {
  max_instructions: number;
  max_memory_mb: number;
  max_execution_seconds: number;
}

export interface ExecutionRequest {
  wasmUrl: string;
  wasmSha256: string;
  inputData: string;
  limits: ResourceLimits;
}

export interface ExecutionReceipt {
  requestId: number;
  txHash: string;
  /** Deposit attached, yoctoNEAR (the contract's own estimate for these limits and this input size). */
  depositYocto: string;
  /** Gas plus protocol fees burnt by the transaction and its receipts, yoctoNEAR. */
  tokensBurntYocto: string;
  chargedYocto: string | null;
  refundedYocto: string | null;
  instructionsUsed: number | null;
  /** How the worker reported the output: valid JSON (`Json`) or text (`Text`). It decides how the output hash is formed. */
  outputKind: "json" | "text" | null;
  signer: string;
}

export interface OutlayerChain {
  /** Reads the contract's required payment (view `estimate_execution_cost`) for these limits and input size. */
  estimateDeposit(limits: ResourceLimits, inputLen: number): Promise<string>;
  /** True when the pinned WASM is served at `url` and hashes to `sha256` (fetched and hashed here, never trusted). */
  wasmAvailable(url: string, sha256: string): Promise<boolean>;
  /** Signs and broadcasts `request_execution` with exactly `depositYocto` attached. Throws on a failed outcome. */
  requestExecution(r: ExecutionRequest, depositYocto: string): Promise<ExecutionReceipt>;
  /** Polls the coordinator until the attestation for `requestId` exists, or `timeoutMs` passes (returns null). */
  fetchAttestation(requestId: number, timeoutMs: number): Promise<OutlayerAttestationRecord | null>;
  /** Reads an already-executed request_execution transaction (used to verify a job without paying for another). */
  fetchReceipt(txHash: string): Promise<ExecutionReceipt>;
  balanceYocto(): Promise<string>;
  /** Current protocol gas price, yoctoNEAR per gas unit (RPC `gas_price`). Used to size a hold for the gas of one job. */
  gasPriceYocto?(): Promise<string>;
  readonly account: string;
}

const rpcCall = async <T>(method: string, params: unknown): Promise<T> => {
  const r = await fetch(TESTNET_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const lead = s.length - s.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}
export function base58Encode(b: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u128 = (v: bigint) => Buffer.concat([u64(v & 0xffffffffffffffffn), u64(v >> 64n)]);
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

/** Borsh `Transaction` with one FunctionCall action. Exported for tests (byte layout is checked against the node's decoder). */
export function encodeFunctionCallTx(t: {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  method: string;
  args: Buffer;
  gas: bigint;
  deposit: bigint;
}): Buffer {
  return Buffer.concat([
    str(t.signerId),
    Buffer.from([0]),
    Buffer.from(t.publicKey),
    u64(t.nonce),
    str(t.receiverId),
    Buffer.from(t.blockHash),
    u32(1),
    Buffer.from([2]),
    str(t.method),
    u32(t.args.length),
    t.args,
    u64(t.gas),
    u128(t.deposit),
  ]);
}

export function keyFromEnvFile(envFile: string): { seed: Buffer; publicKey: Buffer } {
  const raw = /^NEAR_TESTNET_PRIVATE_KEY=(.*)$/m
    .exec(readFileSync(envFile, "utf8"))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!raw?.startsWith("ed25519:")) throw new Error("testnet key not configured");
  const seed = base58Decode(raw.slice(8)).subarray(0, 32);
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return { seed, publicKey: spki.subarray(spki.length - 32) };
}

const sha256Raw = (b: Uint8Array) => createHash("sha256").update(b).digest();

export class TestnetOutlayerChain implements OutlayerChain {
  readonly account: string;
  readonly #seed: Buffer;
  readonly #pub: Buffer;
  constructor(o: { account: string; envFile: string; contract?: string }) {
    this.account = o.account;
    const k = keyFromEnvFile(o.envFile);
    this.#seed = k.seed;
    this.#pub = k.publicKey;
    this.contract = o.contract ?? OUTLAYER_CONTRACT;
  }
  readonly contract: string;

  async #view(method: string, args: unknown): Promise<string> {
    const r = await rpcCall<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: this.contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (r.error || !r.result) throw new Error(`view ${method} failed: ${String(r.error).slice(0, 200)}`);
    return Buffer.from(r.result).toString("utf8");
  }

  async estimateDeposit(limits: ResourceLimits, inputLen: number): Promise<string> {
    const v = JSON.parse(
      await this.#view("estimate_execution_cost", { resource_limits: limits, input_len: inputLen }),
    ) as string;
    if (!/^\d+$/.test(v)) throw new Error("estimate_execution_cost returned a non-numeric value");
    return v;
  }

  async wasmAvailable(url: string, sha256: string): Promise<boolean> {
    if (!url.startsWith("https://")) return false;
    const r = await fetch(url);
    if (!r.ok) return false;
    return (
      createHash("sha256")
        .update(Buffer.from(await r.arrayBuffer()))
        .digest("hex") === sha256
    );
  }

  async gasPriceYocto(): Promise<string> {
    const r = await rpcCall<{ gas_price: string }>("gas_price", [null]);
    if (!/^\d+$/.test(r.gas_price)) throw new Error("gas_price returned a non-numeric value");
    return r.gas_price;
  }

  async balanceYocto(): Promise<string> {
    const a = await rpcCall<{ amount: string }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: this.account,
    });
    return a.amount;
  }

  async requestExecution(r: ExecutionRequest, depositYocto: string): Promise<ExecutionReceipt> {
    const pkStr = `ed25519:${base58Encode(this.#pub)}`;
    const key = await rpcCall<{ nonce: number; block_hash: string }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: this.account,
      public_key: pkStr,
    });
    const args = Buffer.from(
      JSON.stringify({
        source: { WasmUrl: { url: r.wasmUrl, hash: r.wasmSha256, build_target: BUILD_TARGET } },
        resource_limits: r.limits,
        input_data: r.inputData,
      }),
    );
    const tx = encodeFunctionCallTx({
      signerId: this.account,
      publicKey: this.#pub,
      nonce: BigInt(key.nonce) + 1n,
      receiverId: this.contract,
      blockHash: base58Decode(key.block_hash),
      method: "request_execution",
      args,
      gas: 300_000_000_000_000n,
      deposit: BigInt(depositYocto),
    });
    const priv = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), this.#seed]),
      format: "der",
      type: "pkcs8",
    });
    const signature = sign(null, sha256Raw(tx), priv);
    const signed = Buffer.concat([tx, Buffer.from([0]), signature]);
    // The hash is known before sending, so a slow or interrupted RPC answer never loses a transaction that was paid for.
    const txHash = base58Encode(sha256Raw(tx));
    let out: TxOutcome;
    try {
      out = await rpcCall<TxOutcome>("broadcast_tx_commit", [signed.toString("base64")]);
    } catch (e) {
      // broadcast_tx_commit gives up after about ten seconds while the receipts are still running (cause PENDING), and a
      // network error leaves the outcome unknown. Either way the transaction may be on chain: read its final outcome by
      // hash for up to three minutes before reporting a failure, and name the hash in that failure.
      const deadline = Date.now() + 180_000;
      let last: unknown = e;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4_000));
        try {
          return await this.fetchReceipt(txHash);
        } catch (e2) {
          last = e2;
        }
      }
      const err = new Error(
        `transaction ${txHash} was broadcast but its final outcome could not be read: ${String((last as Error)?.message ?? last).slice(0, 300)}`,
      ) as Error & { txHash: string };
      err.txHash = txHash;
      throw err;
    }
    return parseOutcome(out, this.account, depositYocto);
  }

  async fetchReceipt(txHash: string): Promise<ExecutionReceipt> {
    const out = await rpcCall<
      TxOutcome & {
        transaction: {
          hash: string;
          actions: Array<{ FunctionCall?: { deposit: string; method_name: string } }>;
        };
      }
    >("tx", { tx_hash: txHash, sender_account_id: this.account, wait_until: "FINAL" });
    const fc = out.transaction.actions[0]?.FunctionCall;
    if (fc?.method_name !== "request_execution")
      throw new Error("transaction is not a request_execution call");
    return parseOutcome(out, this.account, fc.deposit);
  }

  async fetchAttestation(requestId: number, timeoutMs: number): Promise<OutlayerAttestationRecord | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await fetch(`${OUTLAYER_ATTESTATION_API}/attestations/by-request/${requestId}`);
      if (r.ok) {
        const j = (await r.json()) as OutlayerAttestationRecord;
        if (j && typeof j.tdx_quote === "string" && j.request_id === requestId) return j;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

interface TxOutcome {
  status: Record<string, unknown>;
  transaction: { hash: string };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  receipts_outcome: Array<{
    outcome: { tokens_burnt: string; logs: string[]; status: Record<string, unknown> };
  }>;
}

/** Extracts the request id, the provider's charge and the fees from the outcome. Fails closed when the call failed. */
export function parseOutcome(out: TxOutcome, signer: string, depositYocto: string): ExecutionReceipt {
  const failed = (s: Record<string, unknown>) => "Failure" in s;
  if (failed(out.status) || out.receipts_outcome.some((r) => failed(r.outcome.status)))
    throw new Error(`request_execution failed: ${JSON.stringify(out.status).slice(0, 400)}`);
  let burnt = BigInt(out.transaction_outcome.outcome.tokens_burnt);
  let requestId: number | null = null;
  let charged: string | null = null;
  let refunded: string | null = null;
  let instructions: number | null = null;
  let outputKind: "json" | "text" | null = null;
  for (const r of out.receipts_outcome) {
    burnt += BigInt(r.outcome.tokens_burnt);
    for (const l of r.outcome.logs) {
      const m = /Output: (Json|Text)\(\d+ bytes\)/.exec(l);
      if (m) outputKind = m[1] === "Json" ? "json" : "text";
      if (!l.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(l.slice(11)) as {
        event?: string;
        data?: Array<Record<string, unknown>>;
      };
      const d = ev.data?.[0];
      if (!d) continue;
      if (ev.event === "execution_requested") {
        const rd = JSON.parse(String(d.request_data)) as { request_id?: number };
        if (typeof rd.request_id === "number") requestId = rd.request_id;
      }
      if (ev.event === "execution_completed") {
        charged = typeof d.payment_charged === "string" ? d.payment_charged : null;
        refunded = typeof d.payment_refunded === "string" ? d.payment_refunded : null;
        const ru = d.resources_used as { instructions?: number } | undefined;
        instructions = typeof ru?.instructions === "number" ? ru.instructions : null;
      }
    }
  }
  if (requestId === null) throw new Error("no execution_requested event in the transaction outcome");
  return {
    requestId,
    txHash: out.transaction.hash,
    depositYocto,
    tokensBurntYocto: burnt.toString(),
    chargedYocto: charged,
    refundedYocto: refunded,
    instructionsUsed: instructions,
    outputKind,
    signer,
  };
}
