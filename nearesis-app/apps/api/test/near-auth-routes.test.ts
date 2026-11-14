import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { NearAuthService, nep413Hash } from "@nearesis/kernel";
import { buildApp } from "../src/app.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

type Rpc = { result?: unknown; error?: unknown } | "down";
let rpcReply: Rpc = { result: { permission: "FullAccess" } };
const rpcFetch = (async () => {
  if (rpcReply === "down") throw new Error("network");
  return new Response(JSON.stringify(rpcReply), { status: 200 });
}) as unknown as typeof fetch;

let fx: ApiFixture;
afterAll(async () => fx.close());

const keys = () => {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, publicKey: `ed25519:${base58.encode(ed25519.getPublicKey(sk))}` };
};

describe("NEAR wallet sign-in routes", () => {
  beforeAll(async () => {
    fx = await apiFixture();
    await fx.app.close();
    fx.app = await buildApp({
      kernel: fx.kernel,
      nodeEnv: "test",
      nearAuth: { service: new NearAuthService(fx.kernel.db, { fetch: rpcFetch }), perMinute: 1000 },
    });
  });

  async function challenge() {
    const r = await fx.app.inject({ method: "POST", url: "/v1/auth/near/challenge", payload: {} });
    expect(r.statusCode).toBe(200);
    return r.json() as { challengeId: string; message: string; recipient: string; nonce: string; network: string };
  }
  const signed = (c: Awaited<ReturnType<typeof challenge>>, sk: Uint8Array) =>
    Buffer.from(
      ed25519.sign(
        nep413Hash({ message: c.message, recipient: c.recipient, nonce: new Uint8Array(Buffer.from(c.nonce, "base64")) }),
        sk,
      ),
    ).toString("base64");
  const verify = (url: string, body: object, headers = {}) =>
    fx.app.inject({ method: "POST", url, payload: body, headers });
  const reason = (r: { json(): unknown }) => (r.json() as { reasonCode: string }).reasonCode;

  it("issues a challenge with the contract shape", async () => {
    const c = await challenge();
    expect(c).toMatchObject({ message: "Sign in to Nearesis", recipient: "nearesis", network: "testnet" });
    expect(Buffer.from(c.nonce, "base64").length).toBe(32);
  });

  it("signs in, provisions user/org/membership once, then reuses them; /v1/me carries nearAccountId", async () => {
    rpcReply = { result: { permission: "FullAccess" } };
    const { sk, publicKey } = keys();
    const accountId = `alice${Date.now()}.testnet`;
    const c1 = await challenge();
    const r1 = await verify("/v1/auth/near/verify", {
      challengeId: c1.challengeId,
      accountId,
      publicKey,
      signature: signed(c1, sk),
    });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as { token: string; userId: string; accountId: string; created: boolean };
    expect(b1).toMatchObject({ accountId, created: true });
    const me = await fx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(b1.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ nearAccountId: accountId, role: "owner", org: { name: accountId } });

    const c2 = await challenge();
    const r2 = await verify("/v1/auth/near/verify", {
      challengeId: c2.challengeId,
      accountId,
      publicKey,
      signature: signed(c2, sk),
    });
    expect(r2.json()).toMatchObject({ userId: b1.userId, created: false });
    const orgs = await fx.db.admin.query("SELECT count(*)::int AS n FROM organizations WHERE name = $1", [accountId]);
    expect(orgs.rows[0].n).toBe(1);
  });

  it("reasonCodes: CHALLENGE_INVALID (unknown, replay), SIGNATURE_INVALID, NETWORK_MISMATCH, KEY_NOT_FULL_ACCESS, ACCOUNT_NOT_FOUND", async () => {
    const { sk, publicKey } = keys();
    const base = { accountId: "bob.testnet", publicKey };
    const url = "/v1/auth/near/verify";

    const unknown = await verify(url, { ...base, challengeId: crypto.randomUUID(), signature: "AAAA" });
    expect(unknown.statusCode).toBe(401);
    expect(reason(unknown)).toBe("CHALLENGE_INVALID");

    const c = await challenge();
    rpcReply = { result: { permission: "FullAccess" } };
    const ok = await verify(url, { ...base, challengeId: c.challengeId, signature: signed(c, sk) });
    expect(ok.statusCode).toBe(200);
    const replay = await verify(url, { ...base, challengeId: c.challengeId, signature: signed(c, sk) });
    expect(reason(replay)).toBe("CHALLENGE_INVALID");

    const c2 = await challenge();
    const wrong = await verify(url, { ...base, challengeId: c2.challengeId, signature: signed(c2, keys().sk) });
    expect(reason(wrong)).toBe("SIGNATURE_INVALID");
    // a bad attempt burns the challenge
    const retry = await verify(url, { ...base, challengeId: c2.challengeId, signature: signed(c2, sk) });
    expect(reason(retry)).toBe("CHALLENGE_INVALID");

    const c3 = await challenge();
    const mainnet = await verify(url, {
      ...base,
      accountId: "bob.near",
      challengeId: c3.challengeId,
      signature: signed(c3, sk),
    });
    expect(reason(mainnet)).toBe("NETWORK_MISMATCH");

    const c4 = await challenge();
    rpcReply = { result: { permission: { FunctionCall: { allowance: "1", receiver_id: "x", method_names: [] } } } };
    const fc = await verify(url, { ...base, challengeId: c4.challengeId, signature: signed(c4, sk) });
    expect(reason(fc)).toBe("KEY_NOT_FULL_ACCESS");

    const c5 = await challenge();
    rpcReply = { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } };
    const nokey = await verify(url, { ...base, challengeId: c5.challengeId, signature: signed(c5, sk) });
    expect(reason(nokey)).toBe("KEY_NOT_FULL_ACCESS");

    const c6 = await challenge();
    rpcReply = { error: { cause: { name: "UNKNOWN_ACCOUNT" } } };
    const noacct = await verify(url, { ...base, challengeId: c6.challengeId, signature: signed(c6, sk) });
    expect(reason(noacct)).toBe("ACCOUNT_NOT_FOUND");

    const c7 = await challenge();
    rpcReply = "down";
    const down = await verify(url, { ...base, challengeId: c7.challengeId, signature: signed(c7, sk) });
    expect(down.statusCode).toBe(503);
    expect(reason(down)).toBe("NEAR_RPC_UNAVAILABLE");
    rpcReply = { result: { permission: "FullAccess" } };
  });

  it("an expired challenge is refused", async () => {
    const { sk, publicKey } = keys();
    const c = await challenge();
    await fx.db.admin.query("UPDATE near_auth_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [
      c.challengeId,
    ]);
    const r = await verify("/v1/auth/near/verify", {
      challengeId: c.challengeId,
      accountId: "carol.testnet",
      publicKey,
      signature: signed(c, sk),
    });
    expect(reason(r)).toBe("CHALLENGE_INVALID");
  });

  it("rejects malformed bodies", async () => {
    const r = await verify("/v1/auth/near/verify", { challengeId: "x" });
    expect(r.statusCode).toBe(422);
  });

  it("link needs a session, links once, and refuses an account another user holds", async () => {
    rpcReply = { result: { permission: "FullAccess" } };
    const seeded = await seedOrg(fx.db.admin, "linkorg", { dev: "owner", other: "owner" });
    const token = await login(fx.app, seeded.users.dev!.subject);
    const otherToken = await login(fx.app, seeded.users.other!.subject);
    const { sk, publicKey } = keys();
    const body = async () => {
      const c = await challenge();
      return { challengeId: c.challengeId, accountId: "dave.testnet", publicKey, signature: signed(c, sk) };
    };

    expect((await verify("/v1/auth/near/link", await body())).statusCode).toBe(401);
    const ok = await verify("/v1/auth/near/link", await body(), bearer(token));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accountId: "dave.testnet", userId: seeded.users.dev!.userId });
    const me = await fx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(me.json()).toMatchObject({ nearAccountId: "dave.testnet" });
    // idempotent for the same user
    expect((await verify("/v1/auth/near/link", await body(), bearer(token))).statusCode).toBe(200);
    // wallet sign-in now lands on the linked dev user
    const c = await challenge();
    const si = await verify("/v1/auth/near/verify", {
      challengeId: c.challengeId,
      accountId: "dave.testnet",
      publicKey,
      signature: signed(c, sk),
    });
    expect(si.json()).toMatchObject({ userId: seeded.users.dev!.userId, created: false });
    const dup = await verify("/v1/auth/near/link", await body(), bearer(otherToken));
    expect(dup.statusCode).toBe(409);
    expect(reason(dup)).toBe("ACCOUNT_ALREADY_LINKED");
  });

  it("rate-limits the public routes per IP", async () => {
    const app = await buildApp({
      kernel: fx.kernel,
      nodeEnv: "test",
      nearAuth: { service: new NearAuthService(fx.kernel.db, { fetch: rpcFetch }), perMinute: 2 },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++)
        codes.push((await app.inject({ method: "POST", url: "/v1/auth/near/challenge", payload: {} })).statusCode);
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await app.close();
    }
  });
});
