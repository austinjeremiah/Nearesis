import { cookies } from "next/headers";

/** Kernel API base (server-side only). Browsers never see the API origin or the session token. */
export const API_URL = process.env.NEARESIS_API_URL ?? "http://127.0.0.1:4100";
export const SESSION_COOKIE = "nearesis_session";

/**
 * The session cookie: HttpOnly (no script access), Secure, SameSite=Strict (no cross-site sends) and bounded in
 * lifetime by the token's own expiry (capped at 8 h; 1 h when the token carries none).
 */
export function sessionCookie(token: string, nowSec = Math.floor(Date.now() / 1000)): string {
  let maxAge = 3600;
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: number;
    };
    if (typeof p.exp === "number") maxAge = Math.max(0, Math.min(8 * 3600, p.exp - nowSec));
  } catch {
    /* opaque token: default lifetime */
  }
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function testHooksEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEARESIS_TEST_HOOKS === "1";
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export async function upstream(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store" });
}
