'use client';

import { errorFromResponse, networkError } from '@/lib/api/errors';
import { signChallenge, type Challenge, type WalletSignature } from './wallet';

/** Fetch a single-use NEP-413 challenge through the BFF. Throws ApiRequestError with the API's reasonCode. */
export async function fetchChallenge(): Promise<Challenge> {
  let r: Response;
  try {
    r = await fetch('/api/auth/near/challenge', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    throw networkError(e);
  }
  const body: unknown = await r.json().catch(() => null);
  if (!r.ok) throw errorFromResponse(r.status, body, r.headers);
  return body as Challenge;
}

/** Challenge from the API, signed by the user's wallet. */
export async function challengeAndSign(): Promise<{ challenge: Challenge; sig: WalletSignature }> {
  const challenge = await fetchChallenge();
  const sig = await signChallenge(challenge);
  return { challenge, sig };
}
