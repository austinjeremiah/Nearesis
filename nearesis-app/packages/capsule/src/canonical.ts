import { createHash } from "node:crypto";

/**
 * Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, `JSON.stringify` string escaping.
 * Only integers, strings, booleans, null, arrays and plain objects are allowed, so the output never depends on float
 * formatting (the capsule carries every measured value as a decimal string).
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`canonicalJson: non-integer number ${String(v)}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof v}`);
}

export function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

export const canonicalSha256 = (v: unknown): string => sha256Hex(canonicalJson(v));
