# Reading the research pages

## Investment thesis (`/w/<workspace>/thesis`)

### Time range and core metrics

Choose a time range: the date fields, or 30, 90 or 180 days. Core metrics show, for each certified series:

- the latest observed value;
- how many days in the range were observed;
- how many are missing;
- the source watermark.

A gateway refusal, such as a cost cap, is shown as a refusal. It is not an empty chart.

### Charts and chart records

The comparison chart indexes each series to 100 at its first observed day so that different units share one axis. The index is a display transform, not a statistic.

Every chart has a **chart record** listing:

- source and certified query (with hash);
- metric definition and window;
- snapshot and result hash;
- computation;
- an observed-fact sentence and limitations.

### Research results

Research results come from the latest published **research capsule**. That is the research engine's run file, checked against the capsule's hash. The page shows:

- **Verdict and evidence strength**, plus the hypothesis and its pre-registration hash.
- **Model comparison by horizon.** Out-of-sample error of each candidate against the baseline, with confidence intervals and a **Conclusion** column (see below).
- **Statistical inference.** Whether the primary statistical claim is supported, the inference method and version, the run's label and the calibration reference hash.
- **Falsification checks**: the placebo test and the lag comparison.
- **Evidence and counterevidence** as published by the engine.
- **Input snapshot coverage and limitations.**

If no capsule is published, or the run file does not match its hash, the page says the answer is unknown and shows no statistics.

### Comparison conclusions

Each comparison shows only the conclusions its inference record allows. They are kept apart:

| Conclusion                                                  | When it is shown                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **lower observed forecast error**                           | The candidate's observed error was lower. This is a description of the sample, not a statistical finding. |
| **evidence supports a statistically meaningful difference** | Only when the inference status is `VALID` and the method allows a significance claim.                     |
| **evidence insufficient to distinguish the models**         | The test ran but the data cannot tell the models apart; the reason is shown.                              |
| **comparison method not validated**                         | The method is not valid for this comparison (for example nested models); the reason is shown.             |
| **comparison invalid: input not usable**                    | The input could not be used (for example a degenerate loss differential).                                 |

The pages never derive significance from a p-value alone and never use causal wording: these are predictive comparisons. The same conclusions appear on the capsule page.

### Reproducibility and export

- **Re-run queries and compare result hashes** re-executes every certified query and reports whether results are identical.
- **Report (JSON)** and **Series (CSV)** download exactly the values on the page. The report's SHA-256 is shown.

## Evidence graph (`/w/<workspace>/evidence`)

Nodes are typed: hypothesis, claim, statistical result, observation, query, model, source, verification artifact, marker and agent. Edges use the seven evidence relations.

| Look                         | Meaning                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| Red dashed border            | Unsupported claim. The inspector lists the missing provenance.       |
| Double border                | Contradicted claim.                                                  |
| Dotted border                | Claim support unknown (for example in a branch view).                |
| Amber                        | Recheck required after a semantic-version change.                    |
| Struck-through               | Tombstone: a payload was deleted or an endpoint was never persisted. |
| "also: Evidence unavailable" | A payload this claim relies on was deleted under retention.          |

Use the node list on the left for keyboard navigation. The inspector also shows **reviewer comments** on the node and lets you add one. Filter by kind, state or text.

Selecting a stored item shows what the server holds for it. A deleted payload shows **tombstone metadata only**: content hash, deletion time and reason. The inspector also shows the server's **missing provenance** list and, for web evidence, its **confidence tier** (`unverified` whenever an element is missing).

Below the node list:

- **Publication** lists claims under **UNSUPPORTED** (excluded from supported publication), each with what it is missing.
- **Impact of a metric change**: enter a metric id to list the nodes pinned to an older version and everything that depends on them, by depth, with dependency cycles listed. Nodes you are not allowed to see are left out entirely.

Dragging a node saves its position only and never changes evidence relations. The **View** menu opens a snapshot (read-only, with its data vintage) or a branch.

## Time machine (`/w/<workspace>/history`)

- **Timeline.** Events, snapshots, branches, merges and semantic-version changes. Each entry says who made it: **human**, **agent** or **service**; filter by either.
- **Reconstruct from the event log.** Choose a revision (or "reconstruct" on a timeline event) to rebuild the canvas and evidence graph by replaying the journal. Panels with no recorded data vintage are shown as `vintage_unavailable`; the page states whether the result is an exact reproduction. **Export reconstruction file** downloads the file with its content hash.
- **Snapshots.** Capture one with a label, and optionally pin a source manifest hash. A snapshot view always states its data vintage. If it cannot be reconstructed it says `vintage_unavailable`; it never shows today's data instead.
- **Compare** two snapshots to see object changes and semantic-version changes.
- **Branches** are created from a snapshot. Edits on a branch do not touch main.
- **Merge proposals** list:
  - the changes, with panel changes and edge deletions marked "will be deferred, not applied";
  - the conflicts, with "keep branch / keep main / keep both".

  Items excluded by policy (for example a metric version that crosses a major version) are listed separately and are not merged. Accept stays disabled until every conflict is resolved. After accepting, the page lists what was actually deferred.

## Shared layout (`/w/<workspace>/collab`)

Panel positions and a shared note are edited together in real time by everyone with edit rights. Panels themselves, evidence and access change only through workspace commands.

- **Offline.** Edits are kept in your tab and sent when the connection returns. The page shows how many are waiting.
- **Reconciliation.** After reconnecting, the layout is checked against the canvas the event log records. A panel deleted on the canvas is dropped from the layout and listed; a layout move never brings it back.
- **Viewers** can watch but not edit: a refused edit is reported and not kept.
- Presence ("editing Panel 2") is visible only inside the workspace.

## Research capsules (`/w/<workspace>/capsule`)

A capsule packages a result with its data, code and computation hashes, provenance and rebuild command. Verification has two separate parts:

- **Local reproducibility.** The same inputs and code rebuilt the same result hashes.
- **OutLayer-backed proof.** A TEE attestation was cryptographically verified. It is shown as verified only with a job id and a check time.

Neither part proves the source data is correct. Exports are served with their recorded SHA-256.
