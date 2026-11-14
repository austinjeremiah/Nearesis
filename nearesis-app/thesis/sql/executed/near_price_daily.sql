-- thesis dataset: near_price_daily  (NEAR daily close (USD))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 369
-- result file: raw/near_price_daily.json
-- result sha256: 355c60d51dc50c4786fc2c19be26e1da00edb9c1c5fcfc7fa0592d4c6e831e98
-- reproduce: pnpm thesis:data
SELECT day AS d, argMax(close_raw, bucket_start) AS value
FROM nearesis_live.price_candles FINAL
WHERE day BETWEEN {s:Date} AND {e:Date} AND `interval` = '1d' AND symbol = 'NEAR' AND quote_currency = 'usd'
GROUP BY d ORDER BY d
