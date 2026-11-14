import 'server-only';
import { SESSION_COOKIE } from '@/lib/api/config';

/**
 * Session cookie helpers shared by every way of signing in (dev login today,
 * OIDC via /v1/auth/* when the backend lands). Whatever mints the kernel
 * bearer token calls `sessionCookieHeader(token, secure)`; nothing else in the
 * app ever stores or reads the token except lib/api/server.ts.
 */
export function tokenClaims(token: string): { exp?: number; sub?: string; org?: string } {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** HttpOnly, SameSite=Strict, bounded by the token's own expiry (max 8 h, 1 h if it carries none). */
export function sessionCookieHeader(token: string, secure: boolean, nowSec = Math.floor(Date.now() / 1000)): string {
  const { exp } = tokenClaims(token);
  const maxAge = typeof exp === 'number' ? Math.max(0, Math.min(8 * 3600, exp - nowSec)) : 3600;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return proto === 'https';
}

/** Mutations through the BFF must come from this origin (SameSite=Strict already blocks cross-site cookies). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser or same-origin navigation without Origin
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
