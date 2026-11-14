/**
 * Real NEAR transaction encoding for the hash-only commitment (replaces the JSON fixture format).
 * Uses the maintained `@near-js/transactions` borsh schema. The ONLY action ever built is one FunctionCall to the
 * allowlisted contract and method, with the payload hash as JSON args, after `checkPolicy` passes. There is no code path
 * for Transfer, AddKey, DeployContract, Stake or any other action.
 * Signing happens in the signer process (it alone holds the key); this module only builds the unsigned bytes, the digest
 * the signer signs (sha256 of the borsh bytes) and assembles the SignedTransaction.
 */
import { createHash } from "node:crypto";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  SignedTransaction,
  Signature,
} from "@near-js/transactions";
import { PublicKey, KeyType } from "@near-js/crypto";
import { checkPolicy, type CommitTx } from "./policy.ts";

export interface UnsignedCommit {
  bytes: Uint8Array;
  digest: Uint8Array;
  transaction: ReturnType<typeof createTransaction>;
}

export function buildCommitTransaction(
  tx: CommitTx,
  o: { signerId: string; publicKey: string; nonce: bigint; blockHash: Uint8Array },
): UnsignedCommit {
  const violation = checkPolicy(tx);
  if (violation) throw new Error(violation);
  const args = Buffer.from(JSON.stringify({ hash: tx.payloadHash }));
  const action = actionCreators.functionCall(tx.method, args, BigInt(tx.gas), BigInt(tx.depositYocto));
  const transaction = createTransaction(
    o.signerId,
    PublicKey.from(o.publicKey),
    tx.contract,
    o.nonce,
    [action],
    o.blockHash,
  );
  const bytes = encodeTransaction(transaction);
  return { bytes, digest: createHash("sha256").update(bytes).digest(), transaction };
}

export function assembleSigned(u: UnsignedCommit, signature: Uint8Array): Uint8Array {
  const signed = new SignedTransaction({
    transaction: u.transaction,
    signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
  });
  return signed.encode();
}
