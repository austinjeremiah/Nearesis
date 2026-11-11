/**
 * ADR-20261111-006: create commit.majorlynx5104.testnet, fund it (<= 0.05 NEAR, to that subaccount only) and deploy the
 * hash-commitment contract, in ONE transaction: CreateAccount + Transfer + DeployContract. No AddKey, so the account has
 * no keys. The key is read from ../.env into this process only and never printed.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  actionCreators,
  baseDecode,
  createTransaction,
  encodeTransaction,
  KeyPair,
  KeyType,
  Signature,
  SignedTransaction,
} from "../../plugins/chain-commit/src/near-sdk.ts";
import { accessKeyNonceAndBlock, rpc } from "../../plugins/chain-commit/src/rpc.ts";

const SIGNER = "majorlynx5104.testnet";
const TARGET = "commit.majorlynx5104.testnet";
const FUND = 30_000_000_000_000_000_000_000n; // 0.03 NEAR
const EXPECT_WASM = "3e0f38459bd910e1ac69ccf5a7f02ff9ce90a2bd5bd73d5c5dcf1c6144fb22c3";

const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
const raw = /^NEAR_TESTNET_PRIVATE_KEY=(.*)$/m
  .exec(env)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, "");
if (!raw) throw new Error("key not configured");
const kp = KeyPair.fromString(raw as `ed25519:${string}`);
const wasm = readFileSync(new URL("../../plugins/chain-commit/contract/out/commit.wasm", import.meta.url));
if (createHash("sha256").update(wasm).digest("hex") !== EXPECT_WASM) throw new Error("wasm hash drift");

const { nonce, blockHash } = await accessKeyNonceAndBlock(SIGNER, kp.getPublicKey().toString());
const tx = createTransaction(
  SIGNER,
  kp.getPublicKey(),
  TARGET,
  nonce + 1n,
  [actionCreators.createAccount(), actionCreators.transfer(FUND), actionCreators.deployContract(wasm)],
  baseDecode(blockHash),
);
const bytes = encodeTransaction(tx);
const sig = kp.sign(createHash("sha256").update(bytes).digest());
const signed = new SignedTransaction({
  transaction: tx,
  signature: new Signature({ keyType: KeyType.ED25519, data: sig.signature }),
});
const out = await rpc<any>("broadcast_tx_commit", [Buffer.from(signed.encode()).toString("base64")]);
console.log(
  JSON.stringify({
    txHash: out.transaction.hash,
    status: out.status,
    final: out.final_execution_status,
  }).slice(0, 600),
);
