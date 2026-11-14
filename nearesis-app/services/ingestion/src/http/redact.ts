const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|cookie|set-cookie|x-cg-.*)$/i;
const SECRET_PARAM = /(key|token|secret|auth|jwt|signature|password)/i;

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER.test(name);
}

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!isSecretHeader(k)) out[k.toLowerCase()] = v;
  return out;
}

/** Remove credential-looking query parameters and userinfo from a URL. */
export function redactUrl(url: string): string {
  const u = new URL(url);
  u.username = "";
  u.password = "";
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** Recursively drop secret-looking keys from a JSON-able request body. */
export function redactBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactBody);
  if (body && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (!SECRET_PARAM.test(k)) out[k] = redactBody(v);
    return out;
  }
  return body;
}
