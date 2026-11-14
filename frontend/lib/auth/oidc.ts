import 'server-only';

/** Cookie that binds an OIDC `state` to the browser that started the sign-in. HttpOnly; Lax so the provider's redirect back carries it. */
export const OIDC_STATE_COOKIE = 'nearesis_oidc';
const MAX_AGE = 600;

export function safeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/home';
}

export function stateCookieHeader(state: string, next: string, secure: boolean): string {
  const v = encodeURIComponent(JSON.stringify({ s: state, n: next }));
  return `${OIDC_STATE_COOKIE}=${v}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}

export function clearStateCookieHeader(secure: boolean): string {
  return `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readStateCookie(cookieHeader: string | null): { s: string; n: string } | null {
  const m = (cookieHeader ?? '').split(/;\s*/).find((c) => c.startsWith(`${OIDC_STATE_COOKIE}=`));
  if (!m) return null;
  try {
    const v = JSON.parse(decodeURIComponent(m.slice(OIDC_STATE_COOKIE.length + 1))) as { s?: unknown; n?: unknown };
    return typeof v.s === 'string' && typeof v.n === 'string' ? { s: v.s, n: v.n } : null;
  } catch {
    return null;
  }
}

/** Constant-time string compare for the state value. */
export function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function origin(req: Request): string {
  const u = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? u.host;
  const proto = req.headers.get('x-forwarded-proto') ?? u.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export function toLogin(req: Request, error: string, extra?: HeadersInit): Response {
  const h = new Headers(extra);
  h.set('location', `${origin(req)}/login?error=${encodeURIComponent(error)}`);
  return new Response(null, { status: 303, headers: h });
}

export function redirectTo(req: Request, path: string, headers: Headers): Response {
  headers.set('location', `${origin(req)}${path}`);
  return new Response(null, { status: 303, headers });
}
