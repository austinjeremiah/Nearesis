# User-paid spread and app fees measured from our own swap data

Produced 2026-11-14 by `pnpm thesis:spread spread` and `pnpm thesis:spread appfees` (`services/ingestion/src/thesis/spread-cli.ts`, pure parts in `spread-core.ts`, tests in `services/ingestion/test/unit/spread-core.test.ts`). Read-only: ClickHouse SELECTs on `nearesis_live` and local reads of archived raw Explorer pages. Each output has its executed SQL (`.sql`) and sha256 (`.sha256`) beside it.

| Output | sha256 (json) |
|---|---|
| `spread_daily.json` | 68b18c855f81631573935c504658d979c1e3744f5760e35033877391fec3cd23 |
| `spread_by_route_type_monthly.json` | 8ed0fbdef7b6757eb9d1b1b6d43e3d3d1c32df5c09d0f639a4b228d40c83a4e6 |
| `spread_headline_windows.json` | 4ef6b15e7680e896b1d8442b1818dfb08c9ee84bfcc632de2cfdd9b978359f85 |
| `visibility_by_leg_type_monthly.json` | 22231cc8965690569392b53239a801f7ea9872a8fc3a855c3e230d84a5d5fbb9 |
| `app_fees_daily.json` | 7563b4d0e04b6a41aed15ed685a761e3941d0272863a2eec3c4350806ccf511e |
| `app_fee_recipients_top.json` | 178a615030f4b715fa716e92d7cdc42f4a45e9dc20c62a63432960d1a734ae3d |
| `raw_field_census.json` | 583acb9e79f5a4c2395c4a7c6553aa23b762abd4dbc0657ee7576c4819f873bd |

The `.sha256` file beside each output is authoritative. Windows: first 90 days = 2025-11-09 to 2026-02-06 (data starts 2025-11-09); last 90 days = 2026-08-16 to 2026-11-13 (2026-11-14 is a partial day and is excluded from both windows). The "year" is these 371 days of data.

## Definitions

- Population: `intents_swaps FINAL`, `status = 'SUCCESS'` (7,053,122 swaps, $12,598,297,993 of input USD).
- Spread (USD) = `amount_in_usd - amount_out_usd`. Spread (bps) = spread / `amount_in_usd` x 10,000. Both are the Explorer's own USD marks (provider prices). Positive = the user received less value than they put in.
- Usable: both marks present and > 0. Artefact: usable and |spread| > 20% of input; reported separately in `artefact_*` columns, never dropped silently, and excluded from all spread statistics. Clean = usable and not artefact.
- Volume-weighted mean = sum(clean spread USD) x 10,000 / sum(clean input USD). Median, p25, p75 are over per-swap bps (computed in float64, rounded to 6 dp); USD sums are exact decimals.
- Route types (mutually exclusive, in this order; symbols from `asset_registry` for provider `intents-1click`, matched on the asset ids; "(DEPRECATED)" suffix and case ignored):
  1. `unclassified`: either asset id is not in `asset_registry` (0.01% of volume).
  2. `stable_to_stable`: both symbols in {USDC, USDT, USDT0, DAI, xDAI, USD1, USDCx, USDG, USDe, USDf, USAD, FRAX, nrUsdt}, any chains (so USDC eth to USDC base is included, as is USDC to USDT).
  3. `same_asset_cross_chain`: same asset family (WETH=ETH, wNEAR=NEAR, WBTC/cbBTC/BTC(OMNI)=BTC) and different blockchains: bridge-like.
  4. `volatile_other`: everything else (includes ETH to USDC, BTC to SOL, NEAR to anything, yield-bearing and gold tokens).
- Missing days: none. Every one of the 371 days 2025-11-09 to 2026-11-14 has SUCCESS swaps (list in `spread_daily.json` `missing_periods` is empty).

## Coverage (year, all route types)

- 7,053,122 SUCCESS swaps; 6,926,428 clean (98.2% of swaps); 112,623 artefacts (1.6%); 14,071 not usable (a mark missing or zero).
- Clean input volume $12,597.7M of $12,598.3M = 99.995% of volume (artefact rows carry only $0.58M of input volume: they are tiny swaps with wild marks; their summed spread is -$5.69M, i.e. output marked far above input, reported separately and not netted into anything).
- By route: stable_to_stable 1,708,433 swaps / $4,390.5M (34.8% of volume); volatile_other 5,047,662 / $7,832.5M (62.2%); same_asset_cross_chain 295,398 / $375.1M (3.0%); unclassified about $0.1M (0.001%).
- 323,216 clean swaps (4.7%) have a negative spread (user received more than marked input): price drift between quote and fill, or rounding in marks. They stay in.

## Headline numbers (clean spread; USD from exact sums)

