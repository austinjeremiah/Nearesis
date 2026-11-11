import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

/**
 * Egress guard (ch.12 "Tool proxy -> internet": allowlisted egress + SSRF filter). Every outbound HTTP call a plugin
 * or tool makes goes through `guardedFetch`. Order of checks, none of which opens a socket:
 *   1. URL parses; scheme is http(s); no credentials in the URL.
 *   2. Host and port are on the plugin's `networkHosts` allowlist (default deny; an empty list denies everything).
 *   3. Every address the host resolves to is public. IP-literal forms (decimal, hex, octal, IPv4-mapped IPv6, NAT64,
 *      6to4) are normalised by the URL parser first and then classified like any address.
 * The socket is then opened to the vetted address (the resolver result is pinned, so a second DNS answer cannot
 * redirect it), and every redirect re-runs the full check.
 */
export class EgressDenied extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "EgressDenied";
  }
}

export interface EgressPolicy {
  /** Manifest `networkHosts`: `host` or `host:port`. Port defaults to 443 (https) / 80 (http). */
  allowHosts: readonly string[];
  allowInsecureHttp?: boolean;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface EgressDeps {
  /** DNS resolver (all addresses). Defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * TEST ONLY: remap a vetted public address to a local endpoint after every check has passed, so a test can serve a
   * "public" host without real internet egress. Never set in production wiring.
   */
  dialOverride?: (ip: string, port: number) => { ip: string; port: number };
  /** Observability hook: called with every address the guard is about to connect to (after checks). */
  onDial?: (ip: string, port: number) => void;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}

// ---------------------------------------------------------------------------------------------- address classification

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Expand an IPv6 literal (no brackets, no zone) to eight 16-bit groups. */
function parseV6(s: string): number[] | null {
  let str = s.toLowerCase();
  const pct = str.indexOf("%");
  if (pct >= 0) str = str.slice(0, pct);
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (v4tail) {
    const o = parseV4(v4tail[1]!);
    if (!o) return null;
    str =
      str.slice(0, -v4tail[1]!.length) +
      ((o[0]! << 8) | o[1]!).toString(16) +
      ":" +
      ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** Reason an IPv4 address is not publicly routable, or null when it is. */
function v4Reason(o: number[]): string | null {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return "this-network";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local-metadata";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "ietf-protocol";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 192 && b === 88 && c === 99) return "6to4-relay";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a >= 224) return "multicast-or-reserved";
  return null;
}

/** Why `ip` must not be contacted (null = public). Unparseable input is treated as unsafe. */
export function nonPublicReason(ip: string): string | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = parseV4(ip);
    return o ? v4Reason(o) : "invalid-address";
  }
  if (kind === 6) {
    const g = parseV6(ip);
    if (!g) return "invalid-address";
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
    if (g.every((x) => x === 0)) return "unspecified";
    if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return "loopback";
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
      return v4Reason(embedded) ?? "ipv4-mapped";
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return "ipv4-compatible";
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return "nat64";
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "nat64-local";
    if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard";
    if (g0 === 0x2001 && g1 === 0) return "teredo";
    if (g0 === 0x2001 && g1 === 0xdb8) return "documentation";
    if (g0 === 0x2002) return "6to4";
    if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
    if ((g0 & 0xffc0) === 0xfe80) return "link-local";
    if ((g0 & 0xffc0) === 0xfec0) return "site-local";
    if ((g0 & 0xff00) === 0xff00) return "multicast";
    if ((g0 & 0xe000) !== 0x2000) return "non-global-unicast";
    return null;
  }
  return "invalid-address";
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet)$/;

// ------------------------------------------------------------------------------------------------------------- guard

interface Vetted {
  url: URL;
  host: string;
  port: number;
  ips: string[];
}

function allowed(policy: EgressPolicy, host: string, port: number, scheme: string): boolean {
  const dflt = scheme === "https:" ? 443 : 80;
  return policy.allowHosts.some((h) => {
    const [name, p] = h.toLowerCase().split(":");
    return name === host && (p ? Number(p) : dflt) === port;
  });
}

/** Run every pre-connection check. Throws `EgressDenied`; never opens a socket. */
export async function vetUrl(raw: string, policy: EgressPolicy, deps: EgressDeps = {}): Promise<Vetted> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressDenied("EGRESS_INVALID_URL", "URL does not parse.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowInsecureHttp))
    throw new EgressDenied("EGRESS_SCHEME", `Scheme ${url.protocol} is not permitted.`);
  if (url.username || url.password)
    throw new EgressDenied("EGRESS_CREDENTIALS_IN_URL", "Credentials in URLs are refused.");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!host) throw new EgressDenied("EGRESS_INVALID_URL", "URL has no host.");
  const literal = isIP(host) !== 0;
  if (!literal && INTERNAL_NAME.test(host))
    throw new EgressDenied("EGRESS_INTERNAL_NAME", "Internal host names are refused.");
  if (!allowed(policy, host, port, url.protocol))
    throw new EgressDenied("EGRESS_HOST_NOT_ALLOWED", "Host and port are not on the plugin allowlist.");
  if (literal) {
    const why = nonPublicReason(host);
    if (why) throw new EgressDenied("EGRESS_PRIVATE_ADDRESS", `Address class ${why} is refused.`);
    return { url, host, port, ips: [host] };
  }
  let ips: string[];
  try {
    ips = deps.resolve
      ? await deps.resolve(host)
      : (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new EgressDenied("EGRESS_DNS_FAILURE", "Host did not resolve.");
  }
  if (ips.length === 0) throw new EgressDenied("EGRESS_DNS_FAILURE", "Host did not resolve.");
  for (const ip of ips) {
    const why = nonPublicReason(ip);
    if (why) throw new EgressDenied("EGRESS_PRIVATE_ADDRESS", `Host resolves to a ${why} address.`);
  }
  return { url, host, port, ips };
}

function once(
  v: Vetted,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  policy: EgressPolicy,
  deps: EgressDeps,
): Promise<EgressResponse & { location?: string }> {
  const ip = v.ips[0]!;
  const target = deps.dialOverride ? deps.dialOverride(ip, v.port) : { ip, port: v.port };
  deps.onDial?.(ip, v.port);
  const pinned: LookupFunction = (_h, _o, cb) => {
    const all = (_o as { all?: boolean }).all;
    if (all)
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: target.ip, family: isIP(target.ip) },
      ]);
    else cb(null, target.ip, isIP(target.ip));
  };
  const mod = v.url.protocol === "https:" ? https : http;
  const maxBytes = policy.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: v.host,
        port: target.port,
        path: `${v.url.pathname}${v.url.search}`,
        method: init.method ?? "GET",
        headers: { ...init.headers, host: v.url.host },
        lookup: pinned,
        servername: isIP(v.host) ? undefined : v.host,
        timeout: policy.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > maxBytes) {
            req.destroy(new EgressDenied("EGRESS_RESPONSE_TOO_LARGE", "Response exceeds the byte cap."));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, val] of Object.entries(res.headers))
            headers[k] = Array.isArray(val) ? val.join(", ") : (val ?? "");
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
            url: v.url.toString(),
            ...(headers.location ? { location: headers.location } : {}),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new EgressDenied("EGRESS_TIMEOUT", "Request timed out.")));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export async function guardedFetch(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  policy: EgressPolicy,
  deps: EgressDeps = {},
): Promise<EgressResponse> {
  let current = rawUrl;
  const max = policy.maxRedirects ?? 3;
  for (let hop = 0; hop <= max; hop++) {
    const vetted = await vetUrl(current, policy, deps);
    const res = await once(vetted, hop === 0 ? init : { ...init, method: "GET", body: "" }, policy, deps);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, vetted.url).toString();
      continue;
    }
    return res;
  }
  throw new EgressDenied("EGRESS_TOO_MANY_REDIRECTS", "Too many redirects.");
}

/** Bind a plugin's manifest allowlist; this is what the tool proxy hands to plugin handlers. */
export function egressFetchFor(networkHosts: readonly string[], deps: EgressDeps = {}) {
  const policy: EgressPolicy = { allowHosts: networkHosts };
  return (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    guardedFetch(url, init, policy, deps);
}
