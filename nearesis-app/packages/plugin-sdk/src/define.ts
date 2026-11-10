import type { CapabilityDecl, Principal } from "@nearesis/contracts";

export interface InvocationContext {
  signal: AbortSignal;
  requestId: string;
  workspaceId: string;
  principal: Principal;
  capability: string;
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
