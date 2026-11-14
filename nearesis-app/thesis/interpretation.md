<!--
Authored analysis for the reference thesis. One block per section id; a heading with no text is ignored.
Rules: each number is followed on the same line by a pointer in the form [file#pointer] (see build/FACTS.md for every citable
number with its pointer and meaning). Write numbers to three significant digits, in thousands, millions or billions, or as a
percent of a share; the build checks them against the value behind the pointer and fails otherwise. Forward-looking words
(will, forecast, expect) are allowed; causal words (causes, drives, leads to, caused by, driven by) and hype are not.
Blocks appear at the top of their section, labelled Analysis, above the computed lines.
-->

## executive-claim

NEAR Intents now settles about 36.4 million dollars of public flow a day [raw/forecast.json#/series/intents_usd/last30], and 93.1% of that value [raw/forecast.json#/series/no_near_share/last30] moves between assets that do not live on NEAR. The people who move it pay a real toll: over the last thirty days the measured user-paid spread was 59.4 cents for every hundred dollars settled [raw/forecast.json#/derived/toll_split/rows/2/centsPer100Usd/last30], and integrator app fees alone were 47.8 cents [raw/forecast.json#/derived/toll_split/rows/1/centsPer100Usd/last30] of it. NEAR's own cut, the gas its Intents contracts burn, was 0.0918 cents [raw/forecast.json#/derived/toll_split/rows/0/centsPer100Usd/last30] per hundred dollars: less than a fifth of one percent of what users pay to cross the booth.

The forecast says the gap stays open. A year out, the spread users pay is forecast at 64.5 cents per hundred dollars [raw/forecast.json#/derived/toll_split/rows/2/centsPer100Usd/plus365/central], while the gas NEAR keeps is forecast flat at 0.0808 cents [raw/forecast.json#/derived/toll_split/rows/0/centsPer100Usd/plus365/central]. Volume can keep growing and the network can keep shrinking as a consumer chain, and NEAR the token will still be paid almost nothing per dollar settled, unless the fee switch the protocol announced turns into a visible, growing flow back to NEAR. That is the toll booth problem, and it is the number to watch.

<!-- Executive claim. Pointers used by the computed text of this section (24):
  raw/forecast.json#/series/intents_usd/last30
  raw/forecast.json#/series/intents_usd/horizons/2/central
  raw/forecast.json#/series/intents_usd/horizons/2/horizon
  raw/forecast.json#/series/intents_usd/horizons/2/band80/0
  raw/forecast.json#/series/intents_usd/horizons/2/band80/1
  raw/forecast.json#/series/no_near_share/last30
  raw/forecast.json#/series/no_near_share/horizons/2/central
  raw/forecast.json#/derived/crossover/last30A
  raw/forecast.json#/derived/crossover/last30B
  raw/forecast.json#/derived/crossover/centralDate
  raw/forecast.json#/derived/crossover/within6Months
  raw/forecast.json#/derived/crossover/within12Months
  raw/forecast.json#/method/config/horizons/2
  raw/forecast.json#/method/config/reportHorizons/1
  raw/forecast.json#/method/config/reportHorizons/2
  raw/forecast.json#/series/intents_tx/verdict
  raw/forecast.json#/series/tail_tx/verdict
  raw/forecast.json#/series/tail_signers/verdict
  raw/forecast.json#/series/intents_usd/verdict
  raw/forecast.json#/series/usd_per_tail_signer/verdict
  raw/forecast.json#/series/stable_share/verdict
  raw/forecast.json#/series/no_near_share/verdict
  raw/forecast.json#/series/near_token_share/verdict
  raw/forecast.json#count(/series)
-->

## what-would-change-our-mind

- If NEAR's gas take rises above 0.187 cents per hundred dollars settled [raw/forecast.json#/series/take_rate_gas/checkpoints/0/band80/1] at the first checkpoint, the claim that NEAR's cut stays flat is wrong.
- If the share of settled value that touches no NEAR asset falls below 89.1% [raw/forecast.json#/series/no_near_share/horizons/0/band80/0] within ninety days, NEAR assets are being used again and the "booth for other chains" framing weakens.
- If the fee switch starts routing a visible and growing share of the toll to NEAR-aligned recipients (buybacks, the treasury, stakers), the problem is being solved and the thesis should be rewritten around how fast. Our swap records show such a recipient only in the second half of the year and only under one account name, so this is the outcome most likely to prove us wrong.

<!-- What would change our mind. Pointers used by the computed text of this section (15):
  raw/forecast.json#/series/intents_tx/checkpoints/0/against/bound
  raw/forecast.json#/series/intents_tx/checkpoints/1/against/bound
  raw/forecast.json#/series/intents_tx/checkpoints/2/against/bound
  raw/forecast.json#/series/tail_signers/checkpoints/0/against/bound
  raw/forecast.json#/series/tail_signers/checkpoints/1/against/bound
  raw/forecast.json#/series/tail_signers/checkpoints/2/against/bound
  raw/forecast.json#/series/intents_usd/checkpoints/0/against/bound
  raw/forecast.json#/series/intents_usd/checkpoints/1/against/bound
  raw/forecast.json#/series/intents_usd/checkpoints/2/against/bound
  raw/forecast.json#/series/stable_share/checkpoints/0/against/bound
  raw/forecast.json#/series/stable_share/checkpoints/1/against/bound
  raw/forecast.json#/series/stable_share/checkpoints/2/against/bound
  raw/forecast.json#/derived/crossover/twelveMonthsDate
  raw/forecast.json#/derived/crossover/within12Months
  raw/forecast.json#/derived/stable_share_threshold/within12Months
-->

## sample-and-sources

<!-- Sample and sources. Pointers used by the computed text of this section (89):
  raw/manifest.json#/window/from
  raw/manifest.json#/window/to
  raw/forecast.json#count(/series/intents_tx/observedDays)
  raw/manifest.json#/frozenAt
  raw/manifest.json#/methodFrozenAt
  raw/manifest.json#/datasets/0/title
  raw/manifest.json#/datasets/0/rows
  raw/manifest.json#/datasets/0/source
  raw/manifest.json#/datasets/0/bigQueryBytesBilled
  raw/manifest.json#/datasets/1/title
  raw/manifest.json#/datasets/1/rows
  raw/manifest.json#/datasets/1/source
  raw/manifest.json#/datasets/1/bigQueryBytesBilled
  raw/manifest.json#/datasets/2/title
  raw/manifest.json#/datasets/2/rows
  raw/manifest.json#/datasets/2/source
  raw/manifest.json#/datasets/2/bigQueryBytesBilled
  raw/manifest.json#/datasets/3/title
  raw/manifest.json#/datasets/3/rows
  raw/manifest.json#/datasets/3/source
  raw/manifest.json#/datasets/4/title
  raw/manifest.json#/datasets/4/rows
  raw/manifest.json#/datasets/4/source
  raw/manifest.json#/datasets/5/title
  raw/manifest.json#/datasets/5/rows
  raw/manifest.json#/datasets/5/source
  raw/manifest.json#/datasets/6/title
  raw/manifest.json#/datasets/6/rows
  raw/manifest.json#/datasets/6/source
  raw/manifest.json#/datasets/7/title
  raw/manifest.json#/datasets/7/rows
  raw/manifest.json#/datasets/7/source
  raw/manifest.json#/datasets/8/title
  raw/manifest.json#/datasets/8/rows
  raw/manifest.json#/datasets/8/source
  raw/manifest.json#/datasets/9/title
  raw/manifest.json#/datasets/9/rows
  raw/manifest.json#/datasets/9/source
  raw/manifest.json#/datasets/10/title
  raw/manifest.json#/datasets/10/rows
  ... and 49 more; see build/FACTS.md
-->

## methods

<!-- Methods. Pointers used by the computed text of this section (25):
  raw/forecast.json#/method/config/trailing
  raw/forecast.json#/method/config/phi
  raw/forecast.json#/method/config/originStep
  raw/forecast.json#/method/config/firstOrigin
  raw/forecast.json#/method/config/horizons/0
  raw/forecast.json#/method/config/horizons/1
  raw/forecast.json#/method/config/horizons/2
  raw/forecast.json#/method/config/paths
  raw/forecast.json#/method/config/block
  raw/forecast.json#/inputHash
  raw/forecast.json#/method/config/skillThreshold
  raw/forecast.json#/method/config/calibrationRange/0
  raw/forecast.json#/method/config/calibrationRange/1
  raw/manifest.json#/datasets/1/title
  raw/manifest.json#/datasets/1/definition
  raw/manifest.json#/datasets/0/title
  raw/manifest.json#/datasets/0/definition
  raw/manifest.json#/datasets/4/title
  raw/manifest.json#/datasets/4/definition
  raw/manifest.json#/datasets/6/title
  raw/manifest.json#/datasets/6/definition
  raw/manifest.json#/datasets/3/title
  raw/manifest.json#/datasets/3/definition
  raw/manifest.json#/datasets/10/title
  raw/manifest.json#/datasets/10/definition
-->

## primary-benchmark

<!-- Primary benchmark. Pointers used by the computed text of this section (181):
  raw/forecast.json#count(/series/intents_tx/backtest/origins)
  raw/forecast.json#/series/intents_tx/backtest/table/2/mae
  raw/forecast.json#/series/intents_tx/backtest/table/9/mae
  raw/forecast.json#/series/intents_tx/backtest/table/10/mae
  raw/forecast.json#/series/intents_tx/backtest/table/11/mae
  raw/forecast.json#/series/intents_tx/skill90
  raw/forecast.json#/series/intents_tx/calibration/pooledForward80
  raw/forecast.json#/series/intents_tx/verdict
  raw/forecast.json#/series/tail_tx/backtest/table/2/mae
  raw/forecast.json#/series/tail_tx/backtest/table/12/mae
  raw/forecast.json#/series/tail_tx/backtest/table/13/mae
  raw/forecast.json#/series/tail_tx/backtest/table/14/mae
  raw/forecast.json#/series/tail_tx/skill90
  raw/forecast.json#/series/tail_tx/calibration/pooledForward80
  raw/forecast.json#/series/tail_tx/verdict
  raw/forecast.json#/series/tail_signers/backtest/table/2/mae
  raw/forecast.json#/series/tail_signers/backtest/table/6/mae
  raw/forecast.json#/series/tail_signers/backtest/table/7/mae
  raw/forecast.json#/series/tail_signers/backtest/table/8/mae
  raw/forecast.json#/series/tail_signers/skill90
  raw/forecast.json#/series/tail_signers/calibration/pooledForward80
  raw/forecast.json#/series/tail_signers/verdict
  raw/forecast.json#/series/intents_usd/backtest/table/2/mae
  raw/forecast.json#/series/intents_usd/backtest/table/0/mae
  raw/forecast.json#/series/intents_usd/backtest/table/1/mae
  raw/forecast.json#/series/intents_usd/skill90
  raw/forecast.json#/series/intents_usd/calibration/pooledForward80
  raw/forecast.json#/series/intents_usd/verdict
  raw/forecast.json#/series/usd_per_tail_signer/backtest/table/2/mae
  raw/forecast.json#/series/usd_per_tail_signer/backtest/table/12/mae
  raw/forecast.json#/series/usd_per_tail_signer/backtest/table/13/mae
  raw/forecast.json#/series/usd_per_tail_signer/backtest/table/14/mae
  raw/forecast.json#/series/usd_per_tail_signer/skill90
  raw/forecast.json#/series/usd_per_tail_signer/calibration/pooledForward80
  raw/forecast.json#/series/usd_per_tail_signer/verdict
  raw/forecast.json#/series/stable_share/backtest/table/2/mae
  raw/forecast.json#/series/stable_share/backtest/table/0/mae
  raw/forecast.json#/series/stable_share/backtest/table/1/mae
  raw/forecast.json#/series/stable_share/skill90
  raw/forecast.json#/series/stable_share/calibration/pooledForward80
  ... and 141 more; see build/FACTS.md
-->

## evidence-for

- NEAR's cut is tiny next to the toll: 0.0918 cents of gas [raw/forecast.json#/derived/toll_split/rows/0/centsPer100Usd/last30] against 59.4 cents of spread [raw/forecast.json#/derived/toll_split/rows/2/centsPer100Usd/last30] per hundred dollars over the last thirty days.
- The NEAR token is a leg of only 2.46% of settled value [raw/forecast.json#/series/near_token_share/last30], forecast at 1.85% [raw/forecast.json#/series/near_token_share/horizons/0/central] in ninety days; the flow does not need the token.
- The flow is turning into a dollar rail: stablecoin-to-stablecoin swaps were 7.22% of value [raw/forecast.json#/facts/monthly/0/stable_share] in the first month of the data and 35.7% [raw/forecast.json#/facts/monthly/12/stable_share] in the latest.
- The consumer chain underneath is shrinking: long-tail signers averaged 240 thousand a day [raw/forecast.json#/facts/monthly/0/tail_signers] in the first month and 64.6 thousand [raw/forecast.json#/series/tail_signers/last30] over the last thirty days; the trend model forecasts 41.7 thousand [raw/forecast.json#/series/tail_signers/horizons/0/central] in ninety days and beat a naive forecast by 72.0% [raw/forecast.json#/series/tail_signers/skill90] at that horizon in the backtest.

<!-- Evidence for. Pointers used by the computed text of this section (32):
  raw/forecast.json#/series/intents_tx/last30
  raw/forecast.json#/series/intents_tx/horizons/0/horizon
  raw/forecast.json#/series/intents_tx/horizons/0/central
  raw/forecast.json#/series/intents_tx/horizons/0/band80/0
  raw/forecast.json#/series/intents_tx/horizons/0/band80/1
  raw/forecast.json#/series/intents_tx/horizons/2/horizon
  raw/forecast.json#/series/intents_tx/horizons/2/central
  raw/forecast.json#/series/intents_tx/horizons/2/band80/0
  raw/forecast.json#/series/intents_tx/horizons/2/band80/1
  raw/forecast.json#/series/intents_usd/last30
  raw/forecast.json#/series/intents_usd/horizons/0/horizon
  raw/forecast.json#/series/intents_usd/horizons/0/central
  raw/forecast.json#/series/intents_usd/horizons/0/band80/0
  raw/forecast.json#/series/intents_usd/horizons/0/band80/1
  raw/forecast.json#/series/intents_usd/horizons/2/horizon
  raw/forecast.json#/series/intents_usd/horizons/2/central
  raw/forecast.json#/series/intents_usd/horizons/2/band80/0
  raw/forecast.json#/series/intents_usd/horizons/2/band80/1
  raw/forecast.json#/series/stable_share/last30
  raw/forecast.json#/series/stable_share/horizons/0/horizon
  raw/forecast.json#/series/stable_share/horizons/0/central
  raw/forecast.json#/series/stable_share/horizons/0/band80/0
  raw/forecast.json#/series/stable_share/horizons/0/band80/1
  raw/forecast.json#/series/stable_share/horizons/2/horizon
  raw/forecast.json#/series/stable_share/horizons/2/central
  raw/forecast.json#/series/stable_share/horizons/2/band80/0
  raw/forecast.json#/series/stable_share/horizons/2/band80/1
  raw/forecast.json#/derived/intents_usd_12m/centralTotal
  raw/forecast.json#/derived/intents_usd_12m/p10
  raw/forecast.json#/derived/intents_usd_12m/p90
  raw/forecast.json#/derived/intents_usd_12m/observedTotalLast365
  raw/forecast.json#/derived/intents_usd_12m/observedDaysLast365
-->

## evidence-against

- The forecasts are uncertain. In the time-ordered backtest only 50.0% [raw/forecast.json#/series/intents_tx/calibration/pooledForward80] of realised Intents transaction values fell inside the eighty percent band, so the bands are too narrow and every series is labelled low skill. The gas take rate itself has no skill over a naive forecast ([raw/forecast.json#/series/take_rate_gas/skill90] skill): its central path is simply the latest level held flat.
- Gas is only one toll. The protocol's fee switch sends part of the front-end and protocol fees to NEAR buybacks, and our swap data sees that flow only partly (raw/fees/FEE_MODEL.md). If most of it travels outside the public records, NEAR's real cut is larger than this thesis measures.
- A small rate on a large base is still money: the forecast twelve-month gas burn by the Intents contracts is 33.2 thousand NEAR [raw/forecast.json#/derived/intents_burn_near_12m/centralTotal], about 113 thousand dollars [raw/forecast.json#/derived/intents_burn_near_12m/usdAtLastClose/central] at the last close, with the price held fixed. Whether that is "almost nothing" depends on what NEAR needs to earn.
- Volume is the least predictable input: a year out, the eighty percent band for daily settled value runs from 22.8 million [raw/forecast.json#/series/intents_usd/horizons/2/band80/0] to 75.1 million dollars [raw/forecast.json#/series/intents_usd/horizons/2/band80/1].
- Part of the flow is now private and invisible to us, and every figure here describes the public flow only.

<!-- Evidence against. Pointers used by the computed text of this section (35):
  raw/forecast.json#/derived/lastClose/usdPerNear
  raw/forecast.json#/facts/price/first
  raw/forecast.json#/facts/price/last
  raw/forecast.json#/facts/price/change
  raw/forecast.json#/method/config/horizons/2
  raw/forecast.json#count(/series/intents_tx/backtest/origins)
  raw/forecast.json#/method/config/reportHorizons/1
  raw/forecast.json#/method/config/reportHorizons/2
  raw/manifest.json#/headThreshold
  raw/forecast.json#/facts/monthly/12/intents_tx
  raw/forecast.json#/facts/monthly/12/month
  raw/forecast.json#/facts/monthly/11/intents_tx
  raw/forecast.json#/facts/monthly/11/month
  raw/forecast.json#/series/intents_tx/skill90
  raw/forecast.json#/series/intents_tx/calibration/pooledForward80
  raw/forecast.json#/series/intents_tx/verdict
  raw/forecast.json#/series/tail_tx/skill90
  raw/forecast.json#/series/tail_tx/calibration/pooledForward80
  raw/forecast.json#/series/tail_tx/verdict
  raw/forecast.json#/series/tail_signers/skill90
  raw/forecast.json#/series/tail_signers/calibration/pooledForward80
  raw/forecast.json#/series/tail_signers/verdict
  raw/forecast.json#/series/intents_usd/calibration/pooledForward80
  raw/forecast.json#/series/intents_usd/verdict
  raw/forecast.json#/series/usd_per_tail_signer/skill90
  raw/forecast.json#/series/usd_per_tail_signer/calibration/pooledForward80
  raw/forecast.json#/series/usd_per_tail_signer/verdict
  raw/forecast.json#/series/stable_share/calibration/pooledForward80
  raw/forecast.json#/series/stable_share/verdict
  raw/forecast.json#/series/no_near_share/skill90
  raw/forecast.json#/series/no_near_share/calibration/pooledForward80
  raw/forecast.json#/series/no_near_share/verdict
  raw/forecast.json#/series/near_token_share/skill90
  raw/forecast.json#/series/near_token_share/calibration/pooledForward80
  raw/forecast.json#/series/near_token_share/verdict
-->

## confounders-and-blind-spots

<!-- Confounders and blind spots. Pointers used by the computed text of this section (20):
  raw/forecast.json#/facts/break/day
  raw/forecast.json#/facts/break/totalChange
  raw/forecast.json#/facts/break/totalPrev
  raw/forecast.json#/facts/break/totalDay
  raw/forecast.json#/facts/break/headChange
  raw/forecast.json#/facts/break/tailTxChange
  raw/forecast.json#/facts/break/tailSignersChange
  raw/forecast.json#/facts/excursion/peakShare
  raw/forecast.json#/facts/excursion/peakDay
  raw/forecast.json#/facts/excursion/mayShare
  raw/forecast.json#/facts/excursion/juneShare
  raw/forecast.json#/facts/excursion/from
  raw/forecast.json#/facts/excursion/to
  raw/forecast.json#/facts/excursion/topRoute
  raw/forecast.json#/facts/excursion/topRouteUsd
  raw/forecast.json#/facts/excursion/topRouteShareOfNearLeg
  raw/forecast.json#/facts/excursion/topRouteMedianUsd
  raw/forecast.json#/facts/excursion/secondRoute
  raw/forecast.json#/facts/excursion/secondRouteUsd
  raw/forecast.json#/facts/excursion/twoRoutesShareOfNearLeg
-->

## long-term-economic-mechanisms

Interpretation. A booth that charges almost nothing can be a moat: if NEAR is the cheapest place to settle cross-chain intents, volume concentrates there, and a later, modest fee could be worth more than a high fee today. It can also be a leak: wallets and apps on top collect the toll, solvers collect the spread, and the network that provides finality is reduced to a utility whose token is optional for every swap. The fee switch is the hinge between the two readings. The thesis does not claim which one wins; it claims that, on the evidence so far, the value is flowing around the token rather than through it, and it names the checkpoints at which that will be visible either way.

<!-- Long-term economic mechanisms. Pointers used by the computed text of this section (0):
-->

## verdict-per-claim

<!-- Verdict per claim. Pointers used by the computed text of this section (71):
  raw/forecast.json#/series/intents_tx/verdict
  raw/forecast.json#/series/intents_tx/horizons/2/horizon
  raw/forecast.json#/series/intents_tx/horizons/2/central
  raw/forecast.json#/series/intents_tx/horizons/2/band80/0
  raw/forecast.json#/series/intents_tx/horizons/2/band80/1
  raw/forecast.json#/method/config/horizons/2
  raw/forecast.json#/series/intents_tx/skill90
  raw/forecast.json#/series/intents_tx/calibration/pooledForward80
  raw/forecast.json#/series/intents_tx/last30
  raw/forecast.json#/series/intents_tx/checkpoints/0/against/bound
  raw/forecast.json#/series/tail_tx/verdict
  raw/forecast.json#/series/tail_tx/horizons/2/horizon
  raw/forecast.json#/series/tail_tx/horizons/2/central
  raw/forecast.json#/series/tail_tx/horizons/2/band80/0
  raw/forecast.json#/series/tail_tx/horizons/2/band80/1
  raw/forecast.json#/series/tail_tx/skill90
  raw/forecast.json#/series/tail_tx/calibration/pooledForward80
  raw/forecast.json#/series/tail_tx/last30
  raw/forecast.json#/series/tail_tx/checkpoints/0/against/bound
  raw/forecast.json#/series/tail_signers/verdict
  raw/forecast.json#/series/tail_signers/horizons/2/horizon
  raw/forecast.json#/series/tail_signers/horizons/2/central
  raw/forecast.json#/series/tail_signers/horizons/2/band80/0
  raw/forecast.json#/series/tail_signers/horizons/2/band80/1
  raw/forecast.json#/series/tail_signers/skill90
  raw/forecast.json#/series/tail_signers/calibration/pooledForward80
  raw/forecast.json#/series/tail_signers/last30
  raw/forecast.json#/series/tail_signers/checkpoints/0/against/bound
  raw/forecast.json#/series/intents_usd/verdict
  raw/forecast.json#/series/intents_usd/horizons/2/horizon
  raw/forecast.json#/series/intents_usd/horizons/2/central
  raw/forecast.json#/series/intents_usd/horizons/2/band80/0
  raw/forecast.json#/series/intents_usd/horizons/2/band80/1
  raw/forecast.json#/series/intents_usd/calibration/pooledForward80
  raw/forecast.json#/series/intents_usd/last30
  raw/forecast.json#/series/intents_usd/checkpoints/0/against/bound
  raw/forecast.json#/derived/crossover/centralDate
  raw/forecast.json#/derived/crossover/within6Months
  raw/forecast.json#/derived/crossover/within12Months
  raw/forecast.json#/derived/crossover/twelveMonthsDate
  ... and 31 more; see build/FACTS.md
-->

## reproduction

<!-- Reproduction. Pointers used by the computed text of this section (0):
-->

## unable-to-compute

<!-- Unable to compute. Pointers used by the computed text of this section (7):
  raw/forecast.json#/method/config/horizons/2
  raw/forecast.json#/method/config/reportHorizons/1
  raw/forecast.json#/method/config/reportHorizons/2
  raw/manifest.json#count(/datasets/3/coverage/missingDays)
  raw/manifest.json#count(/datasets/4/coverage/missingDays)
  raw/manifest.json#count(/datasets/5/coverage/missingDays)
  raw/manifest.json#count(/datasets/6/coverage/missingDays)
-->

## source-index

<!-- Source index. Pointers used by the computed text of this section (0):
-->

## changes-since-previous-version

<!-- Changes since previous version. Pointers used by the computed text of this section (3):
  archive/thesis.json#/hypothesis
  archive/thesis.json#/verdict/status
  archive/thesis.json#/version
-->

