/**
 * BigQuery on-demand cost arithmetic. Price source (read 2026-11-13): https://cloud.google.com/bigquery/pricing
 * "On-demand ... $6.25 / 1 tebibyte, per 1 month / account ... The first 1 TiB per month is free." The page lists the
 * regional table separately; the account bills in INR (guardrail in INR), so USD is a list-price estimate, not an invoice.
 * Whether the free TiB or trial credits apply is NOT assumed: figures are shown without and as an upper bound only.
 */
export const ON_DEMAND_USD_PER_TIB = 6.25;
export const PRICE_SOURCE_URL = "https://cloud.google.com/bigquery/pricing";
export const TIB = 1024 ** 4;
/** BigQuery bills at least 10 MB per table referenced by a query; each dry-run estimate already reflects that. */
export const usdForBytes = (bytes: number, perTiB = ON_DEMAND_USD_PER_TIB): number => (bytes / TIB) * perTiB;
export const fmtUsd = (usd: number): string => `USD ${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}`;
