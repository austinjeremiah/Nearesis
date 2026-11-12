import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * 1Click signed-quote verification (final_master_prompt §8).
 *
 * Documented mechanism (checked 2026-11-13):
 *  - https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature
 *    "signed message = base58(sha256(json-stable-stringify({ ...quoteRequest, ...quote, timestamp })))", dry quotes included.
 *  - The provider's official SDK `@defuse-protocol/one-click-sdk-typescript@0.1.26` (`verifyQuoteSignature`) fixes the exact field
 *    selection (`buildSignedQuoteRequest` / `buildSignedQuote`), the algorithm (ed25519, tweetnacl detached) and pins the manager
 *    key below as `ONE_CLICK_MANAGER_PUB_KEY`. The docs page itself names no key; the key's provenance is that SDK constant.
 *
 * The OpenAPI field description says the signature is "confirming the quote for the specific deposit address". A dry quote has no
 * deposit address, so a verified dry signature proves the provider signed this exact indicative quote, nothing about execution.
 */
export const ONE_CLICK_MANAGER_PUB_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
export const QUOTE_SIGNATURE_DOC =
  "https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature";
export const QUOTE_SIGNATURE_KEY_SOURCE =
  "@defuse-protocol/one-click-sdk-typescript@0.1.26 ONE_CLICK_MANAGER_PUB_KEY";

export type SignatureStatus = "verified" | "invalid" | "signature_unverifiable";
export interface SignatureResult {
  status: SignatureStatus;
  reason: string;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) {
    if (c === "1") zeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** json-stable-stringify semantics: object keys sorted, `undefined` members dropped, JSON.stringify for scalars. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

type Obj = Record<string, unknown>;
const truthy = (v: unknown): unknown => (v ? v : undefined);

/** Field selection copied from the official SDK's buildSignedQuoteRequest (dry and non-dry share it). */
function signedRequest(r: Obj): Obj {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: truthy(r.quoteWaitingTimeMs),
    referral: truthy(r.referral),
    virtualChainRecipient: truthy(r.virtualChainRecipient),
    virtualChainRefundRecipient: truthy(r.virtualChainRefundRecipient),
    customRecipientMsg: truthy(r.customRecipientMsg),
  };
}

/** Field selection copied from the official SDK's buildSignedQuote. */
function signedQuote(q: Obj, dry: boolean): Obj {
  const base = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  if (dry) return base;
  return {
    ...base,
    depositAddress: truthy(q.depositAddress),
    depositMemo: truthy(q.depositMemo),
    deadline: truthy(q.deadline),
    timeWhenInactive: truthy(q.timeWhenInactive),
    timeEstimate: truthy(q.timeEstimate),
    refundFee: truthy(q.refundFee),
    withdrawFee: truthy(q.withdrawFee),
  };
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const stripPrefix = (s: string): string => (s.startsWith("ed25519:") ? s.slice(8) : s);

/** The message the provider signs: base58(sha256(stable JSON)). Exposed so tests can build signed fixtures. */
export function quoteSigningMessage(response: Obj): string {
  const req = (response.quoteRequest ?? {}) as Obj;
  const quote = (response.quote ?? {}) as Obj;
  const dataString = stableStringify({
    ...signedRequest(req),
    ...signedQuote(quote, req.dry === true),
    timestamp: response.timestamp,
  });
  return base58Encode(createHash("sha256").update(dataString, "utf8").digest());
}

/** Never throws: any structural problem is `signature_unverifiable` with the reason, a failed check is `invalid`. */
export function verifyQuoteSignature(
  response: unknown,
  managerPublicKey: string = ONE_CLICK_MANAGER_PUB_KEY,
): SignatureResult {
  if (!response || typeof response !== "object")
    return { status: "signature_unverifiable", reason: "response is not an object" };
  const r = response as Obj;
  if (typeof r.signature !== "string" || r.signature === "")
    return { status: "signature_unverifiable", reason: "response carries no signature" };
  if (typeof r.timestamp !== "string" || r.timestamp === "")
    return {
      status: "signature_unverifiable",
      reason: "response carries no timestamp (part of the signed message)",
    };
  if (!r.quoteRequest || typeof r.quoteRequest !== "object" || !r.quote || typeof r.quote !== "object")
    return {
      status: "signature_unverifiable",
      reason: "quoteRequest/quote missing (signed message cannot be rebuilt)",
    };
  try {
    const sig = base58Decode(stripPrefix(r.signature));
    const key = base58Decode(stripPrefix(managerPublicKey));
    if (sig.length !== 64 || key.length !== 32)
      return {
        status: "signature_unverifiable",
        reason: "signature or key is not a 64/32-byte ed25519 value",
      };
    const pub = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    const ok = verify(null, Buffer.from(quoteSigningMessage(r), "utf8"), pub, Buffer.from(sig));
    return ok
      ? {
          status: "verified",
          reason: `ed25519 over base58(sha256(stable json)); key: ${QUOTE_SIGNATURE_KEY_SOURCE}`,
        }
      : { status: "invalid", reason: "signature does not verify against the pinned provider key" };
  } catch (e) {
    return {
      status: "signature_unverifiable",
      reason: `malformed signature material: ${(e as Error).message}`,
    };
  }
}
