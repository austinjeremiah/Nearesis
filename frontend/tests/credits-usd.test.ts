import { describe, it, expect } from 'vitest';
import { allowanceLabel, formatUsdExact, formatUsdFull, isLow, sumUsd, toMicro, usdAtLeast } from '@/lib/credits/usd';
import { entryNearDetail, normalizeCredits, pillState } from '@/lib/credits/model';
import { entryHref, entryTxHash, entryWhat } from '@/lib/credits/entries';

describe('exact USD formatting', () => {
  it('shows available rounded down, never up', () => {
    expect(formatUsdExact('2.970000')).toBe('$2.97');
    expect(formatUsdExact('2.979999')).toBe('$2.97');
    expect(formatUsdExact('2.999999')).toBe('$2.99');
    expect(formatUsdExact('2.9999999999')).toBe('$2.99');
    expect(formatUsdExact('3.000000')).toBe('$3.00');
    expect(formatUsdExact('1234.5')).toBe('$1,234.50');
  });
  it('rounds costs up when asked and shows tiny amounts honestly', () => {
    expect(formatUsdExact('0.000001', { decimals: 4, round: 'up' })).toBe('$0.0001');
    expect(formatUsdExact('0.000001')).toBe('<$0.01');
    expect(formatUsdExact('0.001234', { decimals: 4, round: 'up' })).toBe('$0.0013');
    expect(formatUsdExact('0')).toBe('$0.00');
  });
  it('handles values beyond double precision exactly', () => {
    expect(formatUsdExact('9007199254740993.123456', { decimals: 6 })).toBe('$9,007,199,254,740,993.123456');
    expect(sumUsd('9007199254740993', '1')).toBe('9007199254740994.000000');
  });
  it('never turns unknown into zero', () => {
    for (const v of [null, undefined, '', 'abc', '-1', '1e3', '$3']) {
      expect(formatUsdExact(v as string | null)).toBe('unknown');
      expect(formatUsdFull(v as string | null)).toBe('unknown');
    }
    expect(sumUsd('1', null)).toBeNull();
    expect(usdAtLeast(null, '1')).toBeNull();
    expect(isLow(null, '3')).toBeNull();
  });
  it('full format keeps 2 to 6 places and never rounds', () => {
    expect(formatUsdFull('3.000000')).toBe('$3.00');
    expect(formatUsdFull('0.003300')).toBe('$0.0033');
    expect(formatUsdFull('0.1234567')).toBe('$0.123456');
  });
  it('compares and flags low balances exactly', () => {
    expect(usdAtLeast('0.05', '0.050000')).toBe(true);
    expect(usdAtLeast('0.049999', '0.05')).toBe(false);
    expect(usdAtLeast('1', '0.0000001')).toBe(true); // the need is counted up to a micro-USD
    expect(isLow('0.299999', '3.000000')).toBe(true);
    expect(isLow('0.300000', '3.000000')).toBe(false);
    expect(isLow('0', '0')).toBeNull();
  });
  it('names the allowance for sentences', () => {
    expect(allowanceLabel('3.000000')).toBe('3');
    expect(allowanceLabel('2.5')).toBe('2.5');
    expect(allowanceLabel(null)).toBeNull();
    expect(toMicro('3')).toBe(3_000_000n);
  });
});

const NEW = {
  allowanceUsd: '3.000000',
  spentUsd: '0.030000',
  heldUsd: '0.000000',
  availableUsd: '2.970000',
  exhausted: false,
  contactEmail: 'connect@kaushikh.xyz',
  byCategory: { modelUsd: '0.020000', outlayerUsd: '0.010000', anchorUsd: '0.000000' },
  nearUsdRate: { rate: '5.12', date: '2026-11-13' },
  proofEstimateUsd: '0.004000',
  entries: [
    { id: 'e1', kind: 'grant', category: 'grant', amountUsd: '3.000000', refKind: null, refId: null, detail: null, createdAt: '2026-11-14T10:00:00.000Z' },
    { id: 'e2', kind: 'charge', category: 'outlayer', amountUsd: '0.010000', refKind: 'proof', refId: 'abcdef123456', detail: { txHash: 'H1', chargedYocto: '1000000000000000000000', tokensBurntYocto: '1000000000000000000000', nearUsdRate: '5.12', rateDate: '2026-11-13', workspaceId: 'w1', capsuleId: 'c1' }, createdAt: '2026-11-14T10:01:00.000Z' },
  ],
};

describe('credits view model', () => {
  it('reads the unified shape', () => {
    const c = normalizeCredits(NEW);
    expect(c.known).toBe(true);
    expect(c.availableUsd).toBe('2.970000');
    expect(c.byCategory.outlayerUsd).toBe('0.010000');
    expect(c.nearUsdRate).toEqual({ rate: '5.12', date: '2026-11-13' });
    expect(c.entries).toHaveLength(2);
    expect(pillState(c)).toEqual({ text: '$2.97 / $3.00', tone: '' });
  });
  it('warns under 10% left and marks exhausted', () => {
    expect(pillState(normalizeCredits({ ...NEW, availableUsd: '0.290000' })).tone).toBe('warn');
    expect(pillState(normalizeCredits({ ...NEW, availableUsd: '0.300000' })).tone).toBe('');
    expect(pillState(normalizeCredits({ ...NEW, availableUsd: '0', exhausted: true }))).toEqual({ text: '$0.00 / $3.00', tone: 'bad' });
  });
  it('the old NEAR shape is unknown everywhere, never 0, and does not crash', () => {
    const old = normalizeCredits({ accountId: 'a.testnet', balanceYocto: '5', heldYocto: '0', availableYocto: '5', depositAccount: 'x', network: 'testnet', proofEstimateYocto: '1', entries: [{ id: '1', kind: 'topup', amountYocto: '5', refKind: null, refId: null, detail: null, createdAt: '2026-01-01T00:00:00Z' }] });
    expect(old.known).toBe(false);
    expect(old.allowanceUsd).toBeNull();
    expect(old.availableUsd).toBeNull();
    expect(old.exhausted).toBeNull();
    expect(old.entries[0].amountUsd).toBeNull();
    expect(pillState(old)).toEqual({ text: 'unknown', tone: '' });
    expect(pillState(undefined)).toEqual({ text: 'unknown', tone: '' });
    for (const junk of [null, undefined, 5, 'x', [], { entries: 'no', byCategory: 4 }]) expect(() => normalizeCredits(junk)).not.toThrow();
    expect(normalizeCredits(null).entries).toEqual([]);
    expect(normalizeCredits(null).contactEmail).toBe('connect@kaushikh.xyz');
  });
  it('describes ledger rows: what, link, tx, NEAR detail', () => {
    const [grant, proof] = normalizeCredits(NEW).entries;
    expect(entryWhat(grant).text).toBe('Allowance');
    expect(entryWhat(proof)).toEqual({ text: 'OutLayer proof', short: 'abcdef12' });
    expect(entryHref(proof)).toBe('/w/w1/capsules/c1');
    expect(entryHref(grant)).toBeNull();
    expect(entryTxHash(proof)).toBe('H1');
    expect(entryTxHash(grant)).toBeNull();
    expect(entryNearDetail(proof, (y) => `n${y.length}`)).toEqual({ near: 'n22', rate: '5.12', rateDate: '2026-11-13' });
    expect(entryNearDetail(grant, () => 'x')).toEqual({ near: null, rate: null, rateDate: null });
  });
});
