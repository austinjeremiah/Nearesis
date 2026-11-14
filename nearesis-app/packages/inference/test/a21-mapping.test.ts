import { describe, expect, it } from "vitest";
import { a21OutcomeForError } from "./support/a21-mapping.ts";

describe("A21 failure to verdict mapping", () => {
  it("non-BYOK is FAIL; missing key, 401/403 and 402 are BLOCKED_DEPENDENCY", () => {
    expect(a21OutcomeForError("NOT_BYOK_SHARED_CAPACITY").outcome).toBe("FAIL");
    expect(a21OutcomeForError("UPSTREAM_AUTH").outcome).toBe("BLOCKED_DEPENDENCY");
    expect(a21OutcomeForError("UPSTREAM_BILLING").outcome).toBe("BLOCKED_DEPENDENCY");
    expect(a21OutcomeForError("SCHEMA_INVALID").outcome).toBe("RETHROW");
  });
});
