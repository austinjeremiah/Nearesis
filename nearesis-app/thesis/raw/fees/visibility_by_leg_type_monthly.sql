SELECT formatDateTime(created_day, '%Y-%m') AS month, privacy_era, deposit_type, recipient_type, count() AS n_success,
  toString(sum(amount_in_usd)) AS in_usd, countIf(amount_in_usd IS NULL) AS n_no_in_usd
FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS'
GROUP BY month, privacy_era, deposit_type, recipient_type ORDER BY month, privacy_era, deposit_type, recipient_type
