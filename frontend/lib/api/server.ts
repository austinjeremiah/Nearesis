import 'server-only';
import { cookies } from 'next/headers';
import { API_URL, SESSION_COOKIE } from './config';
import { createApi } from './client';
import { ApiRequestError } from './errors';
import type { Transport } from './transport';
import { newKey } from './transport';

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Direct server-to-server transport for server components and route handlers.
 * The bearer comes from the HttpOnly session cookie; the browser never sees it.
 * With no session it fails fast as a 401 so pages can redirect to /login.
 */
export const serverTransport: Transport = async (path, init = {}) => {
  const token = await sessionToken();
  if (!token) {
    throw new ApiRequestError({
      status: 401,
      errorCode: 'UNAUTHENTICATED',
      reasonCode: 'MISSING_SESSION',
      state: 'permission_denied',
      kind: 'unauthenticated',
      message: 'Not signed in.',
      retryable: false,
    });
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (!headers.has('x-trace-id')) headers.set('x-trace-id', newKey());
  return fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' });
};

export const api = createApi(serverTransport);
