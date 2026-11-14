/**
 * Preload (node --import) that denies all outbound network access and counts attempts (D15).
 * Patches net.connect, net.Socket#connect, tls.connect, dns.lookup (callback + promises) and fetch.
 * Writes {attempts, calls} as JSON to $NEARESIS_EGRESS_REPORT at exit; exits non-zero if any attempt occurred.
 */
import dns from "node:dns";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import tls from "node:tls";

const calls: string[] = [];
const deny = (what: string): never => {
  calls.push(what);
  throw new Error(`EGRESS_DENIED: ${what}`);
};

(net as unknown as Record<string, unknown>).connect = () => deny("net.connect");
(net as unknown as Record<string, unknown>).createConnection = () => deny("net.createConnection");
net.Socket.prototype.connect = function () {
  return deny("net.Socket.connect");
} as never;
(tls as unknown as Record<string, unknown>).connect = () => deny("tls.connect");
(dns as unknown as Record<string, unknown>).lookup = () => deny("dns.lookup");
(dns.promises as unknown as Record<string, unknown>).lookup = () => deny("dns.promises.lookup");
globalThis.fetch = (async (input: unknown) => deny(`fetch ${String(input)}`)) as typeof fetch;
syncBuiltinESMExports();

process.on("exit", (code) => {
  const path = process.env.NEARESIS_EGRESS_REPORT;
  if (path) writeFileSync(path, JSON.stringify({ attempts: calls.length, calls }));
  if (calls.length > 0 && code === 0) process.exitCode = 1;
});
