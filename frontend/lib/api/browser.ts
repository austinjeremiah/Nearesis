'use client';

import { createApi } from './client';
import type { Transport } from './transport';
import { newKey } from './transport';
import { refusalInfo, reportRefusal } from '@/lib/credits/refusal';

/**
 * Same-origin BFF transport: `/v1/x` becomes `/api/k/x`. The HttpOnly cookie is attached by the browser.
 *
 * This is the one place every browser API call goes through, so it is also where a 402 CREDITS_EXHAUSTED (or the global
 * model ceiling refusal) is noticed and handed to the app-wide credits popup. The response is cloned, so callers still
 * read the body themselves.
 */
export const browserTransport: Transport = async (path, init = {}) => {
  const rest = path.replace(/^\/v1\//, '');
  const headers = new Headers(init.headers);
  if (!headers.has('x-trace-id')) headers.set('x-trace-id', newKey());
  const res = await fetch(`/api/k/${rest}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 402) {
    const method = (init.method ?? 'GET').toUpperCase();
    try {
      const info = refusalInfo(await res.clone().json());
      if (info) reportRefusal(info, { userAction: method !== 'GET' });
    } catch {
      // A body that is not JSON is not a credits refusal.
    }
  }
  return res;
};

export const browserApi = createApi(browserTransport);
