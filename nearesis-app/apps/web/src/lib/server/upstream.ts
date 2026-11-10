import { cookies } from "next/headers";

/** Kernel API base (server-side only). Browsers never see the API origin or the session token. */
export const API_URL = process.env.NEARESIS_API_URL ?? "http://127.0.0.1:4100";
export const SESSION_COOKIE = "nearesis_session";

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
