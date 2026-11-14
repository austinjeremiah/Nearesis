import type { CapabilityDecl, Principal } from "@nearesis/contracts";

/** The only sanctioned outbound network path for a plugin (ch.12 tool proxy: manifest allowlist + SSRF filter). */
export interface EgressRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface EgressResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
}
export type EgressFn = (url: string, init?: EgressRequestInit) => Promise<EgressResult>;

export interface InvocationContext {
  signal: AbortSignal;
  requestId: string;
  workspaceId: string;
  principal: Principal;
  capability: string;
  /**
   * Allowlisted, SSRF-filtered HTTP. Bare `fetch`, `node:net`, `node:http(s)`, `node:dns`, child processes and worker
   * threads are blocked while a handler runs; a plugin that needs the network must use this.
   */
  egress: EgressFn;
}

export type CapabilityHandler = (input: unknown, ctx: InvocationContext) => Promise<unknown> | unknown;

export interface PluginModule {
  /** Handlers keyed by capability id, e.g. "fx.echo.say@1". */
  handlers: Readonly<Record<string, CapabilityHandler>>;
  /** Optional health probe; throw to report unhealthy. */
  health?: () => Promise<void> | void;
}

/** Entry points `export default definePlugin({...})`. */
export function definePlugin(mod: PluginModule): PluginModule {
  return Object.freeze({ ...mod, handlers: Object.freeze({ ...mod.handlers }) });
}

export function isPluginModule(v: unknown): v is PluginModule {
  if (!v || typeof v !== "object") return false;
  const h = (v as { handlers?: unknown }).handlers;
  return !!h && typeof h === "object" && Object.values(h).every((f) => typeof f === "function");
}

export type { CapabilityDecl };
