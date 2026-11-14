# Known limitations

This page lists what the product does not do yet, or does only partially. It is updated with each release. Nothing here is hidden in the interface: each item below also shows up on screen where it applies.

## Data and research

- **Live coverage is partial.**
  - On the live layer, NEAR transactions, signers and price are mostly complete for recent months.
  - Over long windows, the 1Click swap and volume series can be refused by the semantic gateway's cost cap. The thesis page shows the refusal (`COST_CAP`); it does not show an empty or zero series.
  - Live volume counts only swaps whose USD value is known.
- **Explorer covers 1Click only**, not all NEAR Intents activity. After the private-settlement change (2026-10-27), public transaction hashes are shield and unshield boundaries, not swaps.
- **Research results available today come from labelled synthetic fixtures** (claim scope: no live claim). They demonstrate the method and are not evidence about NEAR. Live research runs are capped at `INSUFFICIENT_DATA` until complete organic-activity data exists.
- **Research results are read from a published capsule's run file**, served by the API for the capsule's own organisation and workspace and checked against the capsule manifest hash.
- **Runs published before the inference amendment carry no inference record.** They show "no inference record: no statistical conclusion" rather than a conclusion.

## Verification

- **No OutLayer proof exists for any capsule yet.** Capsules show local reproducibility separately and are never shown as cryptographically verified without a job id and check time.

## Evidence graph and time machine

- **Snapshots cover the main branch only.**
- **Branch views show claim support as "unknown"**, because the API does not compute support for branches.
- **Merges into main apply evidence and metric changes.** Panel changes and edge deletions are deferred and listed, not applied.
- **Branch editing in the interface is limited to relabelling a node.** Other branch operations exist in the API only.
- **Reviewer comments attach to evidence nodes**, not to merge proposals. They are read and added in the evidence graph's node inspector.
- **Metric version changes that cross a major version are excluded from merges by policy** (`SEMVER_INCOMPATIBLE`) and listed on the proposal, not merged.
- **Snapshot staleness is based on canvas revisions and semantic versions.** A snapshot taken before new evidence was added may not be marked stale, but its view still shows the snapshot as captured.
- **Shared layout syncs by polling** (about twice a second) over HTTP rather than a push connection. Presence is held in one API process and expires after a short idle time.
- **Shared layout covers panel positions and one shared note.** The canvas's own grid layout is still changed through canvas commands; the two are reconciled, not merged.
- **Reconstruction replays evidence and canvas events only.** Merges, restrictions, retention deletions and resolved rechecks are listed as not replayable and mark the result as not an exact reproduction.

## Interface

- **Canvas panels show data only for queries the semantic layer has recorded.** A panel whose query hash is unknown shows `QUERY_UNRESOLVED` instead of guessing.
- **Lens segment and route filters are listed on affected panels as not applied on the canvas.** Lenses filter by time only.
- **Production builds require all packages to type-check.** While another package fails, browser tests run against the development server.
