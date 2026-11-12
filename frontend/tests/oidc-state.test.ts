import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { readStateCookie, safeNext, sameState, stateCookieHeader } from '@/lib/auth/oidc';

describe('oidc state binding', () => {
  it('round-trips the cookie and is HttpOnly Lax', () => {
    const h = stateCookieHeader('abc123', '/w/x/overview', false);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Lax');
    const raw = h.split(';')[0]!;
    expect(readStateCookie(`other=1; ${raw}`)).toEqual({ s: 'abc123', n: '/w/x/overview' });
  });
  it('rejects forged, missing and malformed state', () => {
    expect(sameState('abc', 'abd')).toBe(false);
    expect(sameState('abc', 'abcd')).toBe(false);
    expect(sameState('abc', 'abc')).toBe(true);
    expect(readStateCookie(null)).toBeNull();
    expect(readStateCookie('nearesis_oidc=%7Bnot-json')).toBeNull();
  });
  it('only returns same-origin paths', () => {
    expect(safeNext('//evil.com')).toBe('/home');
    expect(safeNext('https://evil.com')).toBe('/home');
    expect(safeNext('/settings')).toBe('/settings');
    expect(safeNext(null)).toBe('/home');
  });
});
