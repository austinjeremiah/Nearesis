'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { qk } from '@/lib/api/keys';
import { challengeAndSign } from '@/lib/near/challenge';
import { creditsApi, creditsKey } from '@/lib/near/api';
import { Button } from './ui';
import { NearErrorNotice } from './near-error';

/**
 * Links a NEAR testnet account to the signed-in user: the wallet signs a fresh
 * challenge and the API verifies it before attaching the account. Shown only
 * when /v1/me reports `nearAccountId: null`.
 */
export function LinkNearWallet({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function link() {
    setPending(true);
    setError(null);
    try {
      const { challenge, sig } = await challengeAndSign();
      await creditsApi.link({ challengeId: challenge.challengeId, ...sig });
      await qc.invalidateQueries({ queryKey: qk.me });
      await qc.invalidateQueries({ queryKey: creditsKey });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="col gap2" data-testid="link-near">
      <Button variant={compact ? 'ghost' : 'primary'} pending={pending} onClick={() => void link()} data-testid="link-near-button">
        <Wallet size={14} />
        Link NEAR wallet
      </Button>
      <NearErrorNotice error={error} title="Could not link the wallet" />
    </div>
  );
}
