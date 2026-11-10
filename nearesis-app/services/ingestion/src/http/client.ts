import type { Clock } from "../clock.ts";
import { systemClock } from "../clock.ts";
import { IngestionError } from "../errors.ts";
import type { CredentialSource } from "./credentials.ts";
import { redactHeaders, redactUrl } from "./redact.ts";

export interface AllowRule {
  host: string;
  /** Allowed (method, path) pairs. Path is exact unless it ends with "*" (prefix match). */
  endpoints: Array<{ method: "GET" | "POST"; path: string }>;
}

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Credential attached as a header; read through the CredentialSource. */
  auth?: { credential: string; header: string; scheme?: "Bearer" | "" };
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Non-secret response headers, lowercase. */
  headers: Record<string, string>;
  body: Uint8Array;
  receivedAtMs: number;
}

export interface RequestLogEntry {
  at: number;
  method: string;
  host: string;
  path: string;
  status: number | null;
  outcome: "ok" | "timeout" | "network_error" | "denied";
}

export class HttpTimeoutError extends Error {
  constructor() {
    super("request timed out");
    this.name = "HttpTimeoutError";
  }
}
export class HttpNetworkError extends Error {
  constructor(cause: string) {
    super(`network error: ${cause}`);
    this.name = "HttpNetworkError";
  }
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface HttpClientOptions {
  allow: AllowRule[];
  fetchImpl?: FetchImpl;
  credentials?: CredentialSource;
  clock?: Clock;
  defaultTimeoutMs?: number;
}

/**
 * Single egress point. Enforces the host + (method, path) allowlist before any I/O, attaches credentials from the
 * CredentialSource only, never logs headers, and returns only non-secret response headers.
 */
export class HttpClient {
  readonly requestLog: RequestLogEntry[] = [];
  readonly #o: HttpClientOptions;
  constructor(o: HttpClientOptions) {
    this.#o = o;
  }

  assertAllowed(method: string, url: string): URL {
    const u = new URL(url);
    const rule = this.#o.allow.find(
      (r) => r.host === u.hostname || (LOOPBACK_HOSTS.includes(u.hostname) && r.host === "loopback"),
    );
    const ok =
      rule?.endpoints.some(
        (e) =>
          e.method === method &&
          (e.path.endsWith("*") ? u.pathname.startsWith(e.path.slice(0, -1)) : u.pathname === e.path),
      ) ?? false;
    if (!ok) {
      this.requestLog.push({
        at: (this.#o.clock ?? systemClock).now(),
        method,
        host: u.hostname,
        path: u.pathname,
        status: null,
        outcome: "denied",
      });
      throw new IngestionError(rule ? "ENDPOINT_NOT_ALLOWLISTED" : "EGRESS_DENIED", false, {
        reason: rule ? "endpoint not allowlisted" : "host not allowlisted",
        host: u.hostname,
        method,
        path: u.pathname,
      });
    }
    return u;
  }

  async request(r: HttpRequest): Promise<HttpResponse> {
    const clock = this.#o.clock ?? systemClock;
    const u = this.assertAllowed(r.method, r.url);
    const headers: Record<string, string> = { accept: "application/json", ...(r.headers ?? {}) };
    if (r.body !== undefined) headers["content-type"] = "application/json";
    if (r.auth) {
      const v = this.#o.credentials?.get(r.auth.credential);
      if (v) headers[r.auth.header] = r.auth.scheme === "" ? v : `${r.auth.scheme ?? "Bearer"} ${v}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? this.#o.defaultTimeoutMs ?? 30_000);
    const entry: RequestLogEntry = {
      at: clock.now(),
      method: r.method,
      host: u.hostname,
      path: u.pathname,
      status: null,
      outcome: "ok",
    };
    this.requestLog.push(entry);
    try {
      const f = this.#o.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
      const res = await f(redactNothing(r.url), {
        method: r.method,
        headers,
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        signal: ctl.signal,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const rh: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        rh[k.toLowerCase()] = v;
      });
      entry.status = res.status;
      return { status: res.status, headers: redactHeaders(rh), body: buf, receivedAtMs: clock.now() };
    } catch (e) {
      if (ctl.signal.aborted || (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
        entry.outcome = "timeout";
        throw new HttpTimeoutError();
      }
      entry.outcome = "network_error";
      throw new HttpNetworkError(redactUrl(r.url).split("?")[0] ?? "request");
    } finally {
      clearTimeout(timer);
    }
  }
}

const redactNothing = (u: string): string => u;

/** Standard allowlists for the providers this service may talk to. */
export const ALLOW_EXPLORER: AllowRule = {
  host: "explorer.near-intents.org",
  endpoints: [{ method: "GET", path: "/api/v0/transactions" }],
};
export const ALLOW_ONECLICK: AllowRule = {
  host: "1click.chaindefuser.com",
  endpoints: [
    { method: "GET", path: "/v0/tokens" },
    { method: "POST", path: "/v0/quote" },
  ],
};
export const ALLOW_COINGECKO_PUBLIC: AllowRule = {
  host: "api.coingecko.com",
  endpoints: [
    { method: "GET", path: "/api/v3/ping" },
    { method: "GET", path: "/api/v3/coins/*" },
  ],
};
export const ALLOW_COINGECKO_PRO: AllowRule = {
  host: "pro-api.coingecko.com",
  endpoints: [
    { method: "GET", path: "/api/v3/ping" },
    { method: "GET", path: "/api/v3/coins/*" },
  ],
};
export const ALLOW_LOOPBACK: AllowRule = {
  host: "loopback",
  endpoints: [
    { method: "GET", path: "*" },
    { method: "POST", path: "*" },
  ],
};
export const DEFAULT_ALLOW: AllowRule[] = [
  ALLOW_EXPLORER,
  ALLOW_ONECLICK,
  ALLOW_COINGECKO_PUBLIC,
  ALLOW_COINGECKO_PRO,
];
