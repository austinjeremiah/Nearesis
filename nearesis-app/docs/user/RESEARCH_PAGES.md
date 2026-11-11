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
- **Model comparison by horizon.** Out-of-sample error of each candidate against the baseline, with confidence intervals, adjusted p-values and FDR outcome.
- **Falsification checks**: the placebo test and the lag comparison.
- **Evidence and counterevidence** as published by the engine.
- **Input snapshot coverage and limitations.**

If no capsule is published, or the run file does not match its hash, the page says the answer is unknown and shows no statistics.

### Reproducibility and export

- **Re-run queries and compare result hashes** re-executes every certified query and reports whether results are identical.
- **Report (JSON)** and **Series (CSV)** download exactly the values on the page. The report's SHA-256 is shown.

## Evidence graph (`/w/<workspace>/evidence`)

Nodes are typed: hypothesis, claim, statistical result, observation, query, model, source, verification artifact, marker and agent. Edges use the seven evidence relations.

| Look              | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| Red dashed border | Unsupported claim. The inspector lists the missing provenance. |
| Double border     | Contradicted claim.                                            |
| Dotted border     | Claim support unknown (for example in a branch view).          |
| Amber             | Recheck required after a semantic-version change.              |
| Struck-through    | Tombstone: an endpoint was removed or never persisted.         |

Use the node list on the left for keyboard navigation. Filter by kind, state or text.

Dragging a node saves its position only and never changes evidence relations. The **View** menu opens a snapshot (read-only, with its data vintage) or a branch.

## Time machine (`/w/<workspace>/history`)

- **Timeline.** Events, snapshots, branches, merges and semantic-version changes.
- **Snapshots.** Capture one with a label, and optionally pin a source manifest hash. A snapshot view always states its data vintage. If it cannot be reconstructed it says `vintage_unavailable`; it never shows today's data instead.
- **Compare** two snapshots to see object changes and semantic-version changes.
- **Branches** are created from a snapshot. Edits on a branch do not touch main.
- **Merge proposals** list:
  - the changes, with panel changes and edge deletions marked "will be deferred, not applied";
  - the conflicts, with "keep branch / keep main / keep both".

  Accept stays disabled until every conflict is resolved. After accepting, the page lists what was actually deferred.

## Research capsules (`/w/<workspace>/capsule`)

A capsule packages a result with its data, code and computation hashes, provenance and rebuild command. Verification has two separate parts:

- **Local reproducibility.** The same inputs and code rebuilt the same result hashes.
- **OutLayer-backed proof.** A TEE attestation was cryptographically verified. It is shown as verified only with a job id and a check time.

Neither part proves the source data is correct. Exports are served with their recorded SHA-256.
