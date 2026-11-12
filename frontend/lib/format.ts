/** base-unit integer string → decimal string, no float error. */
export function formatUnits(v: string | bigint, decimals: number): string {
  let b = BigInt(v);
  const neg = b < 0n;
  if (neg) b = -b;
  const base = 10n ** BigInt(decimals);
  const whole = b / base;
  const frac = (b % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function formatToken(amount: string | bigint | null | undefined, decimals: number): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals > 2 ? 4 : 2 });
}

/** "0.05" → "50000" for 6 decimals; null when invalid. */
export function parseUnits(input: string, decimals: number): string | null {
  const s = input.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return (BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0')).toString();
}

export function formatFiat(usd: number, rate: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(usd * rate);
}

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return '0:00';
  const m = Math.floor(secondsLeft / 60);
  return `${m}:${String(secondsLeft % 60).padStart(2, '0')}`;
}

export const short = (h?: string | null, n = 6) => (h ? (h.length > 2 * n + 3 ? `${h.slice(0, n)}…${h.slice(-4)}` : h) : '—');

/** Accepts unix seconds (number/"1730…"), ISO strings or Hedera "sss.nnnnnnnnn". */
export function toUnix(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v.split('.')[0]));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export function clock(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleTimeString(undefined, { hour12: false }) : '—';
}

/** SDK tx id "0.0.123@1730000000.123456789" → Mirror id "0.0.123-1730000000-123456789". */
export function toMirrorTxId(txId: string): string {
  const [acct, ts = ''] = txId.split('@');
  return ts ? `${acct}-${ts.replace('.', '-')}` : txId;
}

/** HashScan links. `base` = config.hashscan (e.g. https://hashscan.io/testnet). */
export const hs = {
  tx: (base: string, consensusTs?: string | null) => (consensusTs ? `${base}/transaction/${consensusTs}` : undefined),
  account: (base: string, id: string) => `${base}/account/${id}`,
  token: (base: string, id: string) => `${base}/token/${id}`,
  topic: (base: string, id: string) => `${base}/topic/${id}`,
};
