-- pooled ('all') query
WITH reg AS (
  SELECT provider_asset_id, symbol_observed AS sym, blockchain AS chain
  FROM nearesis_live.asset_registry FINAL WHERE provider_id = 'intents-1click'
),
base AS (
  SELECT
    s.created_day AS d,
    s.amount_in_usd AS i,
    s.amount_out_usd AS o,
    i - o AS sp,
    (i IS NOT NULL AND o IS NOT NULL AND i > 0 AND o > 0) AS u,
    (u AND abs(sp) * 5 > i) AS a,
    (u AND NOT a) AS c,
    if(c, toFloat64(sp) * 10000 / toFloat64(i), NULL) AS bps,
    multiIf(
      ro.provider_asset_id = '' OR rd.provider_asset_id = '', 'unclassified',
      has(['usdc','usdt','usdt0','dai','xdai','usd1','usdcx','usdg','usde','usdf','usad','frax','nrusdt'], lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', '')))) AND has(['usdc','usdt','usdt0','dai','xdai','usd1','usdcx','usdg','usde','usdf','usad','frax','nrusdt'], lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', '')))), 'stable_to_stable',
      transform(lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', ''))), ['weth','wnear','wbtc','cbbtc','btc(omni)','wnearkat'], ['eth','near','btc','btc','btc','nearkat'], lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', '')))) = transform(lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', ''))), ['weth','wnear','wbtc','cbbtc','btc(omni)','wnearkat'], ['eth','near','btc','btc','btc','nearkat'], lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', '')))) AND ro.chain != rd.chain, 'same_asset_cross_chain',
      'volatile_other') AS rt
  FROM nearesis_live.intents_swaps AS s FINAL
  LEFT JOIN reg AS ro ON ro.provider_asset_id = s.origin_asset
  LEFT JOIN reg AS rd ON rd.provider_asset_id = s.destination_asset
  WHERE s.status = 'SUCCESS'
)
SELECT
  formatDateTime(d, '%Y-%m') AS period,
  'all' AS grp,
  count() AS n_success,
  countIf(i IS NOT NULL) AS n_with_in_usd,
  toString(sumIf(i, i IS NOT NULL)) AS in_usd_success,
  countIf(u) AS n_usable,
  countIf(a) AS n_artefact,
  toString(sumIf(i, a)) AS artefact_in_usd,
  toString(sumIf(sp, a)) AS artefact_spread_usd,
  countIf(c) AS n_clean,
  toString(sumIf(i, c)) AS clean_in_usd,
  toString(sumIf(sp, c)) AS clean_spread_usd,
  toString(round(if(sumIf(i, c) > 0, sumIf(sp, c) * 10000 / sumIf(i, c), NULL), 6)) AS vw_mean_bps,
  quantilesExact(0.25, 0.5, 0.75)(bps) AS q,
  toString(round(q[2], 6)) AS median_bps,
  toString(round(q[1], 6)) AS p25_bps,
  toString(round(q[3], 6)) AS p75_bps,
  countIf(c AND sp < 0) AS n_negative_spread
FROM base
GROUP BY period, grp
ORDER BY period, grp;

-- by route type query
WITH reg AS (
  SELECT provider_asset_id, symbol_observed AS sym, blockchain AS chain
  FROM nearesis_live.asset_registry FINAL WHERE provider_id = 'intents-1click'
),
base AS (
  SELECT
    s.created_day AS d,
    s.amount_in_usd AS i,
    s.amount_out_usd AS o,
    i - o AS sp,
    (i IS NOT NULL AND o IS NOT NULL AND i > 0 AND o > 0) AS u,
    (u AND abs(sp) * 5 > i) AS a,
    (u AND NOT a) AS c,
    if(c, toFloat64(sp) * 10000 / toFloat64(i), NULL) AS bps,
    multiIf(
      ro.provider_asset_id = '' OR rd.provider_asset_id = '', 'unclassified',
      has(['usdc','usdt','usdt0','dai','xdai','usd1','usdcx','usdg','usde','usdf','usad','frax','nrusdt'], lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', '')))) AND has(['usdc','usdt','usdt0','dai','xdai','usd1','usdcx','usdg','usde','usdf','usad','frax','nrusdt'], lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', '')))), 'stable_to_stable',
      transform(lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', ''))), ['weth','wnear','wbtc','cbbtc','btc(omni)','wnearkat'], ['eth','near','btc','btc','btc','nearkat'], lowerUTF8(trim(replaceRegexpOne(ro.sym, '\\s*\\(DEPRECATED\\)$', '')))) = transform(lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', ''))), ['weth','wnear','wbtc','cbbtc','btc(omni)','wnearkat'], ['eth','near','btc','btc','btc','nearkat'], lowerUTF8(trim(replaceRegexpOne(rd.sym, '\\s*\\(DEPRECATED\\)$', '')))) AND ro.chain != rd.chain, 'same_asset_cross_chain',
      'volatile_other') AS rt
  FROM nearesis_live.intents_swaps AS s FINAL
  LEFT JOIN reg AS ro ON ro.provider_asset_id = s.origin_asset
  LEFT JOIN reg AS rd ON rd.provider_asset_id = s.destination_asset
  WHERE s.status = 'SUCCESS'
)
SELECT
  formatDateTime(d, '%Y-%m') AS period,
  rt AS grp,
  count() AS n_success,
  countIf(i IS NOT NULL) AS n_with_in_usd,
  toString(sumIf(i, i IS NOT NULL)) AS in_usd_success,
  countIf(u) AS n_usable,
  countIf(a) AS n_artefact,
  toString(sumIf(i, a)) AS artefact_in_usd,
  toString(sumIf(sp, a)) AS artefact_spread_usd,
  countIf(c) AS n_clean,
  toString(sumIf(i, c)) AS clean_in_usd,
  toString(sumIf(sp, c)) AS clean_spread_usd,
  toString(round(if(sumIf(i, c) > 0, sumIf(sp, c) * 10000 / sumIf(i, c), NULL), 6)) AS vw_mean_bps,
  quantilesExact(0.25, 0.5, 0.75)(bps) AS q,
  toString(round(q[2], 6)) AS median_bps,
  toString(round(q[1], 6)) AS p25_bps,
  toString(round(q[3], 6)) AS p75_bps,
  countIf(c AND sp < 0) AS n_negative_spread
FROM base
GROUP BY period, grp
ORDER BY period, grp;
