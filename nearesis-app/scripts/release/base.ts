/** Base read-only adapter (`chain.base.readonly@1`): eth_chainId and at most one finalized header, nothing else. */
export const BASE_CHAIN_ID = "0x2105";
export const BASE_ALLOWED_METHODS = ["eth_chainId", "eth_getBlockByNumber"] as const;
export type Transport = (method: string, params: unknown[]) => Promise<unknown>;

/** Free public Base RPC, used only when the adapter is enabled (`--live`) and NEARESIS_BASE_RPC_URL is not set. No API key. */
export const DEFAULT_BASE_PUBLIC_RPC = "https://mainnet.base.org";
export const BASE_LIMITS = { timeoutMs: 8000, maxResponseBytes: 64 * 1024, maxRequestBytes: 512 } as const;

/**
 * A URL with credentials, a query string or a long opaque path segment is how paid providers carry API keys; the adapter
 * refuses all of them, so only a keyless public endpoint can be configured. https only (http only for loopback fixtures).
 */
export function assertKeylessBaseUrl(raw: string): URL {
  const u = new URL(raw);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:"))
    throw new Error("Base RPC must be https");
  if (u.username || u.password) throw new Error("Base RPC URL must not carry credentials");
  if (u.search || u.hash) throw new Error("Base RPC URL must not carry a query string (API key)");
  if (u.pathname.split("/").some((seg) => seg.length >= 24))
    throw new Error("Base RPC URL path looks like an API key; only keyless public endpoints are allowed");
  return u;
}

/**
 * The real HTTP transport. Read methods only: the method allowlist is enforced HERE as well as in the adapter, so a write
 * method can never be serialised onto the wire even by a caller that bypasses BaseReadonly. Single (non-batch) JSON-RPC
 * call, bounded request and response size, hard timeout, no cookies or auth headers, no redirects followed.
 */
export function createHttpTransport(
  rawUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Transport {
  const url = assertKeylessBaseUrl(rawUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  return async (method, params) => {
    if (!(BASE_ALLOWED_METHODS as readonly string[]).includes(method))
      throw new Error(`method denied at transport: ${method}`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    if (body.length > BASE_LIMITS.maxRequestBytes) throw new Error("request too large");
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(opts.timeoutMs ?? BASE_LIMITS.timeoutMs),
    });
    if (!res.ok) throw new Error(`Base RPC http ${res.status}`);
    const text = await res.text();
    if (text.length > BASE_LIMITS.maxResponseBytes) throw new Error("response too large");
    const j = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`Base RPC error: ${String(j.error.message ?? "unknown").slice(0, 120)}`);
    return j.result;
  };
}

export class BaseReadonly {
  readonly requested: string[] = [];
  private headers = 0;
  private readonly times: number[] = [];
  constructor(
    private readonly transport: Transport,
    private readonly opts: { maxRequestsPerMinute: number; now?: () => number } = { maxRequestsPerMinute: 4 },
  ) {}
  /** The only door to the transport: allowlist, header budget and rate policy are enforced before any RPC. */
  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    if (!(BASE_ALLOWED_METHODS as readonly string[]).includes(method))
      throw new Error(`method denied: ${method}`);
    if (method === "eth_getBlockByNumber") {
      if (params[0] !== "finalized" || params[1] !== false)
        throw new Error("only the finalized header without transactions is allowed");
      if (this.headers >= 1) throw new Error("header budget exhausted");
      this.headers++;
    }
    const now = (this.opts.now ?? Date.now)();
    this.times.push(now);
    if (this.times.filter((t) => now - t < 60_000).length > this.opts.maxRequestsPerMinute)
      throw new Error("rate policy exceeded");
    this.requested.push(method);
    return this.transport(method, params);
  }
  /** Arbitrary method entry used by tests to prove denial before the RPC. */
  call(method: string, params: unknown[] = []) {
    return this.rpc(method, params);
  }
  async smoke(): Promise<{ chainId: string; ok: boolean; header: string | null }> {
    const chainId = String(await this.rpc("eth_chainId", []));
    if (chainId !== BASE_CHAIN_ID) return { chainId, ok: false, header: null };
    const h = (await this.rpc("eth_getBlockByNumber", ["finalized", false])) as { hash?: string } | null;
    return { chainId, ok: true, header: h?.hash ?? null };
  }
}

/** Environment the Base plugin may see: nothing that looks like NEAR key material. */
export function pluginEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (
      v !== undefined &&
      !/NEAR|WALLET|PRIVATE|SECRET|KEY|MNEMONIC|SEED|TOKEN/i.test(k) &&
      !/ed25519:/.test(v)
    )
      out[k] = v;
  return out;
}

/** Report section: the Base smoke is additive and never counts toward G12 or N03. */
export function baseReportSection(r: { ran: boolean; verdict: string }) {
  return {
    title: "Base read-only smoke (additive, independent)",
    testExecuted: r.ran ? "N12 (and N05 if enabled)" : "none: Base adapter not enabled",
    verdict: r.verdict,
    countsTowardG12: false,
    countsTowardN03: false,
    note: "NEAR mainnet commitment (N03) is the required final chain gate; this check is not equivalent to it.",
  };
}
export function g12Verdict(input: { n03: string; n12: string }): "PASS" | "BLOCKED_DEPENDENCY" | "FAIL" {
  return input.n03 === "PASS" ? "PASS" : input.n03 === "FAIL" ? "FAIL" : "BLOCKED_DEPENDENCY";
}