| | First 90 days | Last 90 days |
|---|---|---|
| Swaps (SUCCESS) / clean | 1,529,133 / 1,493,180 | 1,942,174 / 1,916,716 |
| Input volume (SUCCESS) | $2,895.7M | $3,926.9M |
| All routes: vol-weighted spread | 68.06 bps | 57.78 bps |
| All routes: median | 45.88 bps | 71.96 bps |
| All routes: spread USD per day | $218,955 | $252,110 |
| All routes: implied annualised toll (x365) | $79.9M | $92.0M |
| Stable to stable: vol-weighted | 7.46 bps | 14.42 bps |
| Stable to stable: median | 24.95 bps | 9.50 bps |
| Stable to stable: spread USD per day | $4,617 | $24,962 |
| Stable to stable: implied annualised | $1.69M | $9.11M |
| Stable to stable: input volume | $556.8M | $1,557.6M |
| Volatile other: vol-weighted | 83.74 bps | 90.07 bps |
| Same-asset cross-chain: vol-weighted | 55.34 bps | 20.48 bps |

Whole year (clean): $71.8M spread on $12,597.7M, 56.99 bps; stable_to_stable $5.92M (13.49 bps), volatile_other $64.78M (82.71 bps), same_asset_cross_chain $1.09M (29.17 bps).

Reading: stablecoin volume rose almost threefold between the windows, so the stable-to-stable toll in USD rose 5x while its median per swap fell: small stable swaps pay about 20 bps (the documented 1Click rate with an API key) and large ones pay 1 to 10 bps, which is why the weighted mean (7 to 14 bps) sits below or above the median depending on the mix of large swaps. Monthly series are in `spread_by_route_type_monthly.json`. Volatile pairs pay about 80 to 95 bps weighted; part of that is price movement and real market-making spread, not a toll, and it cannot be separated here.

## What the measured toll contains, and its size against NEAR

App fees (raw Explorer pages, section below) explain most of it: $14.84M of the $19.71M first-window spread (75%) and $17.25M of the $22.69M last-window spread (76%). The rest (about 24%) is the 1Click base fee not shown as an app fee (if it is not itself an app-fee entry), the solver spread, the 1-pip protocol fee, and price noise.

What the fee model says reaches NEAR (see `FEE_MODEL.md`): (a) the 1-pip contract fee, negligible (about $12.6k per $12.6B of volume); (b) the fee-switch share of protocol/distribution fees, reported only as "protocol fee capture 11.5% lifetime, 17.9% trailing 90 days, 30.5% trailing 30 days" with no defined base, and "over $1M" to buybacks by 2026-02-24; (c) NEAR gas, covered elsewhere. Measured in our data: the app-fee recipient `buybacks.multisignature.near` (role inferred from its name only) received $2.09M over the year in 1,090,921 fee entries, almost all of it in the last 90 days ($1.13M; $0 in the first 90), mostly at 1 to 5 bps per swap. Annualised from the last window that is about $4.6M a year, about 5% of the $92M annualised measured user toll and about 6.5% of the annualised app-fee total ($70.0M). NON-OFFICIAL forum figures (HSP-029 thread): $3.07M net to buybacks in Q3 2026, about $12M annualised, 3 to 4 times our recipient measure; the gap is consistent with part of the buyback flow arriving as 1Click-side revenue that is not an `appFees` entry. Either way, the share of the user toll that is visible as reaching NEAR is in the single-digit percent range; a 30% share applied to the 1Click-side base would be an upper bound that we cannot confirm.

## Raw Explorer fields (7,203,005 items read from 7,220 archived pages; every item has all non-optional fields)

Per swap: `originAsset`, `destinationAsset`, `depositAddress`, `depositMemo` (string or null), `depositAddressAndMemo`, `recipient`, `status`, `createdAt`, `createdAtTimestamp` (number), `intentHashes` (string), `referral` (string or null), `amountInFormatted`, `amountOutFormatted`, `amountIn`, `amountOut` (smallest unit strings), `amountInUsd`, `amountOutUsd` (strings), `appFees` (array of `{recipient: string, fee: number}`), `nearTxHashes`, `originChainTxHashes`, `destinationChainTxHashes` (arrays of strings), `refundTo` (string), `senders` (array of strings), `refundReason` (string or null), `refundFee`, `refundFeeFormatted` (string or null), `depositType`, `recipientType`, `refundType` (enums). Counts and types per field: `raw_field_census.json`. Example (public, non-secret): `appFees: [{"recipient":"trustswapkit.near","fee":70}]`, `referral: "swapkit"`.

Fee-related fields that exist in raw pages but are NOT loaded into ClickHouse: `appFees` (recipients and bps), `refundFee` / `refundFeeFormatted`, `refundReason`, `senders`, `recipient`, `refundTo`, `nearTxHashes` (only the public subset is loaded as `public_swap_tx_hashes`). Loaded: `referral`, USD marks, raw amounts, the three type enums.

