'use client';

import type { NearConnector } from '@hot-labs/near-connect';
import { decodeNonce } from './units';

/**
 * Browser-only NEAR wallet access. The connector is imported dynamically so
 * server rendering never evaluates it, and one instance is shared by sign-in,
 * and linking. Testnet only.
 */

export type Challenge = {
  challengeId: string;
  message: string;
  recipient: string;
  nonce: string;
  network: string;
  expiresAt: string;
};

export type WalletSignature = { accountId: string; publicKey: string; signature: string };

/** A failure with a code the page can show next to the message. */
export class WalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

let connectorPromise: Promise<NearConnector> | null = null;

export function getConnector(): Promise<NearConnector> {
  if (typeof window === 'undefined') return Promise.reject(new WalletError('NO_BROWSER', 'The wallet is only available in the browser.'));
  connectorPromise ??= import('@hot-labs/near-connect').then(
    ({ NearConnector: C }) =>
      new C({ network: 'testnet', features: { signMessage: true, testnet: true }, footerBranding: null }),
  );
  connectorPromise.catch(() => {
    connectorPromise = null;
  });
  return connectorPromise;
}

function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return 'The wallet closed without a response.';
}

/** Human message for a wallet failure, distinguishing a closed popup from other errors. */
export function walletFailure(e: unknown): { code: string; message: string } {
  if (e instanceof WalletError) return { code: e.code, message: e.message };
  const m = describe(e);
  if (/reject|cancel|declin|denied|closed|abort/i.test(m)) return { code: 'WALLET_CANCELLED', message: 'The wallet request was cancelled.' };
  return { code: 'WALLET_ERROR', message: m };
}

/** Connect a wallet and have it sign the NEP-413 challenge (event `wallet:signInAndSignMessage`). */
export async function signChallenge(ch: Challenge): Promise<WalletSignature> {
  const nonce = decodeNonce(ch.nonce);
  const connector = await getConnector();
  return new Promise<WalletSignature>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      connector.off('wallet:signInAndSignMessage', onSigned);
      fn();
    };
    const onSigned = (p: { accounts: { accountId: string; publicKey?: string; signedMessage?: { accountId: string; publicKey: string; signature: string } }[] }) => {
      const a = p.accounts?.[0];
      const sm = a?.signedMessage;
      if (!a || !sm?.signature || !sm.publicKey) {
        finish(() => reject(new WalletError('NO_SIGNED_MESSAGE', 'The wallet did not return a signed message. Choose a wallet that supports message signing.')));
        return;
      }
      finish(() => resolve({ accountId: sm.accountId || a.accountId, publicKey: sm.publicKey, signature: sm.signature }));
    };
    connector.on('wallet:signInAndSignMessage', onSigned);
    connector
      .connect({ signMessageParams: { message: ch.message, recipient: ch.recipient, nonce } })
      .then(() => {
        // The event normally fires before or with this resolution; give a slow wallet a moment, then fail clearly.
        setTimeout(() => finish(() => reject(new WalletError('NO_SIGNED_MESSAGE', 'The wallet connected but did not return a signed message.'))), 8000);
      })
      .catch((e) => finish(() => reject(e)));
  });
}
