'use client';

import { createApi } from './client';
import type { Transport } from './transport';
import { newKey } from './transport';

/** Same-origin BFF transport: `/v1/x` becomes `/api/k/x`. The HttpOnly cookie is attached by the browser. */
export const browserTransport: Transport = (path, init = {}) => {
  const rest = path.replace(/^\/v1\//, '');
  const headers = new Headers(init.headers);
  if (!headers.has('x-trace-id')) headers.set('x-trace-id', newKey());
  return fetch(`/api/k/${rest}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
};

export const browserApi = createApi(browserTransport);
