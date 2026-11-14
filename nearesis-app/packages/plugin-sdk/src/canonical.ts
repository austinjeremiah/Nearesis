import { createHash } from "node:crypto";

/** Canonical JSON: recursively sorted object keys, no whitespace, undefined dropped. Signing input (ch.04). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

function canon(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canon(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canon(v);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
