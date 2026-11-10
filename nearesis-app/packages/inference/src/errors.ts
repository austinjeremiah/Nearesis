export type InferenceErrorCode =
  "UPSTREAM_DEGRADED" | "SCHEMA_INVALID" | "BUDGET_EXCEEDED" | "PUBLICATION_REFUSED";

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;
  readonly httpStatus?: number;
  constructor(code: InferenceErrorCode, message: string, httpStatus?: number) {
    super(`${code}: ${message}`);
    this.name = "InferenceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Remove anything that looks like a bearer credential from a message. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  for (const s of secrets) {
    if (s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  return out;
}
