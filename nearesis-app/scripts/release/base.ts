/** Base read-only adapter (`chain.base.readonly@1`): eth_chainId and at most one finalized header, nothing else. */
export const BASE_CHAIN_ID = "0x2105";
export const BASE_ALLOWED_METHODS = ["eth_chainId", "eth_getBlockByNumber"] as const;
export type Transport = (method: string, params: unknown[]) => Promise<unknown>;

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
