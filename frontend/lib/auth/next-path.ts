/**
 * A `next` value from a URL is only followed when it is a path on this site: it starts with one slash, carries no
 * backslash, control character or second slash, and resolves to the same origin. Anything else becomes the fallback.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/home'): string {
  if (!raw || raw.length > 600) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const u = new URL(raw, 'http://nearesis.invalid');
    if (u.origin !== 'http://nearesis.invalid') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
