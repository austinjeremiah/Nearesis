# Nearesis user guide

Nearesis is a research workspace for one question at a time, for example: _is NEAR Intents activity a better leading indicator of NEAR adoption than the NEAR token price?_ It shows observed data, the statistics a research engine computed from it, and what an agent or a person concluded. It keeps each of those clearly labelled.

- [Getting started](GETTING_STARTED.md): sign in, workspaces, the canvas and the research pages.
- [Reading the research pages](RESEARCH_PAGES.md): the thesis dashboard, evidence graph, time machine and research capsules.
- [Known limitations](KNOWN_LIMITATIONS.md): what the product does not do yet, and where data is partial.

## Labels you will see everywhere

| Label                      | Meaning                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| **SYNTHETIC**              | Built from labelled fixture data. It demonstrates the method and is not evidence about NEAR. |
| **LIVE**                   | Read from the live data layer, subject to the coverage shown next to it.                     |
| **Observed fact**          | A value returned by a certified query, with its source and window.                           |
| **Derived statistic**      | A number the research engine computed (for example an out-of-sample error difference).       |
| **Agent interpretation**   | A reading of the evidence by an agent. It is not a fact.                                     |
| **Hypothesis**             | A pre-registered statement that is being tested.                                             |
| **Unsupported or unknown** | No persisted evidence backs it, or the evidence it cites is missing.                         |

Missing data is always shown as missing, never as zero. A value that cannot be computed is reported as "not reported" or "unavailable".
