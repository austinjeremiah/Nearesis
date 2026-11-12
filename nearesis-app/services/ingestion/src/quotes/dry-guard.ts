import { IngestionError } from "../errors.ts";

export interface OutboundRequest {
  method: string;
  url: string;
  body?: unknown;
}

const QUOTE_PATH = /^https:\/\/1click\.chaindefuser\.com\/v0\/quote$/;
const TOKENS_PATH = /^https:\/\/1click\.chaindefuser\.com\/v0\/tokens$/;

/**
 * Final outbound check for anything addressed to the 1Click host (§8: `dry: true` enforced at the HTTP boundary).
 * Wrap the transport's `request` with `guardOutbound1Click`; it throws before any I/O unless the call is
 * `GET /v0/tokens` or `POST /v0/quote` whose JSON body has `dry === true`. Any other 1Click path is refused,
 * so deposit generation, intent submission and withdrawals cannot be reached through the same transport.
 */
export function assertOneClickOutbound(r: OutboundRequest): void {
  const url = r.url.split("?")[0] ?? r.url;
  if (!url.startsWith("https://1click.chaindefuser.com/")) return;
  const method = r.method.toUpperCase();
  if (method === "GET" && TOKENS_PATH.test(url)) return;
  if (method === "POST" && QUOTE_PATH.test(url)) {
    let body = r.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    } else if (body instanceof Uint8Array) {
      try {
        body = JSON.parse(new TextDecoder().decode(body));
      } catch {
        body = null;
      }
    }
    if (body && typeof body === "object" && (body as { dry?: unknown }).dry === true) return;
    throw new IngestionError("DRY_REQUIRED", false, {
      reason: "POST /v0/quote must carry dry:true at the transport",
    });
  }
  throw new IngestionError("ENDPOINT_NOT_ALLOWLISTED", false, {
    reason: "only GET /v0/tokens and POST /v0/quote (dry:true) may reach the 1Click host",
    method,
    path: url,
  });
}

export function guardOutbound1Click<T extends OutboundRequest, R>(
  request: (r: T) => Promise<R>,
): (r: T) => Promise<R> {
  return async (r) => {
    assertOneClickOutbound(r);
    return request(r);
  };
}
