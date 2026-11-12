'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { ConfigProvider } from '@/lib/config';
import { EventsProvider } from '@/lib/events';
import { ApiError } from '@/lib/api';
import { ApprovalProvider } from './approvals';

/** One place that turns errors into toasts (ICD-12 codes → human text). */
export function report(e: unknown) {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      NETWORK: 'Cannot reach the Klero API.',
      UNAUTHORIZED: 'Session expired — sign in with World ID again.',
      FORBIDDEN: 'Not allowed (demo key or owner token missing).',
      SCHEMA: 'API and web are out of sync — check the console.',
    };
    return void toast.error(map[e.code] ?? `${e.code}: ${e.message}`);
  }
  toast.error(e instanceof Error ? e.message : 'Something went wrong.');
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
  return (
    <QueryClientProvider client={qc}>
      <ConfigProvider>
        <EventsProvider>
          <ApprovalProvider>
            {children}
            <Toaster position="bottom-right" richColors closeButton />
          </ApprovalProvider>
        </EventsProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
