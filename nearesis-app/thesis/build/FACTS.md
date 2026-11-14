# FACTS: every number available to cite

Write analysis in thesis/interpretation.md (`## <section-id>` headings). Cite a number as `[file#pointer]` right after it, on the same line. Numbers are checked against the value behind the pointer; write them to three significant digits, in thousands, millions or billions, or as a percent (a share of 0.357 may be written 35.7 percent or 36 percent). Forward-looking words are allowed; causal words are not.

Last full day 2026-11-13; forecasts are thirty-day averages ending on the stated date; horizons beyond 90 days are extrapolations the backtest cannot score.


## F1 Intents transactions per day (intents_tx; unit: transactions)

- `raw/forecast.json#/series/intents_tx/last30` = 90,244: last thirty-day average (30 observed days)
- model used: damped (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/intents_tx/skill90` = 0.176: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/intents_tx/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/intents_tx/calibration/pooledForward80` = 0.500: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/intents_tx/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/intents_tx/backtest/table/0/mae` = 0.115: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/intents_tx/backtest/table/1/mae` = 0.225: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/intents_tx/backtest/table/2/mae` = 0.405: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/intents_tx/backtest/table/9/mae` = 0.113: error of damped at 30 days over 14 origins (skill 0.0189)
- `raw/forecast.json#/series/intents_tx/backtest/table/10/mae` = 0.205: error of damped at 60 days over 12 origins (skill 0.0880)
- `raw/forecast.json#/series/intents_tx/backtest/table/11/mae` = 0.334: error of damped at 90 days over 10 origins (skill 0.176)
- `raw/forecast.json#/series/intents_tx/horizons/0/central` = 90,048: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/intents_tx/horizons/0/band80/0` = 51,881: eighty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/0/band80/1` = 156,293: eighty percent band, upper
- `raw/forecast.json#/series/intents_tx/horizons/0/band50/0` = 59,963: fifty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/0/band50/1` = 135,229: fifty percent band, upper
- `raw/forecast.json#/series/intents_tx/horizons/1/central` = 90,036: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/intents_tx/horizons/1/band80/0` = 41,282: eighty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/1/band80/1` = 196,369: eighty percent band, upper
- `raw/forecast.json#/series/intents_tx/horizons/1/band50/0` = 50,661: fifty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/1/band50/1` = 160,014: fifty percent band, upper
- `raw/forecast.json#/series/intents_tx/horizons/2/central` = 90,036: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/intents_tx/horizons/2/band80/0` = 29,660: eighty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/2/band80/1` = 273,314: eighty percent band, upper
- `raw/forecast.json#/series/intents_tx/horizons/2/band50/0` = 39,699: fifty percent band, lower
- `raw/forecast.json#/series/intents_tx/horizons/2/band50/1` = 204,197: fifty percent band, upper
- `raw/forecast.json#/series/intents_tx/checkpoints/0/central` = 90,046: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/intents_tx/checkpoints/0/band80/0` = 51,565: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/intents_tx/checkpoints/0/band80/1` = 157,245: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/intents_tx/checkpoints/1/central` = 90,036: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/intents_tx/checkpoints/1/band80/0` = 41,193: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/intents_tx/checkpoints/1/band80/1` = 196,794: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/intents_tx/checkpoints/2/central` = 90,036: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/intents_tx/checkpoints/2/band80/0` = 29,660: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/intents_tx/checkpoints/2/band80/1` = 273,314: checkpoint 2027-11-13: eighty percent upper

## F2 long-tail organic transactions per day (tail_tx; unit: transactions)

- `raw/forecast.json#/series/tail_tx/last30` = 100,345: last thirty-day average (30 observed days)
- model used: median (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/tail_tx/skill90` = 0.562: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/tail_tx/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/tail_tx/calibration/pooledForward80` = 0.250: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/tail_tx/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/tail_tx/backtest/table/0/mae` = 0.139: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/tail_tx/backtest/table/1/mae` = 0.163: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/tail_tx/backtest/table/2/mae` = 0.240: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/tail_tx/backtest/table/12/mae` = 0.119: error of median at 30 days over 14 origins (skill 0.144)
- `raw/forecast.json#/series/tail_tx/backtest/table/13/mae` = 0.0983: error of median at 60 days over 12 origins (skill 0.396)
- `raw/forecast.json#/series/tail_tx/backtest/table/14/mae` = 0.105: error of median at 90 days over 10 origins (skill 0.562)
- `raw/forecast.json#/series/tail_tx/horizons/0/central` = 116,869: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/tail_tx/horizons/0/band80/0` = 89,055: eighty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/0/band80/1` = 153,369: eighty percent band, upper
- `raw/forecast.json#/series/tail_tx/horizons/0/band50/0` = 109,422: fifty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/0/band50/1` = 124,823: fifty percent band, upper
- `raw/forecast.json#/series/tail_tx/horizons/1/central` = 104,339: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/tail_tx/horizons/1/band80/0` = 71,041: eighty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/1/band80/1` = 153,243: eighty percent band, upper
- `raw/forecast.json#/series/tail_tx/horizons/1/band50/0` = 97,690: fifty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/1/band50/1` = 111,440: fifty percent band, upper
- `raw/forecast.json#/series/tail_tx/horizons/2/central` = 82,642: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/tail_tx/horizons/2/band80/0` = 47,806: eighty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/2/band80/1` = 142,862: eighty percent band, upper
- `raw/forecast.json#/series/tail_tx/horizons/2/band50/0` = 77,376: fifty percent band, lower
- `raw/forecast.json#/series/tail_tx/horizons/2/band50/1` = 88,267: fifty percent band, upper
- `raw/forecast.json#/series/tail_tx/checkpoints/0/central` = 116,575: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/tail_tx/checkpoints/0/band80/0` = 88,564: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/tail_tx/checkpoints/0/band80/1` = 153,444: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/tail_tx/checkpoints/1/central` = 104,207: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/tail_tx/checkpoints/1/band80/0` = 70,876: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/tail_tx/checkpoints/1/band80/1` = 153,213: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/tail_tx/checkpoints/2/central` = 82,642: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/tail_tx/checkpoints/2/band80/0` = 47,806: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/tail_tx/checkpoints/2/band80/1` = 142,862: checkpoint 2027-11-13: eighty percent upper

## F3 long-tail signers per day (tail_signers; unit: accounts)

- `raw/forecast.json#/series/tail_signers/last30` = 64,620: last thirty-day average (30 observed days)
- model used: trend (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/tail_signers/skill90` = 0.720: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/tail_signers/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/tail_signers/calibration/pooledForward80` = 0.500: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/tail_signers/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/tail_signers/backtest/table/0/mae` = 0.147: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/tail_signers/backtest/table/1/mae` = 0.186: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/tail_signers/backtest/table/2/mae` = 0.309: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/tail_signers/backtest/table/6/mae` = 0.0674: error of trend at 30 days over 14 origins (skill 0.540)
- `raw/forecast.json#/series/tail_signers/backtest/table/7/mae` = 0.0457: error of trend at 60 days over 12 origins (skill 0.754)
- `raw/forecast.json#/series/tail_signers/backtest/table/8/mae` = 0.0866: error of trend at 90 days over 10 origins (skill 0.720)
- `raw/forecast.json#/series/tail_signers/horizons/0/central` = 41,729: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/tail_signers/horizons/0/band80/0` = 36,604: eighty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/0/band80/1` = 47,573: eighty percent band, upper
- `raw/forecast.json#/series/tail_signers/horizons/0/band50/0` = 39,665: fifty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/0/band50/1` = 43,902: fifty percent band, upper
- `raw/forecast.json#/series/tail_signers/horizons/1/central` = 28,523: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/tail_signers/horizons/1/band80/0` = 23,698: eighty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/1/band80/1` = 34,332: eighty percent band, upper
- `raw/forecast.json#/series/tail_signers/horizons/1/band50/0` = 26,548: fifty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/1/band50/1` = 30,646: fifty percent band, upper
- `raw/forecast.json#/series/tail_signers/horizons/2/central` = 13,048: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/tail_signers/horizons/2/band80/0` = 10,021: eighty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/2/band80/1` = 16,989: eighty percent band, upper
- `raw/forecast.json#/series/tail_signers/horizons/2/band50/0` = 11,780: fifty percent band, lower
- `raw/forecast.json#/series/tail_signers/horizons/2/band50/1` = 14,452: fifty percent band, upper
- `raw/forecast.json#/series/tail_signers/checkpoints/0/central` = 41,378: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/tail_signers/checkpoints/0/band80/0` = 36,243: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/tail_signers/checkpoints/0/band80/1` = 47,241: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/tail_signers/checkpoints/1/central` = 28,403: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/tail_signers/checkpoints/1/band80/0` = 23,586: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/tail_signers/checkpoints/1/band80/1` = 34,204: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/tail_signers/checkpoints/2/central` = 13,048: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/tail_signers/checkpoints/2/band80/0` = 10,021: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/tail_signers/checkpoints/2/band80/1` = 16,989: checkpoint 2027-11-13: eighty percent upper

## F4 Intents settled volume per day (intents_usd; unit: USD)

- `raw/forecast.json#/series/intents_usd/last30` = 36,438,447: last thirty-day average (30 observed days)
- model used: naive (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/intents_usd/skill90` = 0: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/intents_usd/calibration/pooledLeaveOneOut80` = 0.778: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/intents_usd/calibration/pooledForward80` = 0.500: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/intents_usd/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/intents_usd/backtest/table/0/mae` = 0.246: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/intents_usd/backtest/table/1/mae` = 0.276: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/intents_usd/backtest/table/2/mae` = 0.204: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/intents_usd/horizons/0/central` = 41,347,553: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/intents_usd/horizons/0/band80/0` = 26,447,666: eighty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/0/band80/1` = 64,641,626: eighty percent band, upper
- `raw/forecast.json#/series/intents_usd/horizons/0/band50/0` = 31,759,029: fifty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/0/band50/1` = 53,830,995: fifty percent band, upper
- `raw/forecast.json#/series/intents_usd/horizons/1/central` = 41,347,553: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/intents_usd/horizons/1/band80/0` = 26,447,666: eighty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/1/band80/1` = 64,641,626: eighty percent band, upper
- `raw/forecast.json#/series/intents_usd/horizons/1/band50/0` = 30,487,910: fifty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/1/band50/1` = 56,075,346: fifty percent band, upper
- `raw/forecast.json#/series/intents_usd/horizons/2/central` = 41,347,553: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/intents_usd/horizons/2/band80/0` = 22,774,231: eighty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/2/band80/1` = 75,068,181: eighty percent band, upper
- `raw/forecast.json#/series/intents_usd/horizons/2/band50/0` = 26,793,101: fifty percent band, lower
- `raw/forecast.json#/series/intents_usd/horizons/2/band50/1` = 63,808,221: fifty percent band, upper
- `raw/forecast.json#/series/intents_usd/checkpoints/0/central` = 41,347,553: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/intents_usd/checkpoints/0/band80/0` = 26,447,666: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/intents_usd/checkpoints/0/band80/1` = 64,641,626: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/intents_usd/checkpoints/1/central` = 41,347,553: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/intents_usd/checkpoints/1/band80/0` = 26,447,666: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/intents_usd/checkpoints/1/band80/1` = 64,641,626: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/intents_usd/checkpoints/2/central` = 41,347,553: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/intents_usd/checkpoints/2/band80/0` = 22,774,231: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/intents_usd/checkpoints/2/band80/1` = 75,068,181: checkpoint 2027-11-13: eighty percent upper

## F8 settled volume per long-tail signer per day (usd_per_tail_signer; unit: USD per signer)

- `raw/forecast.json#/series/usd_per_tail_signer/last30` = 599: last thirty-day average (30 observed days)
- model used: median (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/usd_per_tail_signer/skill90` = 0.452: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/usd_per_tail_signer/calibration/pooledLeaveOneOut80` = 0.778: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/usd_per_tail_signer/calibration/pooledForward80` = 0.500: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/usd_per_tail_signer/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/0/mae` = 0.310: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/1/mae` = 0.370: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/2/mae` = 0.536: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/12/mae` = 0.297: error of median at 30 days over 14 origins (skill 0.0400)
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/13/mae` = 0.284: error of median at 60 days over 12 origins (skill 0.233)
- `raw/forecast.json#/series/usd_per_tail_signer/backtest/table/14/mae` = 0.294: error of median at 90 days over 10 origins (skill 0.452)
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/0/central` = 617: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/0/band80/0` = 396: eighty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/0/band80/1` = 962: eighty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/0/band50/0` = 444: fifty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/0/band50/1` = 859: fifty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/1/central` = 865: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/1/band80/0` = 470: eighty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/1/band80/1` = 1,593: eighty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/1/band50/0` = 543: fifty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/1/band50/1` = 1,380: fifty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/2/central` = 1,733: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/2/band80/0` = 727: eighty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/2/band80/1` = 4,129: eighty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/2/band50/0` = 892: fifty percent band, lower
- `raw/forecast.json#/series/usd_per_tail_signer/horizons/2/band50/1` = 3,366: fifty percent band, upper
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/0/central` = 622: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/0/band80/0` = 399: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/0/band80/1` = 970: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/1/central` = 869: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/1/band80/0` = 471: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/1/band80/1` = 1,602: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/2/central` = 1,733: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/2/band80/0` = 727: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/usd_per_tail_signer/checkpoints/2/band80/1` = 4,129: checkpoint 2027-11-13: eighty percent upper

## F5 stable-to-stable share of settled volume (stable_share; unit: share of USD volume)

- `raw/forecast.json#/series/stable_share/last30` = 0.327: last thirty-day average (30 observed days)
- model used: naive (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/stable_share/skill90` = 0: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/stable_share/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/stable_share/calibration/pooledForward80` = 1: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/stable_share/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/stable_share/backtest/table/0/mae` = 0.171: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/stable_share/backtest/table/1/mae` = 0.289: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/stable_share/backtest/table/2/mae` = 0.295: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/stable_share/horizons/0/central` = 0.366: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/stable_share/horizons/0/band80/0` = 0.262: eighty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/0/band80/1` = 0.484: eighty percent band, upper
- `raw/forecast.json#/series/stable_share/horizons/0/band50/0` = 0.306: fifty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/0/band50/1` = 0.431: fifty percent band, upper
- `raw/forecast.json#/series/stable_share/horizons/1/central` = 0.366: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/stable_share/horizons/1/band80/0` = 0.225: eighty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/1/band80/1` = 0.534: eighty percent band, upper
- `raw/forecast.json#/series/stable_share/horizons/1/band50/0` = 0.296: fifty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/1/band50/1` = 0.443: fifty percent band, upper
- `raw/forecast.json#/series/stable_share/horizons/2/central` = 0.366: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/stable_share/horizons/2/band80/0` = 0.179: eighty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/2/band80/1` = 0.606: eighty percent band, upper
- `raw/forecast.json#/series/stable_share/horizons/2/band50/0` = 0.268: fifty percent band, lower
- `raw/forecast.json#/series/stable_share/horizons/2/band50/1` = 0.477: fifty percent band, upper
- `raw/forecast.json#/series/stable_share/checkpoints/0/central` = 0.366: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/stable_share/checkpoints/0/band80/0` = 0.261: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/stable_share/checkpoints/0/band80/1` = 0.485: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/stable_share/checkpoints/1/central` = 0.366: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/stable_share/checkpoints/1/band80/0` = 0.225: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/stable_share/checkpoints/1/band80/1` = 0.535: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/stable_share/checkpoints/2/central` = 0.366: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/stable_share/checkpoints/2/band80/0` = 0.179: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/stable_share/checkpoints/2/band80/1` = 0.606: checkpoint 2027-11-13: eighty percent upper

## F6 share of settled volume touching no NEAR-chain asset (no_near_share; unit: share of USD volume)

- `raw/forecast.json#/series/no_near_share/last30` = 0.931: last thirty-day average (30 observed days)
- model used: median (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/no_near_share/skill90` = 0.0673: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/no_near_share/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/no_near_share/calibration/pooledForward80` = 1: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/no_near_share/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/no_near_share/backtest/table/0/mae` = 0.515: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/no_near_share/backtest/table/1/mae` = 0.729: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/no_near_share/backtest/table/2/mae` = 0.647: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/no_near_share/backtest/table/12/mae` = 0.504: error of median at 30 days over 14 origins (skill 0.0214)
- `raw/forecast.json#/series/no_near_share/backtest/table/13/mae` = 0.790: error of median at 60 days over 12 origins (skill -0.0833)
- `raw/forecast.json#/series/no_near_share/backtest/table/14/mae` = 0.603: error of median at 90 days over 10 origins (skill 0.0673)
- `raw/forecast.json#/series/no_near_share/horizons/0/central` = 0.967: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/no_near_share/horizons/0/band80/0` = 0.891: eighty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/0/band80/1` = 0.991: eighty percent band, upper
- `raw/forecast.json#/series/no_near_share/horizons/0/band50/0` = 0.945: fifty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/0/band50/1` = 0.981: fifty percent band, upper
- `raw/forecast.json#/series/no_near_share/horizons/1/central` = 0.976: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/no_near_share/horizons/1/band80/0` = 0.900: eighty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/1/band80/1` = 0.995: eighty percent band, upper
- `raw/forecast.json#/series/no_near_share/horizons/1/band50/0` = 0.951: fifty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/1/band50/1` = 0.989: fifty percent band, upper
- `raw/forecast.json#/series/no_near_share/horizons/2/central` = 0.989: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/no_near_share/horizons/2/band80/0` = 0.911: eighty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/2/band80/1` = 0.999: eighty percent band, upper
- `raw/forecast.json#/series/no_near_share/horizons/2/band50/0` = 0.968: fifty percent band, lower
- `raw/forecast.json#/series/no_near_share/horizons/2/band50/1` = 0.996: fifty percent band, upper
- `raw/forecast.json#/series/no_near_share/checkpoints/0/central` = 0.967: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/no_near_share/checkpoints/0/band80/0` = 0.892: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/no_near_share/checkpoints/0/band80/1` = 0.991: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/no_near_share/checkpoints/1/central` = 0.976: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/no_near_share/checkpoints/1/band80/0` = 0.900: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/no_near_share/checkpoints/1/band80/1` = 0.995: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/no_near_share/checkpoints/2/central` = 0.989: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/no_near_share/checkpoints/2/band80/0` = 0.911: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/no_near_share/checkpoints/2/band80/1` = 0.999: checkpoint 2027-11-13: eighty percent upper

## F7 share of settled volume with a NEAR-token leg (near_token_share; unit: share of USD volume)

- `raw/forecast.json#/series/near_token_share/last30` = 0.0246: last thirty-day average (30 observed days)
- model used: trend (lowest mean absolute error at 90 days over 10 origins (ties go to the simpler model)); verdict FORECAST_LOW_SKILL
- `raw/forecast.json#/series/near_token_share/skill90` = 0.331: skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)
- `raw/forecast.json#/series/near_token_share/calibration/pooledLeaveOneOut80` = 0.750: share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)
- `raw/forecast.json#/series/near_token_share/calibration/pooledForward80` = 1: share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)
- `raw/forecast.json#/series/near_token_share/calibration/pooledInSample80` = 0.778: the same, in sample
- `raw/forecast.json#/series/near_token_share/backtest/table/0/mae` = 0.709: error of naive at 30 days over 14 origins (skill 0)
- `raw/forecast.json#/series/near_token_share/backtest/table/1/mae` = 1.07: error of naive at 60 days over 12 origins (skill 0)
- `raw/forecast.json#/series/near_token_share/backtest/table/2/mae` = 0.879: error of naive at 90 days over 10 origins (skill 0)
- `raw/forecast.json#/series/near_token_share/backtest/table/6/mae` = 0.884: error of trend at 30 days over 14 origins (skill -0.248)
- `raw/forecast.json#/series/near_token_share/backtest/table/7/mae` = 1.08: error of trend at 60 days over 12 origins (skill -0.0143)
- `raw/forecast.json#/series/near_token_share/backtest/table/8/mae` = 0.588: error of trend at 90 days over 10 origins (skill 0.331)
- `raw/forecast.json#/series/near_token_share/horizons/0/central` = 0.0185: forecast at +90 days (2027-02-11)
- `raw/forecast.json#/series/near_token_share/horizons/0/band80/0` = 0.00560: eighty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/0/band80/1` = 0.0596: eighty percent band, upper
- `raw/forecast.json#/series/near_token_share/horizons/0/band50/0` = 0.00630: fifty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/0/band50/1` = 0.0525: fifty percent band, upper
- `raw/forecast.json#/series/near_token_share/horizons/1/central` = 0.0153: forecast at +180 days (2027-05-12), extrapolation
- `raw/forecast.json#/series/near_token_share/horizons/1/band80/0` = 0.00450: eighty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/1/band80/1` = 0.0503: eighty percent band, upper
- `raw/forecast.json#/series/near_token_share/horizons/1/band50/0` = 0.00520: fifty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/1/band50/1` = 0.0437: fifty percent band, upper
- `raw/forecast.json#/series/near_token_share/horizons/2/central` = 0.0103: forecast at +365 days (2027-11-13), extrapolation
- `raw/forecast.json#/series/near_token_share/horizons/2/band80/0` = 0.00180: eighty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/2/band80/1` = 0.0566: eighty percent band, upper
- `raw/forecast.json#/series/near_token_share/horizons/2/band50/0` = 0.00340: fifty percent band, lower
- `raw/forecast.json#/series/near_token_share/horizons/2/band50/1` = 0.0305: fifty percent band, upper
- `raw/forecast.json#/series/near_token_share/checkpoints/0/central` = 0.0184: checkpoint 2027-02-13: forecast
- `raw/forecast.json#/series/near_token_share/checkpoints/0/band80/0` = 0.00550: checkpoint 2027-02-13: eighty percent lower
- `raw/forecast.json#/series/near_token_share/checkpoints/0/band80/1` = 0.0594: checkpoint 2027-02-13: eighty percent upper
- `raw/forecast.json#/series/near_token_share/checkpoints/1/central` = 0.0152: checkpoint 2027-05-13: forecast
- `raw/forecast.json#/series/near_token_share/checkpoints/1/band80/0` = 0.00450: checkpoint 2027-05-13: eighty percent lower
- `raw/forecast.json#/series/near_token_share/checkpoints/1/band80/1` = 0.0504: checkpoint 2027-05-13: eighty percent upper
- `raw/forecast.json#/series/near_token_share/checkpoints/2/central` = 0.0103: checkpoint 2027-11-13: forecast
- `raw/forecast.json#/series/near_token_share/checkpoints/2/band80/0` = 0.00180: checkpoint 2027-11-13: eighty percent lower
- `raw/forecast.json#/series/near_token_share/checkpoints/2/band80/1` = 0.0566: checkpoint 2027-11-13: eighty percent upper

## Derived: crossover of Intents transactions over long-tail organic transactions

- `raw/forecast.json#/derived/crossover/last30A` = 90,244: last30A
- `raw/forecast.json#/derived/crossover/last30B` = 100,345: last30B
- `raw/forecast.json#/derived/crossover/centralHorizon` = 297: centralHorizon
- `raw/forecast.json#/derived/crossover/within6Months` = 0.675: within6Months
- `raw/forecast.json#/derived/crossover/within12Months` = 0.815: within12Months
- `raw/forecast.json#/derived/crossover/aboveAt6Months` = 0.487: aboveAt6Months
- `raw/forecast.json#/derived/crossover/aboveAt12Months` = 0.597: aboveAt12Months
- `raw/forecast.json#/derived/crossover/centralDate` = 2027-09-06: centralDate
- `raw/forecast.json#/derived/crossover/medianDate` = 2027-01-31: medianDate
- `raw/forecast.json#/derived/crossover/p10Date` = 2026-11-22: p10Date
- `raw/forecast.json#/derived/crossover/p90Date` = 2027-07-10: p90Date
- already above at the last day: false

## Derived: settled volume over the next twelve months (USD)

- `raw/forecast.json#/derived/intents_usd_12m/centralTotal` = 15,091,856,744: centralTotal
- `raw/forecast.json#/derived/intents_usd_12m/p10` = 6,164,583,159: p10
- `raw/forecast.json#/derived/intents_usd_12m/p25` = 9,467,636,611: p25
- `raw/forecast.json#/derived/intents_usd_12m/p50` = 16,146,849,602: p50
- `raw/forecast.json#/derived/intents_usd_12m/p75` = 31,359,906,103: p75
- `raw/forecast.json#/derived/intents_usd_12m/p90` = 56,022,881,787: p90
- `raw/forecast.json#/derived/intents_usd_12m/observedTotalLast365` = 11,592,507,973: observedTotalLast365
- `raw/forecast.json#/derived/intents_usd_12m/observedDaysLast365` = 337: observedDaysLast365
- `raw/forecast.json#/derived/intents_usd_12m/missingDaysLast365` = 28: missingDaysLast365
- `raw/forecast.json#/derived/intents_usd_12m/bandSum80/lo` = 9,503,862,896: sum of the eighty percent band path over a year, lower (narrower than the simulated range)
- `raw/forecast.json#/derived/intents_usd_12m/bandSum80/hi` = 24,018,476,144: the same, upper

## Derived: stable-to-stable share crossing one half

- `raw/forecast.json#/derived/stable_share_threshold/last30` = 0.327: last30
- `raw/forecast.json#/derived/stable_share_threshold/within6Months` = 0.472: within6Months
- `raw/forecast.json#/derived/stable_share_threshold/within12Months` = 0.625: within12Months
- `raw/forecast.json#/derived/stable_share_threshold/medianDate` = 2027-02-16: median simulated crossing date

## Derived: NEAR burnt by the Intents contracts (needs the fee inputs) and the toll split

- not computed: the fee inputs do not provide the NEAR burnt by the Intents contracts yet
- `raw/forecast.json#/derived/lastClose/usdPerNear` = 3.42: last NEAR close used for every USD figure of NEAR burnt (price held fixed, not a forecast)
- not computed: no take-rate or spread series from the fee inputs

## Break on 2026-04-02 and the head accounts

- `raw/forecast.json#/facts/break/totalPrev` = 3,758,663: totalPrev
- `raw/forecast.json#/facts/break/totalDay` = 1,063,375: totalDay
- `raw/forecast.json#/facts/break/totalChange` = -0.717: totalChange
- `raw/forecast.json#/facts/break/headPrev` = 3,501,427: headPrev
- `raw/forecast.json#/facts/break/headDay` = 814,717: headDay
- `raw/forecast.json#/facts/break/headChange` = -0.767: headChange
- `raw/forecast.json#/facts/break/tailTxPrev` = 192,700: tailTxPrev
- `raw/forecast.json#/facts/break/tailTxDay` = 191,015: tailTxDay
- `raw/forecast.json#/facts/break/tailTxChange` = -0.00874: tailTxChange
- `raw/forecast.json#/facts/break/tailSignersPrev` = 138,897: tailSignersPrev
- `raw/forecast.json#/facts/break/tailSignersDay` = 137,046: tailSignersDay
- `raw/forecast.json#/facts/break/tailSignersChange` = -0.0133: tailSignersChange
- `raw/forecast.json#/facts/break/tailTx7Before` = 191,885: tailTx7Before
- `raw/forecast.json#/facts/break/tailTx7After` = 184,090: tailTx7After
- `raw/forecast.json#/facts/break/tailSigners7Before` = 136,901: tailSigners7Before
- `raw/forecast.json#/facts/break/tailSigners7After` = 132,598: tailSigners7After
- `raw/head_accounts_break.json#/rows/0`: hotwallet.kaiching: head days before 31, transactions before 66023255, head days after 1, transactions after 479 (pointers /rows/0/2 and /rows/0/5)
- `raw/head_accounts_break.json#/rows/1`: sweat-relayer.near: head days before 31, transactions before 7585656, head days after 31, transactions after 8891152 (pointers /rows/1/2 and /rows/1/5)
- `raw/head_accounts_break.json#/rows/2`: sweat-migration.near: head days before 10, transactions before 7930643, head days after 3, transactions after 367213 (pointers /rows/2/2 and /rows/2/5)
- `raw/head_accounts_break.json#/rows/3`: 0-relay.hot.tg: head days before 31, transactions before 4167896, head days after 31, transactions after 2458499 (pointers /rows/3/2 and /rows/3/5)
- `raw/head_accounts_break.json#/rows/4`: relay.tg: head days before 31, transactions before 4158356, head days after 31, transactions after 1474710 (pointers /rows/4/2 and /rows/4/5)
- `raw/head_accounts_break.json#/rows/5`: users.kaiching: head days before 31, transactions before 3608746, head days after 1, transactions after 1696 (pointers /rows/5/2 and /rows/5/5)
- `raw/head_accounts_break.json#/rows/6`: game.hot.tg: head days before 31, transactions before 1305147, head days after 31, transactions after 665738 (pointers /rows/6/2 and /rows/6/5)
- `raw/head_accounts_break.json#/rows/7`: meteor-relayer.near: head days before 31, transactions before 893176, head days after 31, transactions after 824086 (pointers /rows/7/2 and /rows/7/5)
- `raw/head_accounts_break.json#/rows/8`: relay.aurora: head days before 31, transactions before 468312, head days after 31, transactions after 442934 (pointers /rows/8/2 and /rows/8/5)
- `raw/head_accounts_break.json#/rows/9`: bridge-mng.near: head days before 31, transactions before 171322, head days after 31, transactions after 80335 (pointers /rows/9/2 and /rows/9/5)
- `raw/head_accounts_break.json#/rows/10`: bridge-refuel.hot.tg: head days before 31, transactions before 137555, head days after 31, transactions after 168610 (pointers /rows/10/2 and /rows/10/5)
- `raw/head_accounts_break.json#/rows/11`: roundzest8415.near: head days before 31, transactions before 123616, head days after 30, transactions after 142329 (pointers /rows/11/2 and /rows/11/5)

## Composition: what moves through Intents (monthly)

- `raw/forecast.json#/facts/monthly/0/intents_tx` = 117,695: 2025-11: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/tail_tx` = 361,307: 2025-11: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/tail_signers` = 240,484: 2025-11: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/intents_usd` = 42,956,692: 2025-11: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/stable_share` = 0.0722: 2025-11: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/no_near_share` = 0.971: 2025-11: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/near_token_share` = 0.0166: 2025-11: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/0/median_swap_usd` = 23.0: 2025-11: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/intents_tx` = 40,455: 2025-12: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/tail_tx` = 320,874: 2025-12: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/tail_signers` = 226,088: 2025-12: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/intents_usd` = 24,387,813: 2025-12: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/stable_share` = 0.192: 2025-12: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/no_near_share` = 0.960: 2025-12: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/near_token_share` = 0.0187: 2025-12: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/1/median_swap_usd` = 13.4: 2025-12: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/intents_tx` = 28,372: 2026-01: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/tail_tx` = 260,495: 2026-01: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/tail_signers` = 177,549: 2026-01: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/intents_usd` = 30,551,911: 2026-01: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/stable_share` = 0.171: 2026-01: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/no_near_share` = 0.967: 2026-01: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/near_token_share` = 0.0129: 2026-01: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/2/median_swap_usd` = 7.11: 2026-01: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/intents_tx` = 33,051: 2026-02: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/tail_tx` = 340,624: 2026-02: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/tail_signers` = 275,819: 2026-02: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/intents_usd` = 28,889,838: 2026-02: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/stable_share` = 0.211: 2026-02: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/no_near_share` = 0.976: 2026-02: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/near_token_share` = 0.00890: 2026-02: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/3/median_swap_usd` = 23.3: 2026-02: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/intents_tx` = 32,765: 2026-03: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/tail_tx` = 201,897: 2026-03: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/tail_signers` = 143,024: 2026-03: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/intents_usd` = 26,205,820: 2026-03: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/stable_share` = 0.255: 2026-03: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/no_near_share` = 0.971: 2026-03: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/near_token_share` = 0.0150: 2026-03: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/4/median_swap_usd` = 22.5: 2026-03: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/intents_tx` = 33,013: 2026-04: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/tail_tx` = 179,214: 2026-04: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/tail_signers` = 129,372: 2026-04: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/intents_usd` = 25,741,108: 2026-04: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/stable_share` = 0.325: 2026-04: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/no_near_share` = 0.985: 2026-04: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/near_token_share` = 0.00572: 2026-04: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/5/median_swap_usd` = 21.7: 2026-04: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/intents_tx` = 32,490: 2026-05: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/tail_tx` = 166,884: 2026-05: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/tail_signers` = 120,780: 2026-05: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/intents_usd` = 33,827,131: 2026-05: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/stable_share` = 0.226: 2026-05: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/no_near_share` = 0.807: 2026-05: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/near_token_share` = 0.101: 2026-05: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/6/median_swap_usd` = 21.7: 2026-05: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/intents_tx` = 36,214: 2026-06: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/tail_tx` = 152,961: 2026-06: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/tail_signers` = 112,355: 2026-06: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/intents_usd` = 34,843,159: 2026-06: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/stable_share` = 0.316: 2026-06: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/no_near_share` = 0.901: 2026-06: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/near_token_share` = 0.0423: 2026-06: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/7/median_swap_usd` = 23.2: 2026-06: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/intents_tx` = 42,677: 2026-07: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/tail_tx` = 126,876: 2026-07: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/tail_signers` = 93,223: 2026-07: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/intents_usd` = 34,768,168: 2026-07: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/stable_share` = 0.351: 2026-07: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/no_near_share` = 0.936: 2026-07: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/near_token_share` = 0.0138: 2026-07: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/8/median_swap_usd` = 25.6: 2026-07: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/intents_tx` = 55,326: 2026-08: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/tail_tx` = 111,611: 2026-08: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/tail_signers` = 80,921: 2026-08: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/intents_usd` = 39,117,258: 2026-08: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/stable_share` = 0.351: 2026-08: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/no_near_share` = 0.931: 2026-08: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/near_token_share` = 0.0177: 2026-08: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/9/median_swap_usd` = 34.6: 2026-08: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/intents_tx` = 67,727: 2026-09: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/tail_tx` = 105,688: 2026-09: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/tail_signers` = 62,651: 2026-09: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/intents_usd` = 50,458,923: 2026-09: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/stable_share` = 0.320: 2026-09: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/no_near_share` = 0.949: 2026-09: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/near_token_share` = 0.0313: 2026-09: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/10/median_swap_usd` = 63.6: 2026-09: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/intents_tx` = 64,962: 2026-10: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/tail_tx` = 115,396: 2026-10: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/tail_signers` = 71,808: 2026-10: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/intents_usd` = 35,333,926: 2026-10: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/stable_share` = 0.305: 2026-10: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/no_near_share` = 0.915: 2026-10: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/near_token_share` = 0.0459: 2026-10: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/11/median_swap_usd` = 53.7: 2026-10: median_swap_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/intents_tx` = 124,728: 2026-11: intents_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/tail_tx` = 115,387: 2026-11: tail_tx (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/tail_signers` = 81,616: 2026-11: tail_signers (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/intents_usd` = 40,509,534: 2026-11: intents_usd (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/stable_share` = 0.357: 2026-11: stable_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/no_near_share` = 0.949: 2026-11: no_near_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/near_token_share` = 0.0135: 2026-11: near_token_share (monthly mean per day, or volume share)
- `raw/forecast.json#/facts/monthly/12/median_swap_usd` = 55.3: 2026-11: median_swap_usd (monthly mean per day, or volume share)

## May 2026 excursion (near-token leg)

- `raw/forecast.json#/facts/excursion/peakDay` = 2026-05-26: peakDay
- `raw/forecast.json#/facts/excursion/peakShare` = 0.506: peakShare
- `raw/forecast.json#/facts/excursion/nearLegUsdInWindow` = 84,996,022: nearLegUsdInWindow
- `raw/forecast.json#/facts/excursion/topRoute` = wNEAR (near) to wNEAR (near): topRoute
- `raw/forecast.json#/facts/excursion/topRouteUsd` = 35,216,432: topRouteUsd
- `raw/forecast.json#/facts/excursion/topRouteSwaps` = 3,437: topRouteSwaps
- `raw/forecast.json#/facts/excursion/topRouteMedianUsd` = 0.000100: topRouteMedianUsd
- `raw/forecast.json#/facts/excursion/topRouteShareOfNearLeg` = 0.414: topRouteShareOfNearLeg
- `raw/forecast.json#/facts/excursion/secondRoute` = ZEC (zec) to wNEAR (near): secondRoute
- `raw/forecast.json#/facts/excursion/secondRouteUsd` = 26,905,712: secondRouteUsd
- `raw/forecast.json#/facts/excursion/secondRouteSharesOfNearLeg` = 0.317: secondRouteSharesOfNearLeg
- `raw/forecast.json#/facts/excursion/twoRoutesShareOfNearLeg` = 0.731: twoRoutesShareOfNearLeg
- `raw/forecast.json#/facts/excursion/mayShare` = 0.101: mayShare
- `raw/forecast.json#/facts/excursion/mayNoNear` = 0.807: mayNoNear
- `raw/forecast.json#/facts/excursion/juneShare` = 0.0423: juneShare

## Chain pairs (window totals)

- `raw/forecast.json#/facts/chainPairs/pairs/0/usd` = 977,448,882: eth to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/0/shareOfListed` = 0.160: eth to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/1/usd` = 970,917,357: eth to tron: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/1/shareOfListed` = 0.158: eth to tron: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/2/usd` = 921,249,956: btc to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/2/shareOfListed` = 0.150: btc to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/3/usd` = 756,289,760: tron to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/3/shareOfListed` = 0.123: tron to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/4/usd` = 675,472,426: eth to btc: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/4/shareOfListed` = 0.110: eth to btc: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/5/usd` = 511,442,351: zec to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/5/shareOfListed` = 0.0835: zec to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/6/usd` = 416,571,620: btc to tron: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/6/shareOfListed` = 0.0680: btc to tron: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/7/usd` = 407,597,659: eth to zec: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/7/shareOfListed` = 0.0665: eth to zec: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/8/usd` = 251,170,651: bsc to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/8/shareOfListed` = 0.0410: bsc to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/pairs/9/usd` = 240,033,311: sol to eth: USD over the window
- `raw/forecast.json#/facts/chainPairs/pairs/9/shareOfListed` = 0.0392: sol to eth: share of the ten listed pairs
- `raw/forecast.json#/facts/chainPairs/shareListedOfWindow` = 0.521: share of all window volume that the ten listed pairs carry

## Price and trade size

- `raw/forecast.json#/facts/price/first` = 2.79: NEAR close first
- `raw/forecast.json#/facts/price/last` = 3.42: NEAR close last
- `raw/forecast.json#/facts/price/change` = 0.227: NEAR close change
- `raw/forecast.json#/facts/tradeSize/medianFirst30` = 19.6: medianFirst30
- `raw/forecast.json#/facts/tradeSize/medianLast30` = 54.1: medianLast30
- `raw/forecast.json#/facts/tradeSize/swapsFirst30` = 15,401: swapsFirst30
- `raw/forecast.json#/facts/tradeSize/swapsLast30` = 17,382: swapsLast30

## Data checks and cost

- `raw/manifest.json#/crossChecks/0/daysEqual` = 369: transactions_daily.tx_total against transactions_signers_daily.tx_count: days equal out of 369
- `raw/manifest.json#/crossChecks/1/daysEqual` = 369: transactions_daily.signers_total against transactions_signers_daily.distinct_signers: days equal out of 369
- `raw/manifest.json#/crossChecks/2/daysEqual` = 369: transactions_daily.tx_total against account_scan_daily.tx_total: days equal out of 369
- `raw/manifest.json#/crossChecks/3/daysEqual` = 369: intents_tx_daily.value against account_scan_daily.tx_intents: days equal out of 369
- `raw/manifest.json#/crossChecks/4/daysEqual` = 369: transactions_daily.tx_organic against account_scan_daily.tx_organic: days equal out of 369
- `raw/manifest.json#/crossChecks/5/daysEqual` = 369: transactions_daily.signers_organic against account_scan_daily.signers_organic: days equal out of 369
- `raw/manifest.json#/crossChecks/6/daysEqual` = 369: tail_daily.tail_tx against account_scan_daily.tail_tx: days equal out of 369
- `raw/manifest.json#/crossChecks/7/daysEqual` = 369: tail_daily.tail_signers against account_scan_daily.tail_signers: days equal out of 369
- `raw/manifest.json#/crossChecks/8/daysEqual` = 369: transactions_daily.tx_head against account_scan_daily.head_tx: days equal out of 369
- `raw/manifest.json#/crossChecks/9/daysEqual` = 369: transactions_daily.tx_top10 against account_scan_daily.top10_tx: days equal out of 369
- `raw/manifest.json#/bigQueryQueries/0/bytesBilled` = 19,426,967,552: transactions_signers_daily: bytes billed
- `raw/manifest.json#/bigQueryQueries/1/bytesBilled` = 37,705,744,384: account_scan_daily: bytes billed
- `raw/manifest.json#/internalChecks/organicEqualsHeadPlusTail/daysEqual` = 369: days on which organic = head + tail exactly

## Fee inputs

- thesis/raw/fees/manifest.json does not exist yet: no toll-booth number is available; rebuild when it appears.
