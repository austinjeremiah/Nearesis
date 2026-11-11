/** Keys whose values must never reach journals, audit rows or tool results (ch.04 step 6, ch.12). */
export const SECRET_KEY = /secret|token|authorization|password|jwt|api[_-]?key/i;
export const REDACTED = "[REDACTED]";

/** Zero-width and bidi-control characters an attacker inserts to split a credential past a scanner. */
const INVISIBLE = new RegExp("[\\u200B-\\u200F\\u2060\\u2066-\\u2069\\uFEFF]", "g");
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
/** base64 of a JWT starts with the encoding of `eyJ` (aligned at the start of the value). */
const JWT_B64 = /ZXlK[A-Za-z0-9+/_-]{20,}={0,2}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Best-effort scrub of bearer tokens / JWT-shaped strings (plain, base64-wrapped, or split by invisible characters). */
export function redactString(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(JWT_B64, REDACTED);
}

/** True when any string inside `value` (keys included) carries a credential shape. Never returns the match. */
export function containsSecretShape(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === "string") return redactString(value) !== value.replace(INVISIBLE, "");
  if (Array.isArray(value)) return value.some((v) => containsSecretShape(v, depth + 1));
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => containsSecretShape(k, depth + 1) || containsSecretShape(v, depth + 1),
    );
  return false;
}

/**
 * Scrub credential shapes from every string inside a value that is NOT keyed by a secret-ish name (model output, tool
 * input echoes). Unlike `redact`, keys are kept, so the structure a schema validated stays valid.
 */
export function scrubSecretShapes<T>(value: T, depth = 0): T {
  if (depth > 64) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecretShapes(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = scrubSecretShapes(v, depth + 1);
    return out as T;
  }
  return value;
}
