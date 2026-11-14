import { describe, it, expect } from 'vitest';
import { addYocto, decodeNonce, formatNear, nearToYocto, yoctoAtLeast } from '@/lib/near/units';

describe('NEAR <-> yocto', () => {
  it('converts typed amounts exactly', () => {
    expect(nearToYocto('1')).toBe('1000000000000000000000000');
    expect(nearToYocto('0.1')).toBe('100000000000000000000000');
    expect(nearToYocto('0.000000000000000000000001')).toBe('1');
    expect(nearToYocto(' 12.5 ')).toBe('12500000000000000000000000');
    expect(nearToYocto('123456789.123456789012345678901234')).toBe('123456789123456789012345678901234');
  });
  it('refuses anything that is not a plain positive decimal', () => {
    for (const s of ['', '0', '0.0', '-1', '1e3', '1,5', '.5', '1.', 'abc', '0.0000000000000000000000001', '+1', '1 2']) {
      expect(nearToYocto(s), s).toBeNull();
    }
  });
  it('formats with up to 6 decimals and trims zeros', () => {
    expect(formatNear('1000000000000000000000000')).toBe('1');
    expect(formatNear('1500000000000000000000000')).toBe('1.5');
    expect(formatNear('1234567890000000000000000')).toBe('1.234567');
    expect(formatNear('1234567890000000000000000', { round: 'up' })).toBe('1.234568');
    expect(formatNear('1234567000000000000000000000')).toBe('1,234.567');
    expect(formatNear('0')).toBe('0');
  });
  it('shows tiny non-zero amounts honestly', () => {
    expect(formatNear('1')).toBe('<0.000001');
    expect(formatNear('1', { round: 'up' })).toBe('0.000001');
  });
  it('never turns unknown into zero', () => {
    expect(formatNear(null)).toBe('unknown');
    expect(formatNear(undefined)).toBe('unknown');
    expect(formatNear('')).toBe('unknown');
    expect(formatNear('1.5')).toBe('unknown');
    expect(formatNear('-3')).toBe('unknown');
  });
  it('adds and compares without floats', () => {
    expect(addYocto('9007199254740993', '1')).toBe('9007199254740994');
    expect(addYocto('1', null)).toBeNull();
    expect(yoctoAtLeast('10', '10')).toBe(true);
    expect(yoctoAtLeast('9', '10')).toBe(false);
    expect(yoctoAtLeast(null, '10')).toBeNull();
  });
});

describe('nonce decoding', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 1);
  const b64 = btoa(String.fromCharCode(...bytes));
  it('decodes base64 to the 32 raw bytes', () => {
    const out = decodeNonce(b64);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
    expect([...out]).toEqual([...bytes]);
  });
  it('accepts base64url without padding', () => {
    const url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect([...decodeNonce(url)]).toEqual([...bytes]);
  });
  it('rejects wrong lengths and junk', () => {
    expect(() => decodeNonce(btoa('short'))).toThrow(/32 bytes/);
    expect(() => decodeNonce(btoa('x'.repeat(33)))).toThrow(/32 bytes/);
    expect(() => decodeNonce('not base64!!')).toThrow();
    expect(() => decodeNonce('')).toThrow();
  });
});
