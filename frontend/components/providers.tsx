'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api/errors';

/**
 * TanStack Query for the app area. Retries follow the API's own contract:
 * never retry 401/403 or other non-retryable refusals; retry retryable ones a
 * few times with backoff. SSE events invalidate these caches (lib/sse).
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (err instanceof ApiRequestError) return err.retryable && count < 3;
          return count < 1;
        },
        retryDelay: (count, err) =>
          err instanceof ApiRequestError && err.retryAfterSeconds
            ? err.retryAfterSeconds * 1000
            : Math.min(1000 * 2 ** count, 15_000),
      },
    },
  });
}

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
