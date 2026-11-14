'use client';

import { ApiRequestError } from '@/lib/api/errors';
import { walletFailure } from '@/lib/near/wallet';
import { Notice } from './ui';

/** A wallet or API failure with its reason code visible, so a refusal is never a bare "failed". */
export function describeNearFailure(e: unknown): { code: string; message: string } {
  if (e instanceof ApiRequestError) return { code: e.reasonCode ?? e.errorCode, message: e.message };
  return walletFailure(e);
}

export function NearErrorNotice({ error, title }: { error: unknown; title: string }) {
  if (!error) return null;
  const f = describeNearFailure(error);
  return (
    <Notice tone="bad" title={title}>
      <span data-testid="near-error" data-code={f.code}>
        {f.message} <span className="mono tiny">({f.code})</span>
      </span>
    </Notice>
  );
}
