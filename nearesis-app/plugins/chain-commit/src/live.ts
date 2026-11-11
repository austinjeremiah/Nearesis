/**
 * Live testnet helpers (ADR-20261111-005/-006). The key is read from the repo-root .env into this process only, passed to
 * the signer process on stdin, and never printed or returned.
 */
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { baseDecode } from "@near-js/utils";
import { ALLOWED_CONTRACT, ALLOWED_METHOD, SIGNER_ACCOUNT, type CommitTx } from "./policy.ts";
import { rpc, viewCommitment } from "./rpc.ts";
import { startSigner } from "./signer-host.ts";

export function signerPemFromEnv(envFile: string): string {
  const raw = /^NEAR_TESTNET_PRIVATE_KEY=(.*)$/m
    .exec(readFileSync(envFile, "utf8"))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!raw?.startsWith("ed25519:")) throw new Error("testnet key not configured");
  const seed = Buffer.from(baseDecode(raw.slice(8))).subarray(0, 32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

export const commitTx = (payloadHash: string): CommitTx => ({
  network: "near-testnet",
  contract: ALLOWED_CONTRACT,
  method: ALLOWED_METHOD,
  payloadHash,
  depositYocto: "0",
  gas: 30_000_000_000_000,
});

/** Sign through the signer process (policy-checked there) and broadcast. Returns the final outcome. */
export async function commitHashLive(envFile: string, payloadHash: string) {
  const signer = await startSigner(signerPemFromEnv(envFile));
  try {
    const url = `http://127.0.0.1:${signer.port}/sign`;
    const post = async (b: unknown) => fetch(url, { method: "POST", body: JSON.stringify(b) });
    const pk = (await (await post({ op: "pubkey" })).json()) as { publicKey: string; signerId: string };
    const k = await rpc<{ nonce: number; block_hash: string }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: pk.signerId,
      public_key: pk.publicKey,
    });
    const r = await post({
      tx: commitTx(payloadHash),
      nonce: String(BigInt(k.nonce) + 1n),
      blockHash: k.block_hash,
    });
    if (r.status !== 200) throw new Error(`signer refused: ${r.status}`);
    const { signedTx } = (await r.json()) as { signedTx: string };
    const out = await rpc<any>("broadcast_tx_commit", [signedTx]);
    return { txHash: out.transaction.hash as string, status: out.status, signer: SIGNER_ACCOUNT };
  } finally {
    signer.stop();
  }
}

/** Reads the transaction at FINAL finality and the contract view at FINAL; both must agree with the expected hash. */
export async function readbackLive(txHash: string, payloadHash: string) {
  const st = await rpc<any>("tx", {
    tx_hash: txHash,
    sender_account_id: SIGNER_ACCOUNT,
    wait_until: "FINAL",
  });
  const fc = st.transaction.actions[0].FunctionCall;
  const args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8")) as { hash?: string };
  const view = await viewCommitment(ALLOWED_CONTRACT, payloadHash);
  return {
    finality: st.final_execution_status as string,
    succeeded: "SuccessValue" in st.status,
    receiver: st.transaction.receiver_id as string,
    method: fc.method_name as string,
    deposit: fc.deposit as string,
    argsHash: args.hash ?? null,
    viewPresent: view.present,
    viewTimestampNs: view.timestampNs,
    viewBlockHash: view.blockHash,
    equal: args.hash === payloadHash && view.present,
  };
}
