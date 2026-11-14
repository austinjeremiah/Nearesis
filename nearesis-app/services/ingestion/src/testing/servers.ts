import type { Clock } from "../clock.ts";
import type { FetchImpl } from "../http/client.ts";

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export function toFetchResponse(r: FakeResponse): Awaited<ReturnType<FetchImpl>> {
  const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
  const headers = { "content-type": "application/json", ...(r.headers ?? {}) };
  return {
    status: r.status,
    headers: { forEach: (cb) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

export interface ServedRequest {
  atMs: number;
  method: string;
  path: string;
  query: Record<string, string>;
  hasAuthorization: boolean;
  body: unknown;
  status: number;
}

/** Common request recording + interception for fixture servers. */
export abstract class FixtureServer {
  readonly requests: ServedRequest[] = [];
  private interceptor: ((r: ServedRequest) => FakeResponse | undefined) | null = null;
  constructor(protected readonly clock: Clock) {}
  intercept(fn: ((r: ServedRequest) => FakeResponse | undefined) | null): void {
    this.interceptor = fn;
  }
  protected abstract handle(req: ServedRequest): FakeResponse;
  readonly fetchImpl: FetchImpl = async (url, init) => {
    const u = new URL(url);
    const req: ServedRequest = {
      atMs: this.clock.now(),
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      hasAuthorization: Object.keys(init.headers).some((h) => h.toLowerCase() === "authorization"),
      body: init.body ? JSON.parse(init.body) : null,
      status: 0,
    };
    this.requests.push(req);
    const res = this.interceptor?.(req) ?? this.handle(req); // may throw to simulate network failures
    req.status = res.status;
    return toFetchResponse(res);
  };
}

type Page = Record<string, unknown>[];

/** Serves Explorer /transactions pages by cursor (direction=next), like the documented API. */
export class ExplorerFixtureServer extends FixtureServer {
  /** Pages with failing status from this page number (1-based) on; e.g. 401. */
  failFrom: { page: number; status: number } | null = null;
  constructor(
    clock: Clock,
    readonly pages: Page[],
  ) {
    super(clock);
  }
  private pageIndexFor(q: Record<string, string>): number | null {
    if (!q.lastDepositAddress) return 0;
    const memo = q.lastDepositMemo ?? "";
    for (const [i, p] of this.pages.entries()) {
      const last = p[p.length - 1] as { depositAddress: string; depositMemo: string | null } | undefined;
      if (last && last.depositAddress === q.lastDepositAddress && (last.depositMemo ?? "") === memo)
        return i + 1;
    }
    return null;
  }
  protected handle(req: ServedRequest): FakeResponse {
    const idx = this.pageIndexFor(req.query);
    if (idx === null)
      return {
        status: 400,
        body: JSON.stringify({ status: 400, error: { code: "BAD_CURSOR", message: "unknown cursor" } }),
      };
    if (this.failFrom && idx + 1 >= this.failFrom.page)
      return {
        status: this.failFrom.status,
        body: JSON.stringify({
          status: this.failFrom.status,
          error: { code: "AUTH", message: "token rejected" },
        }),
      };
    return { status: 200, body: JSON.stringify(this.pages[idx] ?? []) };
  }
}

/** Serves Explorer day-window queries (startTimestampUnix/endTimestampUnix) from a map day -> pages/status. */
export class ExplorerDayServer extends FixtureServer {
  constructor(
    clock: Clock,
    readonly days: Record<string, Array<{ status: number; items: Page | null }>>,
  ) {
    super(clock);
  }
  protected handle(req: ServedRequest): FakeResponse {
    const day = new Date((Number(req.query.startTimestampUnix) + 1) * 1000).toISOString().slice(0, 10);
    const pages = this.days[day];
    if (!pages) return { status: 503, body: "{}" };
    let idx = 0;
    if (req.query.lastDepositAddress) {
      idx = pages.findIndex((p) => {
        const last = p.items?.[p.items.length - 1] as { depositAddress: string } | undefined;
        return last?.depositAddress === req.query.lastDepositAddress;
      });
      idx = idx < 0 ? pages.length : idx + 1;
    }
    const p = pages[idx];
    if (!p) return { status: 200, body: "[]" };
    return { status: p.status, body: p.items ? JSON.stringify(p.items) : "{}" };
  }
}

/** 1Click: serves tokens and quotes from a scenario function; records bodies so dry:true can be asserted. */
export class OneClickFixtureServer extends FixtureServer {
  constructor(
    clock: Clock,
    private readonly tokens: unknown[],
    private readonly quote: (
      body: Record<string, unknown>,
      n: number,
    ) => FakeResponse | "timeout" | "network",
  ) {
    super(clock);
  }
  private n = 0;
  protected handle(req: ServedRequest): FakeResponse {
    if (req.path === "/v0/tokens") return { status: 200, body: JSON.stringify(this.tokens) };
    if (req.path === "/v0/quote") {
      const out = this.quote((req.body ?? {}) as Record<string, unknown>, ++this.n);
      if (out === "timeout") {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (out === "network") throw new TypeError("fetch failed");
      return out;
    }
    return { status: 404, body: JSON.stringify({ message: "not found" }) };
  }
}

/** CoinGecko-like server returning fixed bodies by path. */
export class StaticServer extends FixtureServer {
  constructor(
    clock: Clock,
    private readonly routes: Record<string, FakeResponse>,
  ) {
    super(clock);
  }
  protected handle(req: ServedRequest): FakeResponse {
    return this.routes[req.path] ?? { status: 404, body: "{}" };
  }
}
