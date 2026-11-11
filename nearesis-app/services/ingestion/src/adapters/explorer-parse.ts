import { z } from "zod";
import { parseStrictJson } from "@nearesis/strict-json";
import { sha256Hex } from "../hash.ts";

/** Frozen parser bounds for one provider page (SEC16). A page above any bound is quarantined, never partially promoted. */
export const PAGE_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxRows: 10_000,
  maxDepth: 12,
  maxNodes: 2_000_000,
} as const;

/** Empty string = provider reports the amount as unknown (REFUNDED swaps); anything else must be a digits-only integer string. */
const Amount = z.union([z.literal(""), z.string().regex(/^\d+$/, "smallest-unit integer string")]);
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

/** "" (unknown) -> null; never coerced to "0". */
export const amountOrNull = (v: string): string | null => (v === "" ? null : v);

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
  | { ok: true; items: ExplorerTx[]; checksum: "none" | "verified"; warnings: string[] }
  | {
      ok: false;
      reasonCode: "BAD_JSON" | "BAD_SCHEMA" | "NOT_ARRAY" | "CHECKSUM_MISMATCH" | "PAGE_LIMIT";
      detail: string;
    };

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
  // Bounds first, on the raw bytes: size, depth, row count, duplicate keys, pollution keys, invalid UTF-8, huge numbers.
  const strict = parseStrictJson(body, {
    maxBytes: PAGE_LIMITS.maxBytes,
    maxDepth: PAGE_LIMITS.maxDepth,
    maxNodes: PAGE_LIMITS.maxNodes,
    maxArrayItems: PAGE_LIMITS.maxRows,
  });
  if (!strict.ok) {
    const limit = ["TOO_LARGE", "TOO_DEEP", "TOO_MANY_NODES", "TOO_MANY_ITEMS"].includes(strict.code);
    return {
      ok: false,
      reasonCode: limit ? "PAGE_LIMIT" : "BAD_JSON",
      detail: limit ? `${strict.code}: ${strict.detail}` : `body is not valid JSON (${strict.code})`,
    };
  }
  const json: unknown = strict.value;
  if (!Array.isArray(json)) return { ok: false, reasonCode: "NOT_ARRAY", detail: "response is not an array" };
  const items: ExplorerTx[] = [];
  const warnings: string[] = [];
  for (const [i, raw] of json.entries()) {
    const r = ExplorerTx.safeParse(raw);
    if (!r.success) {
      const p = r.error.issues[0];
      return { ok: false, reasonCode: "BAD_SCHEMA", detail: `item ${i}: ${p?.path.join(".")} ${p?.message}` };
    }
    const t = r.data;
    const missing = (
      [
        ["amountIn", t.amountIn],
        ["amountOut", t.amountOut],
        ["amountInUsd", t.amountInUsd],
        ["amountOutUsd", t.amountOutUsd],
      ] as const
    )
      .filter(([, v]) => v === "")
      .map(([k]) => k);
    if (missing.length) warnings.push(`item ${i}: missing_amount ${missing.join(",")}`);
    items.push(t);
  }
  return { ok: true, items, checksum, warnings };
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
  amountIn: string | null; // null = provider sent "" (unknown), never 0
  amountOut: string | null;
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
