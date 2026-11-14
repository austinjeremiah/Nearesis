-- thesis dataset: near_price_daily  (NEAR price per day (USD))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/near_price_daily.json
-- result sha256: ad5f2299d569abb9f95488f190bf3db1cd75d7730cd28381f4bbf715ca05cfe2
-- reproduce: pnpm thesis:data
SELECT day AS d, argMax(close_raw, bucket_start) AS value
FROM nearesis_live.price_candles FINAL
WHERE day BETWEEN {s:Date} AND {e:Date} AND `interval` = '1d' AND symbol = 'NEAR' AND quote_currency = 'usd'
GROUP BY d ORDER BY d
