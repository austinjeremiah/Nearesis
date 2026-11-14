import { isSpendBlocked, type SpendGate } from "@nearesis/contracts";
import { getAmbientSpendGate } from "../cost/ambient.ts";
import { gateFetch, ingestionPaidOp } from "../cost/gates.ts";
import type { Clock } from "../clock.ts";
import { systemClock } from "../clock.ts";
import { IngestionError } from "../errors.ts";
import type { CredentialSource } from "./credentials.ts";
import { assertQuoteOnlyWire } from "./quote-wire-guard.ts";
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
  /**
   * Marks the single confirmation request an adapter documents after a first 401/403 (the explorer collector, D18).
   * The auth circuit lets exactly one such request through per rejection; any other request is refused while open.
   */
  authConfirm?: boolean;
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
  /** Spend gate (`NEARESIS_COST_CONTROL=1`): each request is authorised before the socket opens; see `gateFetch`. */
  spend?: { gate: SpendGate; paidOp?: (host: string) => string | undefined };
  credentials?: CredentialSource;
  clock?: Clock;
  defaultTimeoutMs?: number;
  /** After a 401 or 403 the credential is not sent again for this long (then exactly one probe). Default 5 min. */
  authCircuitMs?: number;
  /** Called once when a credential is rejected: the source is degraded and a human must act. */
  onAuthDegraded?: (e: AuthDegraded) => void;
}

export interface AuthDegraded {
  credential: string;
  host: string;
  status: number;
  state: "degraded";
  humanAction: string;
}

interface AuthBreaker {
  openedAt: number;
  fingerprint: string | null;
  probing: boolean;
  confirmUsed: boolean;
}

/**
 * Single egress point. Enforces the host + (method, path) allowlist before any I/O, attaches credentials from the
 * CredentialSource only, never logs headers, and returns only non-secret response headers.
 */
export class HttpClient {
  readonly requestLog: RequestLogEntry[] = [];
  readonly #breakers = new Map<string, AuthBreaker>();
  readonly #o: HttpClientOptions;
  constructor(o: HttpClientOptions) {
    const ambient = getAmbientSpendGate();
    const spend = o.spend ?? (ambient ? { gate: ambient, paidOp: ingestionPaidOp } : undefined);
    this.#o = spend
      ? {
          ...o,
          fetchImpl: gateFetch(
            o.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl),
            spend.gate,
            spend.paidOp ? { paidOp: spend.paidOp } : {},
          ),
        }
      : o;
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

  /** Auth state of the source behind a credential: `degraded` after a 401 or 403 until rotation or a successful probe. */
  authState(credential: string, host: string): { state: "ok" | "degraded"; humanAction?: string } {
    const b = this.#breakers.get(`${host}|${credential}`);
    return b
      ? { state: "degraded", humanAction: `rotate credential ${credential} for ${host}` }
      : { state: "ok" };
  }

  #checkBreaker(
    key: string,
    credential: string,
    host: string,
    method: string,
    path: string,
    confirm: boolean,
  ): void {
    const b = this.#breakers.get(key);
    if (!b) return;
    const now = (this.#o.clock ?? systemClock).now();
    if (this.#o.credentials && this.#o.credentials.fingerprint(credential) !== b.fingerprint) {
      this.#breakers.delete(key); // rotated: the new credential is tried, the old one is never sent again
      return;
    }
    if (!b.probing && now - b.openedAt >= (this.#o.authCircuitMs ?? 300_000)) {
      b.probing = true; // exactly one probe after the circuit interval
      return;
    }
    if (confirm && !b.confirmUsed) {
      b.confirmUsed = true;
      return;
    }
    this.requestLog.push({ at: now, method, host, path, status: null, outcome: "denied" });
    throw new IngestionError("AUTH_REJECTED", false, {
      reason: "auth circuit open: credential was rejected, rotate it",
      host,
      credential,
    });
  }

  #observeAuth(key: string, credential: string, host: string, status: number): void {
    const now = (this.#o.clock ?? systemClock).now();
    if (status === 401 || status === 403) {
      const existing = this.#breakers.get(key);
      this.#breakers.set(key, {
        confirmUsed: existing?.confirmUsed ?? false,
        openedAt: now,
        fingerprint: this.#o.credentials?.fingerprint(credential) ?? null,
        probing: false,
      });
      if (!existing)
        this.#o.onAuthDegraded?.({
          credential,
          host,
          status,
          state: "degraded",
          humanAction: `rotate credential ${credential} for ${host}`,
        });
    } else if (status < 400) this.#breakers.delete(key);
  }

  async request(r: HttpRequest): Promise<HttpResponse> {
    const clock = this.#o.clock ?? systemClock;
    const u = this.assertAllowed(r.method, r.url);
    const headers: Record<string, string> = { accept: "application/json", ...(r.headers ?? {}) };
    if (r.body !== undefined) headers["content-type"] = "application/json";
    const breakerKey = r.auth ? `${u.hostname}|${r.auth.credential}` : null;
    if (r.auth && breakerKey)
      this.#checkBreaker(
        breakerKey,
        r.auth.credential,
        u.hostname,
        r.method,
        u.pathname,
        r.authConfirm === true,
      );
    if (r.auth) {
      const v = this.#o.credentials?.get(r.auth.credential);
      if (v) headers[r.auth.header] = r.auth.scheme === "" ? v : `${r.auth.scheme ?? "Bearer"} ${v}`;
    }
    const wireBody = r.body !== undefined ? JSON.stringify(r.body) : undefined;
    // Final-transport guard: independent of the allowlist and of whoever built this client.
    assertQuoteOnlyWire(r.method, r.url, wireBody);
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
        ...(wireBody !== undefined ? { body: wireBody } : {}),
        signal: ctl.signal,
      });
      // A provider that echoes a request header or debug field must not put a credential into any archive or log.
      const buf = this.#o.credentials
        ? this.#o.credentials.redactBytes(new Uint8Array(await res.arrayBuffer())).bytes
        : new Uint8Array(await res.arrayBuffer());
      const rh: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        rh[k.toLowerCase()] = v;
      });
      entry.status = res.status;
      if (r.auth && breakerKey) this.#observeAuth(breakerKey, r.auth.credential, u.hostname, res.status);
      return { status: res.status, headers: redactHeaders(rh), body: buf, receivedAtMs: clock.now() };
    } catch (e) {
      if (isSpendBlocked(e)) {
        entry.outcome = "denied";
        throw e; // refused before the socket opened: surface the budget stop, not a network error
      }
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
