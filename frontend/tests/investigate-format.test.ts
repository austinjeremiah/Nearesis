import { describe, expect, it } from 'vitest';
import { usd } from '@/lib/investigate/format';

describe('usd', () => {
  it('shows a missing charge as a dash, never zero', () => {
    expect(usd(null)).toBe('—');
    expect(usd(undefined)).toBe('—');
  });
  it('keeps the digits of a small real charge', () => {
    expect(usd(0.0033)).toBe('$0.0033');
    expect(usd(0.00198955)).toBe('$0.002');
  });
  it('formats whole dollars with cents and a true zero as $0', () => {
    expect(usd(3)).toBe('$3.00');
    expect(usd(0)).toBe('$0');
  });
});
