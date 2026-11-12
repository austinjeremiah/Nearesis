import 'server-only';
import { redirect } from 'next/navigation';
import { ApiRequestError } from './errors';

export type Settled<T> = { ok: true; data: T } | { ok: false; error: ApiRequestError };

/**
 * Await an API call for a server component. 401 sends the person to /login;
 * every other API failure is returned (not thrown) so the page can render the
 * matching state component. Unexpected exceptions still throw.
 */
export async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      if (e.kind === 'unauthenticated') redirect('/login');
      return { ok: false, error: e };
    }
    throw e;
  }
}
