import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import net, { isIP } from "node:net";
import { nonPublicReason } from "../egress.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";

/**
 * Network and process confinement for in-process plugin handlers (ch.12 "Tool proxy -> internet", FND-20261111-012).
 *
 * While a plugin handler runs (an AsyncLocalStorage scope that follows every await, timer and callback it starts) the
 * process-wide primitives a plugin could use to reach a host are replaced by guards that refuse and record the attempt:
 * `fetch`, `net.Socket#connect` (so `http`, `https`, `tls`, undici and raw sockets), `dgram`, `dns.lookup`,
 * `child_process`, and `worker_threads`. The kernel's own egress proxy (`ctx.egress`) leaves the scope before it opens a
 * socket, so the sanctioned path is the only one that works. Code outside a plugin scope is unaffected.
 *
 * This confines cooperative and sloppy modules, which is what in-process loading can offer. Code that is hostile
 * (third-party, unreviewed) must run under `isolation: "sandbox"` (container with no network), because a hostile
 * in-process module could still reach primitives this layer does not wrap.
 */
export interface Violation {
  kind: string;
  detail: string;
}
export interface Confinement {
  pluginId: string;
  capability: string;
  violations: Violation[];
}

/** `ip:port` entries of a manifest's `networkHosts` that name an internal address (`localhost` reads as 127.0.0.1). */
export function internalEndpointsOf(networkHosts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const h of networkHosts) {
    const [name, port] = h.split(":");
    if (!name || !port) continue;
    const ip = name === "localhost" ? "127.0.0.1" : name;
    if (isIP(ip) !== 0 && nonPublicReason(ip) !== null) out.add(`${ip}:${port}`);
  }
  return out;
}

export class ConfinementViolation extends Error {
  readonly reasonCode = "PLUGIN_EGRESS_VIOLATION";
  constructor(
    readonly kind: string,
    detail: string,
  ) {
    super(`Blocked: ${kind} is not available to plugins; use ctx.egress (${detail}).`);
    this.name = "ConfinementViolation";
  }
}

const store = new AsyncLocalStorage<Confinement>();
let installed = false;

function refuse(kind: string, detail = ""): never {
  const c = store.getStore();
  const msg = `${kind}${detail ? ` ${detail}` : ""}`.slice(0, 200);
  c?.violations.push({ kind, detail: msg });
  throw new ConfinementViolation(kind, msg);
}

type AnyFn = (...a: unknown[]) => unknown;

/** Replace `obj[key]` with a function that refuses inside a confinement scope and delegates outside it. */
function guard(obj: object, key: string, kind: string): void {
  const o = obj as Record<string, unknown>;
  const original = o[key];
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (store.getStore()) {
      const first = args[0];
      refuse(kind, typeof first === "string" ? first : "");
    }
    return Reflect.apply(original as AnyFn, this, args);
  };
  Object.defineProperty(wrapped, "name", { value: (original as { name: string }).name });
  o[key] = wrapped;
}

export function installConfinement(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (store.getStore()) {
        const a = args[0];
        refuse("fetch", typeof a === "string" ? a : a instanceof URL ? a.toString() : "");
      }
      return Reflect.apply(nativeFetch, globalThis, args);
    } as typeof fetch;
  }
  guard(net.Socket.prototype, "connect", "net.connect");
  guard(dgram.Socket.prototype, "send", "dgram.send");
  guard(dgram.Socket.prototype, "connect", "dgram.connect");
  guard(dns, "lookup", "dns.lookup");
  guard(dns, "resolve", "dns.resolve");
  guard(dns.promises, "lookup", "dns.lookup");
  guard(dns.promises, "resolve", "dns.resolve");
  for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    guard(childProcess, fn, `child_process.${fn}`);
  const RealWorker = workerThreads.Worker;
  const ConfinedWorker = new Proxy(RealWorker, {
    construct(target, args, nt) {
      if (store.getStore()) refuse("worker_threads.Worker");
      return Reflect.construct(target, args, nt);
    },
  });
  (workerThreads as unknown as { Worker: unknown }).Worker = ConfinedWorker;
  syncBuiltinESMExports();
}

/** Run `fn` (a plugin handler) inside a confinement scope. */
export function runConfined<T>(c: Confinement, fn: () => T): T {
  installConfinement();
  return store.run(c, fn);
}

/** Leave the scope: used by the kernel's own proxy so its sockets are not blocked. */
export function outsideConfinement<T>(fn: () => T): T {
  return store.exit(fn);
}

export function currentConfinement(): Confinement | undefined {
  return store.getStore();
}
