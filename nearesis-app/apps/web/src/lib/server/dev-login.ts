/** The "Sign in (dev)" button exists only when explicitly enabled, and never in a production build. */
export function devLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEARESIS_DEV_LOGIN === "1" && env.NODE_ENV !== "production";
}
