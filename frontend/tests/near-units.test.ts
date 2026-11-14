import { describe, it, expect } from 'vitest';
import { addYocto, decodeNonce, formatNear } from '@/lib/near/units';

describe('yocto display', () => {
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
  it('adds without floats', () => {
    expect(addYocto('9007199254740993', '1')).toBe('9007199254740994');
    expect(addYocto('1', null)).toBeNull();
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
