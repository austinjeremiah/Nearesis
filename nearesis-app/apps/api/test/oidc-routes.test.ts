import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcClient, safeReturnTo } from "@nearesis/kernel";
import { ErrorResponse, OidcCallbackResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

// A stand-in identity provider: discovery, JWKS and a token endpoint that checks PKCE and the client secret.
let idp: Server;
let issuer = "";
let key: Awaited<ReturnType<typeof generateKeyPair>>;
const state = {
  nonce: "",
  challenge: "",
  idSubject: "",
  audience: "client-1",
  issuerClaim: "",
  tokenStatus: 200,
  lastBasic: "",
  verifierOk: false,
  noIdToken: false,
};
let f: ApiFixture;
let aliceSubject: string;
let aliceToken: string;
let client: OidcClient;
const secret = "s3cret";

beforeAll(async () => {
  key = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration")
      return void res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      );
    if (url.pathname === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        void (async () => {
          const p = new URLSearchParams(body);
          state.lastBasic = String(req.headers.authorization ?? "");
          state.verifierOk =
            createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url") === state.challenge;
          if (state.tokenStatus !== 200) {
            res.statusCode = state.tokenStatus;
            return void res.end(JSON.stringify({ error: "invalid_grant" }));
          }
          if (state.noIdToken) return void res.end(JSON.stringify({ access_token: "x" }));
          const idToken = await new SignJWT({ nonce: state.nonce })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setSubject(state.idSubject)
            .setIssuer(state.issuerClaim || issuer)
            .setAudience(state.audience)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(key.privateKey);
          res.end(JSON.stringify({ id_token: idToken, access_token: "x", token_type: "Bearer" }));
        })();
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  client = new OidcClient({
    issuer,
    clientId: "client-1",
    clientSecret: secret,
    redirectUri: "https://app.example/cb",
    scopes: "openid email",
    subjectClaim: "sub",
    authMethod: "basic",
    production: false,
  });
  f = await apiFixture({ appOptions: { frontend: { oidc: client } } });
  const a = await seedOrg(f.db.admin, "oidc", { alice: "analyst" });
  aliceSubject = a.users.alice!.subject;
  aliceToken = await login(f.app, aliceSubject);
});
afterAll(async () => {
  await new Promise((r) => idp.close(r));
  await f?.close();
});

const begin = async (returnTo?: string) => {
  const r = await f.app.inject({
    method: "GET",
    url: `/v1/auth/oidc/login?mode=json${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`,
  });
  expect(r.statusCode).toBe(200);
  const body = r.json<{ authorizationUrl: string; state: string }>();
  const u = new URL(body.authorizationUrl);
  state.nonce = u.searchParams.get("nonce")!;
  state.challenge = u.searchParams.get("code_challenge")!;
  state.idSubject = aliceSubject;
  state.audience = "client-1";
  state.issuerClaim = "";
  state.tokenStatus = 200;
  state.noIdToken = false;
  return { u, state: body.state };
};
const callback = (st: string, code = "code-1") =>
  f.app.inject({ method: "GET", url: `/v1/auth/oidc/callback?code=${code}&state=${encodeURIComponent(st)}` });

describe("OIDC authorization code + PKCE", () => {
  it("login builds a PKCE S256 authorization URL from env-style config", async () => {
    const { u } = await begin("/w/abc");
    expect(u.origin + u.pathname).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://app.example/cb",
      scope: "openid email",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("code_challenge")!.length).toBeGreaterThanOrEqual(43);
    // default mode redirects the browser
    const red = await f.app.inject({ method: "GET", url: "/v1/auth/oidc/login" });
    expect(red.statusCode).toBe(302);
    expect(String(red.headers.location)).toContain(`${issuer}/authorize?`);
  });

  it("callback verifies the ID token and issues the same session token dev login does", async () => {
    const { state: st } = await begin("/w/abc");
    const r = await callback(st);
    expect(r.statusCode).toBe(200);
    const body = OidcCallbackResponse.parse(r.json());
    expect(body.returnTo).toBe("/w/abc");
    expect(body.expiresAt).toBeTruthy();
    expect(state.verifierOk, "PKCE verifier matches the challenge").toBe(true);
    expect(state.lastBasic).toBe(`Basic ${Buffer.from(`client-1:${secret}`).toString("base64")}`);
    // the token is a normal session: same user as dev login, accepted by every route
    const me = await f.app.inject({ method: "GET", url: "/v1/me", headers: bearer(body.token) });
    const meDev = await f.app.inject({ method: "GET", url: "/v1/me", headers: bearer(aliceToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(meDev.json());
  });

  it("state is single use and unknown state is refused", async () => {
    const { state: st } = await begin();
    expect((await callback(st)).statusCode).toBe(200);
    const replay = await callback(st);
    expect(replay.statusCode).toBe(401);
    expect(ErrorResponse.parse(replay.json()).reasonCode).toBe("OIDC_STATE_INVALID");
    expect((await callback("never-issued")).statusCode).toBe(401);
  });

  it("refuses a wrong nonce, audience, issuer or a missing ID token, and a rejected code", async () => {
    for (const mutate of [
      () => (state.nonce = "other"),
      () => (state.audience = "someone-else"),
      () => (state.issuerClaim = "https://evil.example"),
      () => (state.noIdToken = true),
    ]) {
      const { state: st } = await begin();
      mutate();
      const r = await callback(st);
      expect(r.statusCode).toBe(401);
      expect(ErrorResponse.parse(r.json()).reasonCode).toBe("OIDC_TOKEN_INVALID");
    }
    const { state: st } = await begin();
    state.tokenStatus = 400;
    const r = await callback(st);
    expect(r.statusCode).toBe(401);
    expect(ErrorResponse.parse(r.json()).reasonCode).toBe("OIDC_CODE_REJECTED");
    const prov = await begin();
    state.tokenStatus = 503;
    expect((await callback(prov.state)).statusCode).toBe(503);
  });

  it("does not provision: a verified identity with no user is 403, and an error parameter is 401", async () => {
    const { state: st } = await begin();
    state.idSubject = "nobody-" + Date.now();
    const r = await callback(st);
    expect(r.statusCode).toBe(403);
    expect(ErrorResponse.parse(r.json()).reasonCode).toBe("OIDC_USER_NOT_PROVISIONED");
    const e = await f.app.inject({ method: "GET", url: "/v1/auth/oidc/callback?error=access_denied" });
    expect(e.statusCode).toBe(401);
    expect((await f.app.inject({ method: "GET", url: "/v1/auth/oidc/callback" })).statusCode).toBe(422);
  });

  it("only same-site relative return paths survive", () => {
    expect(safeReturnTo("/w/1?x=2")).toBe("/w/1?x=2");
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil",
      "javascript:alert(1)",
      "w/1",
      "/a\nb",
      "",
    ])
      expect(safeReturnTo(bad)).toBeNull();
  });

  it("is rate limited per IP", async () => {
    const lim = await apiFixture({ appOptions: { frontend: { oidc: client } } });
    try {
      let last = 0;
      for (let i = 0; i < 40; i++)
        last = (await lim.app.inject({ method: "GET", url: "/v1/auth/oidc/login?mode=json" })).statusCode;
      expect(last).toBe(429);
    } finally {
      await lim.close();
    }
  });
});

describe("OIDC unconfigured (no provider chosen)", () => {
  it("both routes answer 404 OIDC_NOT_CONFIGURED and dev login still works", async () => {
    const off = await apiFixture({ appOptions: { frontend: { oidc: null } } });
    try {
      for (const url of ["/v1/auth/oidc/login", "/v1/auth/oidc/callback?code=x&state=y"]) {
        const r = await off.app.inject({ method: "GET", url });
        expect(r.statusCode).toBe(404);
        expect(ErrorResponse.parse(r.json()).reasonCode).toBe("OIDC_NOT_CONFIGURED");
      }
      const a = await seedOrg(off.db.admin, "oidc-off", { zed: "owner" });
      expect(await login(off.app, a.users.zed!.subject)).toBeTruthy();
    } finally {
      await off.close();
    }
  });

  it("with no OIDC environment variables the default client is off", async () => {
    const saved = process.env.NEARESIS_OIDC_ISSUER;
    delete process.env.NEARESIS_OIDC_ISSUER;
    const env = await apiFixture();
    try {
      expect((await env.app.inject({ method: "GET", url: "/v1/auth/oidc/login" })).statusCode).toBe(404);
    } finally {
      if (saved !== undefined) process.env.NEARESIS_OIDC_ISSUER = saved;
      await env.close();
    }
  });
});
