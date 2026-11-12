import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { KernelError } from "./errors.ts";

/**
 * Generic OpenID Connect relying party: authorization code flow with PKCE (S256), discovery, ID token verification.
 * No provider is chosen: everything comes from the environment, and with no issuer configured the feature does not exist.
 *
 *   NEARESIS_OIDC_ISSUER         issuer URL (discovery at <issuer>/.well-known/openid-configuration)
 *   NEARESIS_OIDC_CLIENT_ID      client id
 *   NEARESIS_OIDC_CLIENT_SECRET  client secret (omit for a public PKCE-only client)
 *   NEARESIS_OIDC_REDIRECT_URI   the registered callback URL the browser returns to (the frontend's, not the API's)
 *   NEARESIS_OIDC_SCOPES         default "openid email profile"
 *   NEARESIS_OIDC_SUBJECT_CLAIM  claim matched against users.oidc_subject, default "sub" (use "email" to map by email)
 *   NEARESIS_OIDC_AUTH_METHOD    basic (default) | post | none: how the client authenticates at the token endpoint
 *
 * The verified subject is matched to an EXISTING user (`users.oidc_subject`); nothing is provisioned from a login.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  subjectClaim: string;
  authMethod: "basic" | "post" | "none";
  /** Plain http endpoints are accepted only for loopback hosts, or when the process is not in production. */
  production: boolean;
}

