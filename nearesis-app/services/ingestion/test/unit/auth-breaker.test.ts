import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { HttpClient, ALLOW_LOOPBACK } from "../../src/http/client.ts";
import type { AuthDegraded, FetchImpl } from "../../src/http/client.ts";
import { CredentialSource } from "../../src/http/credentials.ts";

const mk = (statusFor: (auth: string) => number) => {
  const seen: string[] = [];
  const fetchImpl: FetchImpl = async (_u, init) => {
    seen.push(init.headers["authorization"] ?? "");
    return {
      status: statusFor(init.headers["authorization"] ?? ""),
      headers: { forEach: () => undefined },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { seen, fetchImpl };
};
const req = {
  method: "GET" as const,
  url: "http://127.0.0.1:1/x",
  auth: { credential: "K", header: "authorization" },
};

describe("auth circuit breaker and credential rotation", () => {
  it("stops sending a rejected credential, probes once after the interval, resumes on rotation", async () => {
    const clock = new FakeClock();
    const creds = CredentialSource.fromMap({ K: "old-secret" });
    const m = mk((a) => (a === "Bearer new-secret" ? 200 : 401));
    const events: AuthDegraded[] = [];
    const c = new HttpClient({
      allow: [ALLOW_LOOPBACK],
      fetchImpl: m.fetchImpl,
      credentials: creds,
      clock,
      authCircuitMs: 1000,
      onAuthDegraded: (e) => events.push(e),
    });
    expect((await c.request(req)).status).toBe(401);
    for (let i = 0; i < 5; i++) await expect(c.request(req)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    expect(m.seen).toHaveLength(1);
    expect(c.authState("K", "127.0.0.1").state).toBe("degraded");
    expect(events).toHaveLength(1);
    clock.advance(1000);
    expect((await c.request(req)).status).toBe(401); // one probe
    await expect(c.request(req)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    expect(m.seen).toHaveLength(2);
    creds.rotate("K", "new-secret");
    expect((await c.request(req)).status).toBe(200);
    expect(m.seen.at(-1)).toBe("Bearer new-secret");
    expect(m.seen.filter((s) => s === "Bearer old-secret")).toHaveLength(2);
    expect(c.authState("K", "127.0.0.1").state).toBe("ok");
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
