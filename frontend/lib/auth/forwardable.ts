/**
 * `/v1/` sub-paths the BFF never forwards: the BFF owns sign-in and sign-out itself.
 * The one exception is `auth/near/link`, which needs the caller's session and so goes through the proxy.
 */
const DENIED = [/^dev\/login$/, /^session\/revoke$/, /^auth(\/|$)/, /^gateway(\/|$)/];

/** True when the sub-path (after /v1/) is safe to forward. No traversal, no encoded separators. */
export function isForwardable(path: string): boolean {
  if (!path || path.length > 600) return false;
  if (!/^[A-Za-z0-9._~:@!$&'()*+,;=%/-]+$/.test(path)) return false;
  const segs = path.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
    let d = s;
    try {
      d = decodeURIComponent(s);
    } catch {
      return false;
    }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\')) return false;
  }
  if (path === 'auth/near/link') return true;
  return !DENIED.some((r) => r.test(path));
}

