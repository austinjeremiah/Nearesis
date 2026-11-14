import { IngestionError } from "../errors.ts";

/** Hosts that serve the 1Click API. Everything sent to them is checked by `assertQuoteOnlyWire`. */
export const ONECLICK_HOSTS: readonly string[] = ["1click.chaindefuser.com"];

/** Same as the 1Click namespace on any host: `/v0/...` (the explorer lives under `/api/v0/` and is not affected). */
const isOneClickNamespace = (u: URL): boolean =>
  ONECLICK_HOSTS.includes(u.hostname.toLowerCase()) || u.pathname.toLowerCase().startsWith("/v0/");

const deny = (reason: string, u: URL, method: string): never => {
  throw new IngestionError("QUOTE_ONLY_WIRE_VIOLATION", false, {
    reason,
    host: u.hostname,
    method,
    path: u.pathname,
  });
};

/**
 * Final-transport guard for the 1Click API. It runs inside HttpClient.request immediately before the bytes leave the
 * process and does not read any allowlist or caller configuration, so a misconfigured caller cannot widen it.
 *
 * Only two requests may exist on the wire: `GET /v0/tokens` (no body) and `POST /v0/quote` whose serialized JSON body
 * has `dry === true`. Deposits, intents, orders, auth, status, transfers, swaps, anything else, any other method, any path
 * variant (case, trailing slash, double slash, dot segments are normalised by URL first) and any quote without a
 * literal `dry: true` are refused.
 */
export function assertQuoteOnlyWire(method: string, url: string, serializedBody: string | undefined): void {
  const u = new URL(url);
  if (!isOneClickNamespace(u)) return;
  if (u.username || u.password) deny("credentials in URL", u, method);
  if (method === "GET" && u.pathname === "/v0/tokens") {
    if (serializedBody !== undefined) deny("GET /v0/tokens must not carry a body", u, method);
    return;
  }
  if (method === "POST" && u.pathname === "/v0/quote") {
    let parsed: unknown;
    try {
      parsed = serializedBody === undefined ? undefined : JSON.parse(serializedBody);
    } catch {
      return deny("quote body is not JSON", u, method);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { dry?: unknown }).dry !== true
    )
      deny("quote body must contain dry:true", u, method);
    return;
  }
  deny("only GET /v0/tokens and POST /v0/quote (dry:true) may reach the 1Click API", u, method);
}
