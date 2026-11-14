'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/nx/ui';
import { normalizeCredits } from '@/lib/credits/model';
import { formatUsdExact } from '@/lib/credits/usd';
import { creditsApi, creditsKey } from '@/lib/near/api';

/** "$2.99 of $3.00 credits": the user's real balance from /v1/credits, "credits unknown" until it loads. */
export function CreditsLine() {
  const q = useQuery({ queryKey: creditsKey, queryFn: () => creditsApi.get(), retry: false, staleTime: 30_000 });
  const c = q.data ? normalizeCredits(q.data) : null;
  const text = c && c.known && c.allowanceUsd !== null ? `${formatUsdExact(c.availableUsd)} of ${formatUsdExact(c.allowanceUsd)} credits` : 'credits unknown';
  return (
    <span className="ask-budget" data-testid="ask-credits">
      {text}
    </span>
  );
}

/**
 * The composer in the upstream ask-panel design: a white card with the question box, the credits line and the green
 * Ask button. Shared by the docked Ask panel and the Agent page chat, which both post to the same agent threads API.
 */
export function ComposerCard({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  inputId,
  error,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  pending: boolean;
  placeholder: string;
  inputId: string;
  error?: ReactNode;
  hint?: ReactNode;
}) {
  const hasText = value.trim().length > 0;
  return (
    <form
      className="ag-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      {error}
      <div className="ask-composer-card">
        <label htmlFor={inputId} className="sr-only">Message the agent</label>
        <textarea
          id={inputId}
          data-testid="agent-composer"
          rows={3}
          maxLength={2000}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit(value);
            }
          }}
        />
        <div className="ask-composer-row">
          <CreditsLine />
          <Button type="submit" variant="primary" pending={pending} disabled={!hasText} disabledReason="Type a message first." data-testid="agent-ask">
            <ArrowUp size={13} />
            Ask
          </Button>
        </div>
      </div>
      {hint && <span className="ag-composer-hint">{hint}</span>}
    </form>
  );
}
