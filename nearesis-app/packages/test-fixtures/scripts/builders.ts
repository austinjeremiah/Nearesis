/** Deterministic builders for SYNTHETIC fixture data in the providers' documented (RECORDED) formats. */

export interface TxOpts {
  n: number;
  createdAt: string;
  status?: string;
  amountIn?: string;
  amountOut?: string;
  amountInFormatted?: string;
  amountOutFormatted?: string;
  originAsset?: string;
  destinationAsset?: string;
  depositType?: string;
  recipientType?: string;
  nearTxHashes?: string[];
  memo?: string | null;
  usdIn?: string | null;
  usdOut?: string | null;
}

const pad = (n: number, w = 4): string => String(n).padStart(w, "0");

export function mkTx(o: TxOpts): Record<string, unknown> {
  const memo = o.memo === undefined ? (o.n % 4 === 0 ? `memo-${pad(o.n)}` : null) : o.memo;
  const depositAddress = `dep${pad(o.n)}synthetic`;
  const status = o.status ?? "SUCCESS";
  const inFlight = status === "PROCESSING" || status === "PENDING_DEPOSIT" || status === "INCOMPLETE_DEPOSIT";
  const amountIn = o.amountIn ?? `${o.n}${"0".repeat(17)}${pad(o.n)}`;
  const amountOut = o.amountOut ?? (inFlight ? "0" : `${o.n * 3}${"0".repeat(15)}${pad(o.n)}`);
  const t: Record<string, unknown> = {
    originAsset: o.originAsset ?? "nep141:eth.omft.near",
    destinationAsset: o.destinationAsset ?? "nep141:wrap.near",
    depositAddress,
    depositMemo: memo,
    depositAddressAndMemo: memo ? `${depositAddress}_${memo}` : depositAddress,
    createdAt: o.createdAt,
    createdAtTimestamp: Math.floor(Date.parse(o.createdAt) / 1000),
    intentHashes: null,
    amountInFormatted: o.amountInFormatted ?? "0.1",
    amountOutFormatted: o.amountOutFormatted ?? (inFlight ? "0" : "0.3"),
    appFees: [],
    nearTxHashes: o.nearTxHashes ?? [`nearhash${pad(o.n)}synthetic`],
    originChainTxHashes: [`originhash${pad(o.n)}synthetic`],
    destinationChainTxHashes: inFlight ? [] : [`desthash${pad(o.n)}synthetic`],
    amountIn,
    amountInUsd: o.usdIn === undefined ? "12.34" : o.usdIn,
    amountOut,
    amountOutUsd: o.usdOut === undefined ? (inFlight ? "0" : "12.30") : o.usdOut,
    refundTo: `refund${pad(o.n)}.synthetic`,
    refundFeeFormatted: null,
    depositType: o.depositType ?? "ORIGIN_CHAIN",
    recipientType: o.recipientType ?? "DESTINATION_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipient: `recipient${pad(o.n)}.synthetic`,
    status,
    referral: null,
    senders: [],
  };
  return t;
}

export const minutesBefore = (baseIso: string, minutes: number): string =>
  new Date(Date.parse(baseIso) - minutes * 60_000).toISOString();

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
