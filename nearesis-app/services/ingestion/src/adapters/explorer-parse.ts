import { z } from "zod";
import { sha256Hex } from "../hash.ts";

const Amount = z.string().regex(/^\d+$/, "smallest-unit integer string");
const UsdLike = z.union([z.string(), z.number()]).nullable();

export const ExplorerTx = z.looseObject({
  originAsset: z.string().min(1),
  destinationAsset: z.string().min(1),
  depositAddress: z.string().min(1),
  depositMemo: z.string().nullable(),
  depositAddressAndMemo: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  createdAtTimestamp: z.number(),
  intentHashes: z.string().nullable(),
  amountInFormatted: z.string(),
  amountOutFormatted: z.string(),
  appFees: z.array(z.looseObject({ recipient: z.string(), fee: z.number() })),
  nearTxHashes: z.array(z.string()),
  originChainTxHashes: z.array(z.string()),
  destinationChainTxHashes: z.array(z.string()),
  amountIn: Amount,
  amountInUsd: UsdLike,
  amountOut: Amount,
  amountOutUsd: UsdLike,
  refundTo: z.string().nullable(),
  refundFeeFormatted: z.string().nullable(),
  depositType: z.string(),
  recipientType: z.string(),
  refundType: z.string(),
  recipient: z.string().optional(),
  status: z.string().optional(),
  referral: z.string().nullable().optional(),
  senders: z.array(z.string()).optional(),
  refundReason: z.string().nullable().optional(),
  refundFee: z.string().nullable().optional(),
});
export type ExplorerTx = z.infer<typeof ExplorerTx>;

export const swapKeyOf = (t: { depositAddress: string; depositMemo: string | null }): string =>
  `${t.depositAddress}|${t.depositMemo ?? ""}`;

export const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REFUNDED"]);
export const KNOWN_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "INCOMPLETE_DEPOSIT",
  "PENDING_DEPOSIT",
  "PROCESSING",
  "REFUNDED",
]);
export const normStatus = (s: string | undefined | null): string =>
  s && KNOWN_STATUSES.has(s) ? s : "UNKNOWN";

export interface ExplorerCursor {
  lastDepositAddress: string;
  lastDepositMemo: string;
}

export type ParsedPage =
  | { ok: true; items: ExplorerTx[]; checksum: "none" | "verified" }
  | { ok: false; reasonCode: "BAD_JSON" | "BAD_SCHEMA" | "NOT_ARRAY" | "CHECKSUM_MISMATCH"; detail: string };

/**
 * Parses and validates one Explorer page. The provider documents no body checksum; if a gateway supplies
 * `x-body-sha256` (or `digest: sha-256=<hex>`) it is verified, and a mismatch quarantines the page.
 */
export function parseExplorerPage(body: Uint8Array, headers: Record<string, string> = {}): ParsedPage {
  const claimed = headers["x-body-sha256"] ?? /^sha-256=([0-9a-f]{64})$/i.exec(headers["digest"] ?? "")?.[1];
  let checksum: "none" | "verified" = "none";
  if (claimed) {
    if (claimed.toLowerCase() !== sha256Hex(body))
      return { ok: false, reasonCode: "CHECKSUM_MISMATCH", detail: "body sha256 differs from header" };
    checksum = "verified";
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { ok: false, reasonCode: "BAD_JSON", detail: "body is not valid JSON" };
  }
  if (!Array.isArray(json)) return { ok: false, reasonCode: "NOT_ARRAY", detail: "response is not an array" };
  const items: ExplorerTx[] = [];
  for (const [i, raw] of json.entries()) {
    const r = ExplorerTx.safeParse(raw);
    if (!r.success) {
      const p = r.error.issues[0];
      return { ok: false, reasonCode: "BAD_SCHEMA", detail: `item ${i}: ${p?.path.join(".")} ${p?.message}` };
    }
    items.push(r.data);
  }
  return { ok: true, items, checksum };
}

/** Structural fingerprint of the response schema (field names + JSON types of the first item, sorted). */
export function explorerSchemaFingerprint(items: unknown[]): string {
  const first = (items[0] ?? {}) as Record<string, unknown>;
  const shape = Object.keys(first)
    .sort()
    .map((k) => `${k}:${first[k] === null ? "null" : Array.isArray(first[k]) ? "array" : typeof first[k]}`);
  return sha256Hex(shape.join("|"));
}

export interface StoredSwap {
  swapKey: string;
  status: string;
  createdAt: string;
  amountIn: string;
  amountOut: string;
  rawObjectHash: string;
  record: ExplorerTx;
}

export type ReconcileAction = "insert" | "update" | "noop" | "stale" | "conflict";

/** Idempotent merge policy for repeated / overlapping deliveries (D01, fx.snapshot.p02-duplicates). */
export function reconcileSwap(existing: StoredSwap | undefined, incoming: StoredSwap): ReconcileAction {
  if (!existing) return "insert";
  if (existing.rawObjectHash === incoming.rawObjectHash) return "noop";
  const eTerm = TERMINAL_STATUSES.has(existing.status);
  const iTerm = TERMINAL_STATUSES.has(incoming.status);
  if (eTerm && !iTerm) return "stale"; // a late re-delivery of an older, non-final state must not regress a final one
  if (
    eTerm &&
    iTerm &&
    (existing.status !== incoming.status ||
      existing.amountIn !== incoming.amountIn ||
      existing.amountOut !== incoming.amountOut)
  )
    return "conflict";
  if (existing.createdAt !== incoming.createdAt) return "conflict";
  const same =
    existing.status === incoming.status &&
    JSON.stringify(existing.record) === JSON.stringify(incoming.record);
  return same ? "noop" : "update";
}
