<!--
Authored analysis for the reference thesis. One block per section id; a heading with no text is ignored.
Rules: each number is followed on the same line by a pointer in the form [file#pointer] (see build/FACTS.md for every citable
number with its pointer and meaning). Write numbers to three significant digits, in thousands, millions or billions, or as a
percent of a share; the build checks them against the value behind the pointer and fails otherwise. Forward-looking words
(will, forecast, expect) are allowed; causal words (causes, drives, leads to, caused by, driven by) and hype are not.
Blocks appear at the top of their section, labelled Analysis, above the computed lines.
-->

## executive-claim

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

