import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { dismissRefusal, getRefusalState, mailtoHref, openCreditsPopup, refusalInfo, refusalText, reportExhaustedOnLoad, resetRefusal } from '@/lib/credits/refusal';

const exhausted = {
  errorCode: 'BUDGET_EXCEEDED',
  reasonCode: 'CREDITS_EXHAUSTED',
  message: 'You have used your credits. Write to connect@kaushikh.xyz to request more access.',
  details: { allowanceUsd: '3.000000', spentUsd: '3.000000', availableUsd: '0.000000', requiredUsd: null, contactEmail: 'connect@kaushikh.xyz' },
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => resetRefusal());
afterEach(() => vi.unstubAllGlobals());

describe('central 402 handler', () => {
  it('opens the popup when a user action is refused for credits, and still throws the normal error with its details', async () => {
    vi.stubGlobal('fetch', respond(402, exhausted));
    const err = await browserApi.send('POST', '/v1/assistant/answer', { q: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).reasonCode).toBe('CREDITS_EXHAUSTED');
    expect((err as ApiRequestError).detailsObject?.allowanceUsd).toBe('3.000000');
    const s = getRefusalState();
    expect(s.open).toBe(true);
    expect(s.info?.allowanceUsd).toBe('3.000000');
  });
  it('also opens for the global ceiling refusal', async () => {
    vi.stubGlobal('fetch', respond(402, { errorCode: 'BUDGET_EXCEEDED', reasonCode: 'GLOBAL_CEILING', message: 'The global model-spend ceiling is reached.' }));
    await browserApi.send('POST', '/v1/workspaces/w/questions', {}).catch(() => null);
    expect(getRefusalState().open).toBe(true);
    expect(getRefusalState().info?.reasonCode).toBe('GLOBAL_CEILING');
    expect(refusalText(getRefusalState().info)).toBe('You have used your credits. Write to connect@kaushikh.xyz to request more access.');
  });
  it('ignores other 402s and other statuses', async () => {
    vi.stubGlobal('fetch', respond(402, { errorCode: 'BUDGET_EXCEEDED', reasonCode: 'CAP_REACHED', message: 'cap' }));
    await browserApi.send('POST', '/v1/x', {}).catch(() => null);
    vi.stubGlobal('fetch', respond(500, { reasonCode: 'CREDITS_EXHAUSTED' }));
    await browserApi.send('POST', '/v1/x', {}).catch(() => null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 402 })));
    await browserApi.send('POST', '/v1/x', {}).catch(() => null);
    expect(getRefusalState().open).toBe(false);
  });
  it('opens once: a second refusal while open keeps one popup', async () => {
    vi.stubGlobal('fetch', respond(402, exhausted));
    await browserApi.send('POST', '/v1/a', {}).catch(() => null);
    await browserApi.send('POST', '/v1/b', {}).catch(() => null);
    expect(getRefusalState().open).toBe(true);
    dismissRefusal();
    expect(getRefusalState().open).toBe(false);
  });
});

describe('popup does not reopen on polling', () => {
  it('a polled GET refusal after a dismissal stays closed; a new user action reopens it', async () => {
    vi.stubGlobal('fetch', respond(402, exhausted));
    await browserApi.send('POST', '/v1/a', {}).catch(() => null);
    dismissRefusal();
    for (let i = 0; i < 3; i++) await browserApi.get('/v1/credits').catch(() => null);
    expect(getRefusalState().open).toBe(false);
    await browserApi.send('POST', '/v1/a', {}).catch(() => null);
    expect(getRefusalState().open).toBe(true);
  });
  it('exhausted-on-load opens once and not again after a dismissal', () => {
    expect(reportExhaustedOnLoad({ allowanceUsd: '3.000000' })).toBe(true);
    expect(getRefusalState().open).toBe(true);
    dismissRefusal();
    expect(reportExhaustedOnLoad({ allowanceUsd: '3.000000' })).toBe(false);
    expect(reportExhaustedOnLoad({ allowanceUsd: '3.000000' })).toBe(false);
    expect(getRefusalState().open).toBe(false);
    openCreditsPopup(); // a button the person pressed
    expect(getRefusalState().open).toBe(true);
  });
  it('a first polled GET refusal (never dismissed) does open it', async () => {
    vi.stubGlobal('fetch', respond(402, exhausted));
    await browserApi.get('/v1/credits').catch(() => null);
    expect(getRefusalState().open).toBe(true);
  });
});

describe('popup content', () => {
  it('uses the allowance from the response in the text', () => {
    expect(refusalText({ allowanceUsd: '3.000000', contactEmail: 'connect@kaushikh.xyz' })).toBe('You have used your USD 3 of credits. Write to connect@kaushikh.xyz to request more access.');
    expect(refusalText({ allowanceUsd: '2.5', contactEmail: 'connect@kaushikh.xyz' })).toContain('USD 2.5 of credits');
    expect(refusalText(null)).toBe('You have used your credits. Write to connect@kaushikh.xyz to request more access.');
  });
  it('prefills the mail with a request line and the account', () => {
    const href = mailtoHref({ allowanceUsd: '3.000000', accountId: 'u-123', displayName: 'Ada', nearAccountId: 'ada.testnet' });
    expect(href.startsWith('mailto:connect@kaushikh.xyz?subject=')).toBe(true);
    const body = decodeURIComponent(href.split('&body=')[1]);
    expect(body).toContain('my USD 3 of Nearesis credits');
    expect(body).toContain('Account: u-123 (Ada)');
    expect(body).toContain('NEAR account: ada.testnet');
    expect(decodeURIComponent(href.split('subject=')[1].split('&')[0])).toBe('Request for more Nearesis credits');
  });
  it('refusalInfo only accepts the two refusal reason codes', () => {
    expect(refusalInfo(exhausted)?.allowanceUsd).toBe('3.000000');
    expect(refusalInfo({ reasonCode: 'GLOBAL_CEILING' })?.contactEmail).toBe('connect@kaushikh.xyz');
    expect(refusalInfo({ reasonCode: 'OTHER' })).toBeNull();
    expect(refusalInfo(null)).toBeNull();
  });
});
