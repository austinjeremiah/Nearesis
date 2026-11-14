import { createHash } from "node:crypto";

/** Canonical JSON (sorted keys, no whitespace). Byte-identical to @nearesis/workflow `pure.ts` (unit tested there). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));
