import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient, type AllowRule } from "../../src/http/client.ts";
import { OneClickQuoteSampler } from "../../src/adapters/oneclick.ts";
import { assertQuoteOnlyWire } from "../../src/http/quote-wire-guard.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { systemClock } from "../../src/clock.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A real TCP server standing in for the provider: whatever reaches it reached the wire. */
const seen: Array<{ method: string; path: string; body: string }> = [];
let server: ReturnType<typeof createServer>;
let base = "";
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

// Deliberately over-permissive configuration: every method on every path of the loopback host is allowlisted.
const WIDE: AllowRule = {
  host: "loopback",
  endpoints: [
    { method: "GET", path: "*" },
    { method: "POST", path: "*" },
  ],
};
const wide = (): HttpClient => new HttpClient({ allow: [WIDE] });
const dryBody = { dry: true, originAsset: "a", destinationAsset: "b", amount: "1" };

describe("quote-only wire guard (HttpClient, misconfigured callers)", () => {
  const forbidden: Array<[string, "GET" | "POST", string, unknown]> = [
    ["deposit submit", "POST", "/v0/deposit/submit", { txHash: "0x1", depositAddress: "0x2" }],
    ["generate intent", "POST", "/v0/generate-intent", { type: "swap_transfer", signerId: "x.near" }],
    ["submit intent (signing)", "POST", "/v0/submit-intent", { type: "swap_transfer", signedData: {} }],
    ["create order", "POST", "/v0/orders", { confidentiality: "basic" }],
    ["cancel order", "POST", "/v0/orders/abc/cancel", {}],
    ["auth", "POST", "/v0/auth/authenticate", {}],
    ["refresh token", "POST", "/v0/auth/refresh", {}],
    ["balances", "GET", "/v0/account/balances", undefined],
    ["status", "GET", "/v0/status?depositAddress=0x1", undefined],
    ["order lookup", "GET", "/v0/orders/abc", undefined],
    ["unknown v0 path", "POST", "/v0/transfer", { dry: true }],
    ["quote path with trailing slash", "POST", "/v0/quote/", dryBody],
    ["quote path upper-case", "POST", "/V0/QUOTE", dryBody],
    ["quote subpath", "POST", "/v0/quote/submit", dryBody],
    ["dot-segment escape to deposit", "POST", "/v0/tokens/../deposit/submit", dryBody],
    ["quote with dry:false (a live quote/swap request)", "POST", "/v0/quote", { ...dryBody, dry: false }],
    ["quote without dry", "POST", "/v0/quote", { originAsset: "a", amount: "1" }],
    ["quote with dry as string", "POST", "/v0/quote", { ...dryBody, dry: "true" }],
    ["quote with dry as 1", "POST", "/v0/quote", { ...dryBody, dry: 1 }],
    ["quote with empty body", "POST", "/v0/quote", undefined],
    ["quote with array body", "POST", "/v0/quote", [{ dry: true }]],
    ["tokens with POST", "POST", "/v0/tokens", dryBody],
    ["tokens GET with body", "GET", "/v0/tokens", { dry: true }],
  ];
  for (const [name, method, path, body] of forbidden)
    it(`refuses ${name} before any byte is sent`, async () => {
      const before = seen.length;
      await expect(
        wide().request({ method, url: `${base}${path}`, ...(body !== undefined ? { body } : {}) }),
      ).rejects.toMatchObject({ code: "QUOTE_ONLY_WIRE_VIOLATION" });
      expect(seen.length).toBe(before);
    });

  it("refuses non-GET/POST verbs and 1Click-host requests, even when the allowlist says yes", () => {
    expect(() =>
      assertQuoteOnlyWire("PUT", "https://1click.chaindefuser.com/v0/quote", '{"dry":true}'),
    ).toThrow();
    expect(() =>
      assertQuoteOnlyWire("DELETE", "https://1click.chaindefuser.com/v0/tokens", undefined),
    ).toThrow();
    expect(() => assertQuoteOnlyWire("GET", "https://1click.chaindefuser.com/anything", undefined)).toThrow();
    expect(() =>
      assertQuoteOnlyWire("GET", "https://1CLICK.chaindefuser.com/v0/status", undefined),
    ).toThrow();
    expect(() =>
      assertQuoteOnlyWire("POST", "https://u:p@1click.chaindefuser.com/v0/quote", '{"dry":true}'),
    ).toThrow();
  });

  it("lets the two permitted requests through to the wire", async () => {
    const before = seen.length;
    await wide().request({ method: "GET", url: `${base}/v0/tokens` });
    await wide().request({ method: "POST", url: `${base}/v0/quote`, body: dryBody });
    expect(seen.slice(before).map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /v0/tokens",
      "POST /v0/quote",
    ]);
    expect(JSON.parse(seen.at(-1)!.body).dry).toBe(true);
    expect(() =>
      assertQuoteOnlyWire("POST", "https://1click.chaindefuser.com/v0/quote", '{"dry":true}'),
    ).not.toThrow();
    expect(() =>
      assertQuoteOnlyWire("GET", "https://api.coingecko.com/api/v3/ping", undefined),
    ).not.toThrow();
  });

  it("the sampler cannot be made to send a live quote or another endpoint over a wide-open transport", async () => {
    const archive = new RawArchive(new FsObjectStore(join(mkdtempSync(join(tmpdir(), "qw-")), "raw")), null);
    const s = new OneClickQuoteSampler({ http: wide(), archive, clock: systemClock, baseUrl: base });
    const before = seen.length;
    await expect(s.call("POST", "/v0/deposit/submit", { dry: true })).rejects.toMatchObject({
      code: "ENDPOINT_NOT_ALLOWLISTED",
    });
    await expect(s.call("POST", "/v0/quote", { dry: false })).rejects.toMatchObject({ code: "DRY_REQUIRED" });
    expect(seen.length).toBe(before);
  });
});

describe("confidentiality casing follows the official API (lowercase enum)", () => {
  it("builds public (omitted), basic and advanced lower-case", () => {
    const archive = new RawArchive(new FsObjectStore(join(mkdtempSync(join(tmpdir(), "qw-")), "raw")), null);
    const s = new OneClickQuoteSampler({ http: wide(), archive, clock: systemClock });
    const slot = {
      routeId: "r",
      originAsset: "a",
      destinationAsset: "b",
      amountBaseUnits: "1",
      scheduledBucketUTC: "2026-11-11T00:00:00Z",
      attemptNo: 1,
      recipient: "x",
      refundTo: "y",
    };
    expect("confidentiality" in s.buildBody({ ...slot, privacyMode: "public" })).toBe(false);
    expect(s.buildBody({ ...slot, privacyMode: "basic" }).confidentiality).toBe("basic");
    expect(s.buildBody({ ...slot, privacyMode: "advanced" }).confidentiality).toBe("advanced");
  });
});
