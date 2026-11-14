/** A21 verdict mapping for live failures (16a section 7 clarification ii). */
export type A21Outcome = "BLOCKED_DEPENDENCY" | "FAIL" | "RETHROW";

export function a21OutcomeForError(code: string): { outcome: A21Outcome; reason: string } {
  switch (code) {
    case "UPSTREAM_AUTH":
      return { outcome: "BLOCKED_DEPENDENCY", reason: "OpenRouter rejected the key (HTTP 401/403)" };
    case "UPSTREAM_BILLING":
      return { outcome: "BLOCKED_DEPENDENCY", reason: "OpenRouter account has no credits (HTTP 402)" };
    case "NOT_BYOK_SHARED_CAPACITY":
      return {
        outcome: "FAIL",
        reason: "response served outside the owner's BYOK credits (is_byok !== true); output discarded",
      };
    default:
      return { outcome: "RETHROW", reason: code };
  }
}
