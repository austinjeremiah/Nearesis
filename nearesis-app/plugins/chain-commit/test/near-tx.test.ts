import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignedTransaction } from "@near-js/transactions";
import { assembleSigned, buildCommitTransaction } from "../src/near-tx.ts";
import { ALLOWED_CONTRACT, ALLOWED_METHOD, type CommitTx } from "../src/policy.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x === 0) s = "1" + s;
    else break;
  }
  return s;
}

const good: CommitTx = {
  network: "near-testnet",
  contract: ALLOWED_CONTRACT,
  method: ALLOWED_METHOD,
  payloadHash: "ab".repeat(32),
  depositYocto: "0",
  gas: 30_000_000_000_000,
};

describe("real NEAR transaction encoding", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const opts = {
    signerId: "majorlynx5104.testnet",
    publicKey: `ed25519:${base58(raw)}`,
    nonce: 7n,
    blockHash: new Uint8Array(32).fill(1),
  };

  it("encodes one FunctionCall with hash-only args and a verifiable ed25519 signature", () => {
    const u = buildCommitTransaction(good, opts);
    expect(u.digest).toEqual(createHash("sha256").update(u.bytes).digest());
    const sig = sign(null, u.digest, privateKey);
    const decoded = SignedTransaction.decode(Buffer.from(assembleSigned(u, sig)));
    const t = decoded.transaction;
    expect(t.receiverId).toBe(ALLOWED_CONTRACT);
    expect(t.actions).toHaveLength(1);
    const fc = t.actions[0]!.functionCall!;
    expect(fc.methodName).toBe(ALLOWED_METHOD);
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual({ hash: good.payloadHash });
    expect(fc.deposit).toBe(0n);
    expect(verify(null, u.digest, publicKey, Buffer.from(decoded.signature.ed25519Signature!.data))).toBe(
      true,
    );
  });

  it("refuses everything outside the policy before encoding", () => {
    for (const bad of [
      { ...good, network: "near-mainnet" },
      { ...good, contract: "other.testnet" },
      { ...good, method: "ft_transfer" },
      { ...good, payloadHash: "not a hash" },
      { ...good, depositYocto: "1000000000000000000000" },
      { ...good, gas: 300_000_000_000_000 },
    ])
      expect(() => buildCommitTransaction(bad, opts)).toThrow();
  });
});
