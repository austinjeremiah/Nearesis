import { describe, it, expect } from 'vitest';
import { tidyNumbers, tidyNumberParts } from '@/lib/prose';

describe('tidyNumbers', () => {
  it('groups long numbers and rounds large decimals to 2 places', () => {
    expect(tidyNumbers('375238015.87884086 USD')).toBe('375,238,015.88 USD');
    expect(tidyNumbers('about 1234.5678 rows')).toBe('about 1,234.57 rows');
    expect(tidyNumbers('432082145.1030823 USD')).toBe('432,082,145.10 USD');
  });
  it('never rounds an integer, and groups it from five digits', () => {
    expect(tidyNumbers('12345678 swaps')).toBe('12,345,678 swaps');
    expect(tidyNumbers('9999 swaps')).toBe('9999 swaps');
    expect(tidyNumbers('123456789012345678901 wei')).toBe('123,456,789,012,345,678,901 wei');
  });
  it('shortens ratios and small values to four significant digits', () => {
    expect(tidyNumbers('ratio 0.111129')).toBe('ratio 0.1111');
    expect(tidyNumbers('0.00001234567')).toBe('0.00001235');
    expect(tidyNumbers('12.3456')).toBe('12.35');
    expect(tidyNumbers('0.25')).toBe('0.25');
    expect(tidyNumbers('0.1234')).toBe('0.1234');
  });
  it('keeps the meaning when rounding carries', () => {
    expect(tidyNumbers('99.999')).toBe('100');
    expect(tidyNumbers('999999.999')).toBe('1,000,000');
    expect(tidyNumbers('0.99999')).toBe('1');
  });
  it('handles negatives and percentages', () => {
    expect(tidyNumbers('fell -12345.6789 USD')).toBe('fell -12,345.68 USD');
    expect(tidyNumbers('down -0.111129')).toBe('down -0.1111');
    expect(tidyNumbers('grew 12.34567%')).toBe('grew 12.35%');
    expect(tidyNumbers('(-8.123456)')).toBe('(-8.12)');
  });
  it('leaves already formatted and short numbers alone', () => {
    expect(tidyNumbers('1,234,567 and 1,234.5 and 3.5 and 10')).toBe('1,234,567 and 1,234.5 and 3.5 and 10');
    expect(tidyNumbers('$1,234,567.89')).toBe('$1,234,567.89');
  });
  it('leaves dates, times, ids, hashes and versions alone', () => {
    const s = 'On 2026-08-15 at 12:30:45.123456 run cap-wsrun-123456789 hash 0x1234567890abcdef v1.2.3456789 id a1234567 uuid 6b3f1c1e-0000-4000-8000-000000000001 range 10-200000';
    expect(tidyNumbers(s)).toBe(s.replace('range 10-200000', 'range 10-200000'));
  });
  it('keeps the exact value for the tooltip', () => {
    const parts = tidyNumberParts('Volume was 375238015.87884086 USD.');
    expect(parts.find((p) => p.exact)).toEqual({ text: '375,238,015.88', exact: '375238015.87884086' });
    expect(parts.map((p) => p.text).join('')).toBe('Volume was 375,238,015.88 USD.');
  });
});