Also in archived 1Click quote responses (`.data/scheduler/raw`, hash in `quote_attempts.raw_object_hash`): `quote.refundFee`, `quote.withdrawFee`, `quote.timeEstimate`, and the echoed `quoteRequest.appFees` (our requests carry none). Dry quotes expose no explicit fee-rate field: the cost is only visible as `amountInUsd - amountOutUsd`.

## App fees (measurable)

`appFees` is present on every raw item (array, empty when none), so per-swap app fees are measurable. Fee USD = input USD x `fee` / 10,000 for each entry (fee is integer bps per the 1Click docs). SUCCESS swaps only; each swap counted once from the latest page that contains it; 7,184,440 distinct swaps (equals the ClickHouse row count) and 7,053,121 SUCCESS (ClickHouse has 7,053,122; one swap differs, unexplained). The `appFees` list shows integrator entries; whether 1Click's own share is also an entry is unclear (open question in `FEE_MODEL.md`), so these are app fees as listed, not all fees.

| | First 90 days | Last 90 days | Whole data |
|---|---|---|---|
| SUCCESS swaps | 1,529,167 | 1,942,174 | 7,053,121 |
| Swaps with an app fee | 860,534 (56%) | 1,630,666 (84%) | 4,724,777 (67%) |
| App fee USD | $14.84M | $17.25M | $53.34M |
| App fee USD per day | $164,838 | $191,711 | $143,767 |
| App fee as bps of all input volume | 51.2 | 43.9 | 42.3 |

(The first-window swap count differs by 34 from the spread query because the app-fee scan keys days on the raw `createdAt` UTC date and ClickHouse on `created_day`.) Non-SUCCESS swaps carrying an app fee (not charged here): REFUNDED 93,353, FAILED 3,712, PROCESSING 310.

Top fee recipients by USD over the data (958 distinct recipients; top 15 shares in `app_fee_recipients_top.json`): `ledgerswapkit.near` $23.08M (43.3%, mostly 140 to 145 bps), `trustswapkit.near` $10.06M (18.9%, 70 bps), `zodlswaps.near` $3.32M (6.2%, 67 bps), `thorswap.near` $2.43M (4.6%), `fefundsadmin.sputnik-dao.near` $2.20M (4.1%, the near-intents.org front-end account per the fees page), `buybacks.multisignature.near` $2.09M (3.9%), `electriccoinco.near` $1.67M (3.1%), `tangemswapkit.near` $1.05M (2.0%). Top referral labels by attached app-fee USD: `swapkit` 76.3% (of the sum over referral-labelled swaps), `zodl`, `zashi`, `near-intents.intents-referral.near`, `new.intents-referral.near`, `rango`, `lifi`, `vizor`. A label is not a payee; the payees are the recipients above. Recipients are NEAR account ids and unlabelled 64-hex implicit accounts; identity beyond the names is not known.

## Caveats

1. USD marks on the two legs are provider prices at possibly different times; the spread is signed noise around the true toll, especially for volatile pairs (the monthly VW rises and falls with market moves). Stable-to-stable is the cleanest read but still includes de-peg and timing noise.
2. The spread is all-in: solver spread, 1Click base fee, app fee, protocol fee, any gas or withdrawal cost embedded in the output amount, and quote-improvement splitting. It cannot be decomposed except for the app-fee part, which is observable.
3. Medians are of per-swap bps and are not weighted; small swaps dominate them. The volume-weighted mean is dominated by large swaps. Both are given on purpose.
4. Explorer shows no `CONFIDENTIAL_INTENTS` leg in any row of our data (0 of 7,184,440), so confidential-intents flow, which official sources say is a "large and growing share" of near.com swap volume, is absent: all numbers here describe the public part only. Visible weekly volume was about $335M to $371M in Sept 2026 and $224M to $290M from Oct 2026 (`visibility_by_leg_type_monthly.json` and ClickHouse); the cause (private settlement, seasonality or market) cannot be determined from this data. Rows labelled `privacy_era = private_settlement` (from 2026-10-27) still carry full USD marks and leg types, so the Explorer kept reporting those swaps.
5. 2026-11-14 is a partial day and is excluded from the headline windows (it appears in daily and monthly outputs).
6. Dry quotes (`quote_attempts`, 1,142 OK quotes, 11 routes, 2026-11-12 to 2026-11-14, sizes $10 to $10,000) are a different measure: ETH to USDC.base about 30 to 34 bps; USDT.eth to USDC.arb about 6 to 11 bps at $10 to $100 falling to about 6 at $1,000+; USDC.base to USDC.sol about 216 bps at $10, 23 at $100, 3.6 at $1,000, 1.7 at $10,000. They show a size-dependent fixed-cost component on small tickets.

## What cannot be known from our data

- The split of the spread into solver margin, 1Click base fee, protocol fee and noise.
- Whether 1Click's share is an `appFees` entry, and who ultimately owns each recipient account.
- How much of the fee switch is paid to NEAR and when, beyond the one recipient account whose name suggests buybacks.
- Anything about confidential swaps (volume, fees, spread).