export function oidcConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  production = env.NODE_ENV === "production",
): OidcConfig | null {
  const issuer = env.NEARESIS_OIDC_ISSUER?.trim();
  const clientId = env.NEARESIS_OIDC_CLIENT_ID?.trim();
  const redirectUri = env.NEARESIS_OIDC_REDIRECT_URI?.trim();
  if (!issuer || !clientId || !redirectUri) return null;
  const secret = env.NEARESIS_OIDC_CLIENT_SECRET;
  const m = env.NEARESIS_OIDC_AUTH_METHOD;
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    ...(secret ? { clientSecret: secret } : {}),
    redirectUri,
    scopes: env.NEARESIS_OIDC_SCOPES?.trim() || "openid email profile",
    subjectClaim: env.NEARESIS_OIDC_SUBJECT_CLAIM?.trim() || "sub",
    authMethod: m === "post" || m === "none" ? m : secret ? "basic" : "none",
    production,
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
interface Pending {
  verifier: string;
  nonce: string;
  returnTo: string | null;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2000;
const b64url = (b: Buffer) => b.toString("base64url");
const refused = (reason: string, message: string) => new KernelError("UNAUTHENTICATED", reason, message);
const providerDown = (message = "The identity provider could not be reached.") =>
  new KernelError("UPSTREAM_DEGRADED", "OIDC_PROVIDER_UNAVAILABLE", message, {
    retryable: true,
    nextAction: "Retry sign-in shortly.",
  });

export interface OidcDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export class OidcClient {
  private discovery: { at: number; doc: Discovery } | null = null;
  private jwks: { uri: string; fn: ReturnType<typeof createRemoteJWKSet> } | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  constructor(
    readonly cfg: OidcConfig,
    deps: OidcDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private checkUrl(u: string, what: string): URL {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw providerDown(`Identity provider ${what} is not a URL.`);
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || !this.cfg.production)))
      throw providerDown(`Identity provider ${what} must be https.`);
    return url;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < 3600_000) return this.discovery.doc;
    let doc: Partial<Discovery>;
    try {
      const r = await this.fetchFn(`${this.cfg.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(String(r.status));
      doc = (await r.json()) as Partial<Discovery>;
    } catch {
      throw providerDown();
    }
    if (
      doc.issuer?.replace(/\/+$/, "") !== this.cfg.issuer ||
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.jwks_uri
    )
      throw providerDown("Identity provider discovery document is not valid for the configured issuer.");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const)
      this.checkUrl(doc[k]!, k);
    this.discovery = { at: this.now(), doc: doc as Discovery };
    return doc as Discovery;
  }

  /** Starts a login: returns the provider URL to send the browser to. The state is single use and expires in 10 minutes. */
  async begin(
    returnTo?: string,
  ): Promise<{ authorizationUrl: string; state: string; expiresInSeconds: number }> {
    const d = await this.discover();
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k);
    if (this.pending.size >= MAX_PENDING)
      throw new KernelError("RATE_LIMITED", "TOO_MANY_LOGINS", "Too many sign-in attempts in progress.", {
        retryable: true,
        nextAction: "Retry in a few minutes.",
      });
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, {
      verifier,
      nonce,
      returnTo: safeReturnTo(returnTo),
      expiresAt: t + STATE_TTL_MS,
    });
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("scope", this.cfg.scopes);
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: u.toString(), state, expiresInSeconds: STATE_TTL_MS / 1000 };
  }

  /** Completes a login: exchanges the code, verifies the ID token and returns the subject to map to a user. */
  async complete(code: string, state: string): Promise<{ subject: string; returnTo: string | null }> {
    const p = this.pending.get(state);
    this.pending.delete(state); // single use, also on failure
    if (!p || p.expiresAt <= this.now())
      throw refused("OIDC_STATE_INVALID", "Sign-in expired or was not started here.");
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: p.verifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (this.cfg.authMethod === "basic" && this.cfg.clientSecret)
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString("base64")}`;
    else {
      body.set("client_id", this.cfg.clientId);
      if (this.cfg.authMethod === "post" && this.cfg.clientSecret)
        body.set("client_secret", this.cfg.clientSecret);
    }
    let tokens: { id_token?: unknown };
    try {
      const r = await this.fetchFn(d.token_endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status >= 500) throw providerDown();
      if (!r.ok) throw refused("OIDC_CODE_REJECTED", "The identity provider rejected the sign-in code.");
      tokens = (await r.json()) as { id_token?: unknown };
    } catch (e) {
      if (e instanceof KernelError) throw e;
      throw providerDown();
    }
    if (typeof tokens.id_token !== "string") throw refused("OIDC_TOKEN_INVALID", "No ID token was returned.");
    if (!this.jwks || this.jwks.uri !== d.jwks_uri)
      this.jwks = {
        uri: d.jwks_uri,
        fn: createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 10_000 }),
      };
    let claims: Record<string, unknown>;
    try {
      const v = await jwtVerify(tokens.id_token, this.jwks.fn, {
        issuer: d.issuer,
        audience: this.cfg.clientId,
        algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"],
        clockTolerance: 60,
      });
      claims = v.payload as Record<string, unknown>;
    } catch {
      throw refused("OIDC_TOKEN_INVALID", "The ID token could not be verified.");
    }
    if (claims.nonce !== p.nonce)
      throw refused("OIDC_TOKEN_INVALID", "The ID token does not belong to this sign-in.");
    if (typeof claims.sub !== "string" || !claims.sub)
      throw refused("OIDC_TOKEN_INVALID", "The ID token has no subject.");
    const subject = claims[this.cfg.subjectClaim];
    if (typeof subject !== "string" || !subject || subject.length > 255)
      throw refused("OIDC_TOKEN_INVALID", `The ID token has no usable ${this.cfg.subjectClaim} claim.`);
    if (this.cfg.subjectClaim === "email" && claims.email_verified === false)
      throw refused("OIDC_EMAIL_UNVERIFIED", "The identity provider reports this email as unverified.");
    return { subject, returnTo: p.returnTo };
  }
}

/** Only same-site relative paths survive: an absolute or protocol-relative URL could turn the callback into an open redirect. */
export function safeReturnTo(v: string | undefined | null): string | null {
  if (!v || v.length > 500) return null;
  if (
    !v.startsWith("/") ||
    v.startsWith("//") ||
    v.includes("\\") ||
    [...v].some((c) => c.charCodeAt(0) < 32)
  )
    return null;
  return v;
}
