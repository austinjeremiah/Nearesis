/**
 * Chain commitment policy (ch.12): testnet only, one allowlisted contract and method, hash-only payload, fee ceilings.
 * The same policy is evaluated in three places: the capability input schema (before any approval is consumed), the
 * plugin handler, and the signer process (the last line: it refuses to sign anything outside it, whoever asks).
 * There is no transfer, swap or withdrawal path: the allowlist names exactly one method and a deny pattern backs it.
 */
export const NETWORK = "near-testnet" as const;
export const ALLOWED_CONTRACT = "commit.nearesis.testnet";
export const ALLOWED_METHOD = "commit_hash";
/** Deposit is strictly below 1e21 yoctoNEAR (0.001 NEAR); gas is at most 30 Tgas. */
export const MAX_DEPOSIT_DIGITS = 21;
export const MAX_GAS = 30_000_000_000_000;
export const FORBIDDEN_METHOD = /transfer|swap|withdraw|send|approve|stake|delete_account|add_key|deploy/i;

export interface CommitTx {
  network: string;
  contract: string;
  method: string;
  payloadHash: string;
  depositYocto: string;
  gas: number;
}

export type PolicyViolation =
  | "NETWORK_NOT_ALLOWED"
  | "CONTRACT_NOT_ALLOWED"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_NOT_A_HASH"
  | "DEPOSIT_ABOVE_CEILING"
  | "GAS_ABOVE_CEILING";

/** Returns the first violation, or null when the call is inside the policy. Pure and total on any input. */
export function checkPolicy(t: unknown): PolicyViolation | null {
  const x = (t ?? {}) as Record<string, unknown>;
  if (x.network !== NETWORK) return "NETWORK_NOT_ALLOWED";
  if (x.contract !== ALLOWED_CONTRACT) return "CONTRACT_NOT_ALLOWED";
  if (typeof x.method !== "string" || x.method !== ALLOWED_METHOD || FORBIDDEN_METHOD.test(x.method))
    return "METHOD_NOT_ALLOWED";
  if (typeof x.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(x.payloadHash)) return "PAYLOAD_NOT_A_HASH";
  if (
    typeof x.depositYocto !== "string" ||
    !new RegExp(`^(0|[1-9][0-9]{0,${MAX_DEPOSIT_DIGITS - 1}})$`).test(x.depositYocto)
  )
    return "DEPOSIT_ABOVE_CEILING";
  if (typeof x.gas !== "number" || !Number.isInteger(x.gas) || x.gas < 1 || x.gas > MAX_GAS)
    return "GAS_ABOVE_CEILING";
  return null;
}

/** JSON Schema for the capability input: the gateway rejects violations before an approval is consumed. */
export const COMMIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    network: { const: NETWORK },
    contract: { enum: [ALLOWED_CONTRACT] },
    method: { enum: [ALLOWED_METHOD] },
    payloadHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    depositYocto: { type: "string", pattern: `^(0|[1-9][0-9]{0,${MAX_DEPOSIT_DIGITS - 1}})$` },
    gas: { type: "integer", minimum: 1, maximum: MAX_GAS },
  },
  required: ["network", "contract", "method", "payloadHash", "depositYocto", "gas"],
  additionalProperties: false,
} as const;
