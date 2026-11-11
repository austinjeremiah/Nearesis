import { describe, expect, it } from "vitest";
import { REDACTED, containsSecretShape, redact, redactString, scrubSecretShapes } from "../src/index.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXJ0bmVyIn0.c2lnbmF0dXJlLXNpZw";

describe("credential redaction", () => {
  it("scrubs plain, bearer, base64-wrapped and invisible-split JWTs", () => {
    expect(redactString(`x ${JWT} y`)).toBe(`x ${REDACTED} y`);
    expect(redactString(`Authorization: Bearer ${JWT}`)).not.toContain("eyJ");
    expect(redactString(Buffer.from(JWT).toString("base64"))).toBe(REDACTED);
    expect(redactString(`${JWT.slice(0, 10)}\u200B${JWT.slice(10)}`)).toBe(REDACTED);
  });
  it("redact() scrubs string values as well as secret-named keys", () => {
    const out = redact({ token: "abc", note: `see ${JWT}`, nested: [{ n: JWT }] }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("eyJ");
    expect(out.token).toBe(REDACTED);
  });
  it("containsSecretShape detects without returning the match; scrub keeps structure", () => {
    expect(containsSecretShape({ a: [{ b: `u?t=${JWT}` }] })).toBe(true);
    expect(containsSecretShape({ a: "ordinary text, 12345" })).toBe(false);
    expect(scrubSecretShapes({ token: JWT, list: [JWT] })).toEqual({ token: REDACTED, list: [REDACTED] });
  });
});
