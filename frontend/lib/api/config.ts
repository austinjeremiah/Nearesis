/** Server-only configuration. Never import from a client component. */
export const API_URL = process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110';
export const SESSION_COOKIE = 'nearesis_session';

/** The dev sign-in exists only when explicitly enabled, and never in a production build unless test hooks are on. */
export function devLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NEARESIS_DEV_LOGIN !== '1') return false;
  return env.NODE_ENV !== 'production' || env.NEARESIS_TEST_HOOKS === '1';
}
