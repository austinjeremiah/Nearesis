# Certified metrics

<!-- GENERATED from services/analytics/registry by `pnpm --filter @nearesis/analytics metrics:doc`. Do not edit by hand. -->

- Semantic version: `1.0.0`
- Content hash: `eae19975bb631ffbce140781f1b00fb7b6802560b42e2789b4e4a526b6263cd7`
- Metrics: 25 (25 certified)

| Metric | Unit | Kind | Aggregation | Visibility | Certified |
|---|---|---|---|---|---|
| [`agent_market.jobs_completed_if_public`](#agent_marketjobs_completed_if_public) | jobs | flow | sum | aggregate_only | 1.0.0 |
| [`economics.externally_reported_revenue_usd`](#economicsexternally_reported_revenue_usd) | usd | flow | sum | restricted | 1.0.0 |
| [`intents.oneclick_amount_in_smallest_unit`](#intentsoneclick_amount_in_smallest_unit) | smallest_unit | flow | sum | public | 1.0.0 |
| [`intents.oneclick_completed_swap_count`](#intentsoneclick_completed_swap_count) | swaps | flow | sum | public | 1.0.0 |
| [`intents.oneclick_completion_rate`](#intentsoneclick_completion_rate) | ratio | rate | ratio | public | 1.0.0 |
| [`intents.oneclick_failed_swap_count`](#intentsoneclick_failed_swap_count) | swaps | flow | sum | public | 1.0.0 |
| [`intents.oneclick_private_settlement_swap_count`](#intentsoneclick_private_settlement_swap_count) | swaps | flow | sum | aggregate_only | 1.0.0 |
| [`intents.oneclick_refunded_swap_count`](#intentsoneclick_refunded_swap_count) | swaps | flow | sum | public | 1.0.0 |
| [`intents.oneclick_total_swap_count`](#intentsoneclick_total_swap_count) | swaps | flow | sum | public | 1.0.0 |
| [`intents.oneclick_volume_usd`](#intentsoneclick_volume_usd) | usd | flow | sum | public | 1.0.0 |
| [`intents.route_quote_attempt_count`](#intentsroute_quote_attempt_count) | quotes | flow | sum | public | 1.0.0 |
| [`intents.route_quote_availability`](#intentsroute_quote_availability) | ratio | rate | ratio | public | 1.0.0 |
| [`intents.route_quote_cost_bps`](#intentsroute_quote_cost_bps) | bps | rate | avg | public | 1.0.0 |
| [`intents.route_quote_unavailable_slot_count`](#intentsroute_quote_unavailable_slot_count) | slots | flow | sum | public | 1.0.0 |
| [`near.active_contract_count`](#nearactive_contract_count) | contracts | count | non_additive | public | 1.0.0 |
| [`near.contract_interactions_by_taxonomy`](#nearcontract_interactions_by_taxonomy) | interactions | flow | sum | public | 1.0.0 |
| [`near.daily_successful_tx_count`](#neardaily_successful_tx_count) | tx | flow | sum | public | 1.0.0 |
| [`near.distinct_signer_proxy`](#neardistinct_signer_proxy) | signers | count | non_additive | public | 1.0.0 |
| [`near.function_call_action_count`](#nearfunction_call_action_count) | actions | flow | sum | public | 1.0.0 |
| [`near.period_unique_signers`](#nearperiod_unique_signers) | signers | count | count_distinct | public | 1.0.0 |
| [`near.uncategorized_interaction_count`](#nearuncategorized_interaction_count) | interactions | flow | sum | public | 1.0.0 |
| [`near.verified_interaction_count`](#nearverified_interaction_count) | interactions | flow | sum | public | 1.0.0 |
| [`prices.daily_close_price_usd`](#pricesdaily_close_price_usd) | usd_price | stock | avg | public | 1.0.0 |
| [`prices.daily_volume_usd`](#pricesdaily_volume_usd) | usd | flow | sum | public | 1.0.0 |
| [`research.uncategorized_share`](#researchuncategorized_share) | ratio | rate | ratio | public | 1.0.0 |

<a id="agent_marketjobs_completed_if_public"></a>
## agent_market.jobs_completed_if_public

**Completed agent-market jobs (public only)**

- Kind: flow
- Unit: jobs
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `external-report:agent_market_jobs`
- Transformations: `Completed jobs for markets that publish them`
- Expected update lag: P1D
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: aggregate_only
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#agent_marketjobs_completed_if_public
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Only markets that publish completions are counted.
- Cube member: agent_market.jobs_completed_if_public

<a id="economicsexternally_reported_revenue_usd"></a>
## economics.externally_reported_revenue_usd

**Externally reported revenue (USD)**

- Kind: flow
- Unit: usd
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `external-report:economics_reports`
- Transformations: `Revenue figures reported by a named external party, unaudited`
- Expected update lag: P7D
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: restricted
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#economicsexternally_reported_revenue_usd
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Unaudited third-party claim; shown as reported.
- Cube member: economics.externally_reported_revenue_usd
- Exact decimal scale: 18

<a id="intentsoneclick_amount_in_smallest_unit"></a>
## intents.oneclick_amount_in_smallest_unit

**1Click completed origin amount (smallest unit)**

- Kind: flow
- Unit: smallest_unit
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Exact decimal sum of origin amounts in smallest units; group by canonical origin asset`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_amount_in_smallest_unit
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Different assets have different decimals; only compare within one canonical asset.
- Cube member: intents.oneclick_amount_in_smallest_unit
- Exact decimal scale: 0

<a id="intentsoneclick_completed_swap_count"></a>
## intents.oneclick_completed_swap_count

**1Click completed swaps**

- Kind: flow
- Unit: swaps
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Swaps with latest status SUCCESS`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_completed_swap_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Status is provider-reported and may change until final.
- Cube member: intents.oneclick_completed_swap_count

<a id="intentsoneclick_completion_rate"></a>
## intents.oneclick_completion_rate

**1Click completion rate**

- Kind: rate
- Unit: ratio
- Grain: day
- Aggregation law: ratio
- Denominator: intents.oneclick_total_swap_count
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `completed swaps / all swaps`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_completion_rate
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: In-flight swaps count in the denominator until they settle.
- Cube member: intents.oneclick_completion_rate

<a id="intentsoneclick_failed_swap_count"></a>
## intents.oneclick_failed_swap_count

**1Click failed swaps**

- Kind: flow
- Unit: swaps
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Swaps with latest status FAILED`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_failed_swap_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Provider-reported status.
- Cube member: intents.oneclick_failed_swap_count

<a id="intentsoneclick_private_settlement_swap_count"></a>
## intents.oneclick_private_settlement_swap_count

**1Click completed private-settlement swaps**

- Kind: flow
- Unit: swaps
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Completed swaps with privacy era private_settlement (created on or after 2026-10-27)`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: aggregate_only
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_private_settlement_swap_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Private-era swaps cannot be reconciled to public swap hashes (D09).
- Cube member: intents.oneclick_private_settlement_swap_count

<a id="intentsoneclick_refunded_swap_count"></a>
## intents.oneclick_refunded_swap_count

**1Click refunded swaps**

- Kind: flow
- Unit: swaps
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Swaps with latest status REFUNDED`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_refunded_swap_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Provider-reported status.
- Cube member: intents.oneclick_refunded_swap_count

<a id="intentsoneclick_total_swap_count"></a>
## intents.oneclick_total_swap_count

**1Click swaps (all statuses)**

- Kind: flow
- Unit: swaps
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Explorer 1Click swaps deduplicated by swap key, latest status wins`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_total_swap_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Provider-reported; late status updates can move swaps between statuses.
- Cube member: intents.oneclick_total_swap_count

<a id="intentsoneclick_volume_usd"></a>
## intents.oneclick_volume_usd

**1Click completed volume (USD)**

- Kind: flow
- Unit: usd
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:intents_swaps`
- Transformations: `Sum of provider USD value of origin amount for completed swaps with a final amount; single leg only`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: overlapping
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsoneclick_volume_usd
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Provider USD valuation; multi-leg routes are not deduplicated here, so do not add across legs.
- Cube member: intents.oneclick_volume_usd
- Exact decimal scale: 18

<a id="intentsroute_quote_attempt_count"></a>
## intents.route_quote_attempt_count

**Dry quote attempts observed**

- Kind: flow
- Unit: quotes
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:quote_attempts`
- Transformations: `Observed dry quote attempts on the scheduled grid`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsroute_quote_attempt_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Dry quotes, not executed swaps.
- Cube member: quotes.route_quote_attempt_count

<a id="intentsroute_quote_availability"></a>
## intents.route_quote_availability

**Route quote availability**

- Kind: rate
- Unit: ratio
- Grain: day
- Aggregation law: ratio
- Denominator: quote grid slots
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:quote_attempts`
- Transformations: `OK attempts / all grid slots`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsroute_quote_availability
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Availability of dry quotes on the sampled grid only.
- Cube member: quotes.route_quote_availability

<a id="intentsroute_quote_cost_bps"></a>
## intents.route_quote_cost_bps

**Route quote cost (bps)**

- Kind: rate
- Unit: bps
- Grain: day
- Aggregation law: avg
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:quote_attempts`
- Transformations: `Mean quote cost versus the declared benchmark over OK attempts`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsroute_quote_cost_bps
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Benchmark choice drives the sign and size; unweighted mean of attempts.
- Cube member: quotes.route_quote_cost_bps

<a id="intentsroute_quote_unavailable_slot_count"></a>
## intents.route_quote_unavailable_slot_count

**Missed quote grid slots**

- Kind: flow
- Unit: slots
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `intents-1click:quote_attempts`
- Transformations: `Grid slots with no attempt; never backfilled`
- Expected update lag: PT1H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#intentsroute_quote_unavailable_slot_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Missed slots are gaps, not failures of the route.
- Cube member: quotes.route_quote_unavailable_slot_count

<a id="nearactive_contract_count"></a>
## near.active_contract_count

**Daily active contracts**

- Kind: count
- Unit: contracts
- Grain: day
- Aggregation law: non_additive
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:near_daily_usage`
- Transformations: `Daily distinct receiver contracts with a successful call`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: overlapping
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearactive_contract_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Daily distinct values overlap across days and cannot be summed.
- Cube member: near_usage.active_contract_count

<a id="nearcontract_interactions_by_taxonomy"></a>
## near.contract_interactions_by_taxonomy

**Contract interactions by taxonomy**

- Kind: flow
- Unit: interactions
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:contract_interactions`
- Transformations: `Receipts joined to the effective-dated contract registry; verified mappings only`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: disjoint
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearcontract_interactions_by_taxonomy
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Taxonomy covers verified registry entries only; the rest is uncategorized or unverified.
- Cube member: taxonomy.contract_interactions_by_taxonomy

<a id="neardaily_successful_tx_count"></a>
## near.daily_successful_tx_count

**Daily successful transactions**

- Kind: flow
- Unit: tx
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:near_daily_usage`
- Transformations: `BigQuery block_date aggregation of successful transactions`
- Expected update lag: PT24H
- Bot-proxy definition: Not filtered; includes bot and system traffic
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#neardaily_successful_tx_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Counts transactions, not users; bot traffic is included.
- Cube member: near_usage.daily_successful_tx_count

<a id="neardistinct_signer_proxy"></a>
## near.distinct_signer_proxy

**Daily distinct signer proxy**

- Kind: count
- Unit: signers
- Grain: day
- Aggregation law: non_additive
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:near_daily_usage`
- Transformations: `Daily distinct signer accounts from BigQuery`
- Expected update lag: PT24H
- Bot-proxy definition: Signer accounts are a proxy for activity, not unique humans
- Visibility: public
- Segment overlap: overlapping
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#neardistinct_signer_proxy
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Not unique humans. Daily values must never be summed into a period unique; use near.period_unique_signers.
- Cube member: near_usage.distinct_signer_proxy

<a id="nearfunction_call_action_count"></a>
## near.function_call_action_count

**Daily function call actions**

- Kind: flow
- Unit: actions
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:near_daily_usage`
- Transformations: `BigQuery block_date aggregation of FunctionCall actions`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearfunction_call_action_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: A transaction may carry several actions.
- Cube member: near_usage.function_call_action_count

<a id="nearperiod_unique_signers"></a>
## near.period_unique_signers

**Period unique signers**

- Kind: count
- Unit: signers
- Grain: day
- Aggregation law: count_distinct
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:near_signer_days`
- Transformations: `Exact count(distinct signer) over signer-day pairs within the period`
- Expected update lag: PT24H
- Bot-proxy definition: Signer accounts are a proxy for activity, not unique humans
- Visibility: public
- Segment overlap: overlapping
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearperiod_unique_signers
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Exact distinct count of signer accounts in the period; not unique humans.
- Cube member: near_signers.period_unique_signers

<a id="nearuncategorized_interaction_count"></a>
## near.uncategorized_interaction_count

**Uncategorized interactions**

- Kind: flow
- Unit: interactions
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:contract_interactions`
- Transformations: `Interactions whose receiver has no verified taxonomy mapping`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: disjoint
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearuncategorized_interaction_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Depends on registry coverage, which grows over time.
- Cube member: taxonomy.uncategorized_interaction_count

<a id="nearverified_interaction_count"></a>
## near.verified_interaction_count

**Verified-segment interactions**

- Kind: flow
- Unit: interactions
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:contract_interactions`
- Transformations: `Interactions whose receiver has a verified taxonomy mapping`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: disjoint
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#nearverified_interaction_count
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Verification is by registry evidence, not by on-chain proof.
- Cube member: taxonomy.verified_interaction_count

<a id="pricesdaily_close_price_usd"></a>
## prices.daily_close_price_usd

**Daily close price (USD)**

- Kind: stock
- Unit: usd_price
- Grain: day
- Aggregation law: avg
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `coingecko:price_candles`
- Transformations: `Latest update vintage per daily candle`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#pricesdaily_close_price_usd
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Aggregator price; vintages can be revised.
- Cube member: prices.daily_close_price_usd

<a id="pricesdaily_volume_usd"></a>
## prices.daily_volume_usd

**Daily volume (USD)**

- Kind: flow
- Unit: usd
- Grain: day
- Aggregation law: sum
- Denominator: n/a: additive count or level with no denominator
- Zero policy: zero_requires_complete_coverage
- Sources: `coingecko:price_candles`
- Transformations: `Provider-reported volume of the latest vintage`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#pricesdaily_volume_usd
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Provider-reported volume across venues.
- Cube member: prices.daily_volume_usd
- Exact decimal scale: 18

<a id="researchuncategorized_share"></a>
## research.uncategorized_share

**Uncategorized share**

- Kind: rate
- Unit: ratio
- Grain: day
- Aggregation law: ratio
- Denominator: near.contract_interactions_by_taxonomy
- Zero policy: zero_requires_complete_coverage
- Sources: `near-bigquery:contract_interactions`
- Transformations: `uncategorized interactions / all interactions`
- Expected update lag: PT24H
- Bot-proxy definition: n/a: not a per-actor metric, bot traffic is not separated
- Visibility: public
- Segment overlap: n/a
- Certified version: 1.0.0
- Owner: nearesis-analytics
- Doc URI: docs/metrics/METRICS.md#researchuncategorized_share
- Test fixture: fx.snapshot.p02-baseline
- Uncertainty: Ratio of sums over the period, not a mean of daily ratios.
- Cube member: taxonomy.uncategorized_share

