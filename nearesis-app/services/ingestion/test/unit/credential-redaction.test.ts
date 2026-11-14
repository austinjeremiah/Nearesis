import { describe, expect, it } from "vitest";
import { CredentialSource } from "../../src/http/credentials.ts";

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

describe("CredentialSource.redactBytes", () => {
  const secret = "cnry_Zk3qLm9XpR2vTt81";
  const creds = CredentialSource.fromMap({
    INTENTS_EXPLORER_JWT: secret,
    SOME_PLAIN_NAME: "do-not-mask-this-value",
  });

  it("removes the secret and its encoded forms from an echoed header body", () => {
    const body = JSON.stringify({
      echo: { authorization: `Bearer ${secret}` },
      b64: Buffer.from(secret).toString("base64"),
      b64u: Buffer.from(secret).toString("base64url"),
      hex: Buffer.from(secret).toString("hex"),
      url: encodeURIComponent(`${secret}`),
    });
    const r = creds.redactBytes(new TextEncoder().encode(body));
    expect(r.hits).toBe(5);
    expect(text(r.bytes)).not.toContain(secret);
    expect(text(r.bytes)).not.toContain(Buffer.from(secret).toString("base64"));
    expect(text(r.bytes)).toContain("Bearer [REDACTED]");
  });

  it("returns the same bytes when nothing matches and ignores non-credential names", () => {
    const body = new TextEncoder().encode('{"note":"do-not-mask-this-value"}');
    const r = creds.redactBytes(body);
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(body);
  });

  it("is a no-op in replay mode", () => {
    const body = new TextEncoder().encode(secret);
    expect(CredentialSource.denyAll().redactBytes(body).hits).toBe(0);
  });
});
