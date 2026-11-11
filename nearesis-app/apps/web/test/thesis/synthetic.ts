/**
 * TEST-ONLY deterministic SYNTHETIC research artifacts and capsule record. Never imported by app code; the web app
 * reads these only from a file path given to the test server, and relabels them SYNTHETIC. The numbers are fixture
 * values chosen to exercise the UI, not research results.
 */
import { createHash } from "node:crypto";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

export function syntheticArtifacts(capsuleId: string | null = "cap-synthetic-1") {
  const lags = [-14, -7, 0, 7, 14];
  return {
    artifactSetId: "synthetic-artifacts-1",
    producer: "test fixture (SYNTHETIC)",
    producedAt: "2026-11-11T00:00:00Z",
    sourceLabel: "SYNTHETIC",
    question: "Is NEAR Intents activity a better leading indicator of adoption than NEAR token price?",
    hypothesis: {
      id: "H1",
      statement:
        "Daily completed 1Click swaps lead successful NEAR transactions by 7 days more strongly than NEAR close price does.",
      preregistrationHash: h("synthetic-prereg"),
      preregisteredAt: "2026-11-01T00:00:00Z",
      falsification: [
        {
          id: "F1",
          criterion:
            "Out-of-sample MAE of the Intents model is not lower than the price model by at least 5%.",
          status: "not_triggered",
          resultId: "M2",
        },
        {
          id: "F2",
          criterion: "Peak lagged correlation for swaps → tx is at lag ≤ 0.",
          status: "not_evaluated",
          resultId: null,
        },
      ],
    },
    verdict: {
      status: "INSUFFICIENT_DATA",
      summary: "Fixture verdict for UI testing; the holdout is too short to conclude.",
      resultIds: ["M2"],
    },
    lagResults: lags.flatMap((lag, i) => [
      {
        id: `L-swaps-${lag}`,
        leader: "swaps",
        follower: "tx",
        lagDays: lag,
        estimate: [0.05, 0.12, 0.2, 0.31, 0.18][i]!,
        ciLow: null,
        ciHigh: null,
        pValue: null,
        n: 60 - Math.abs(lag),
        method: "Pearson on first differences (fixture)",
      },
      {
        id: `L-price-${lag}`,
        leader: "price",
        follower: "tx",
        lagDays: lag,
        estimate: [0.02, 0.04, 0.09, 0.06, 0.01][i]!,
        ciLow: -0.2,
        ciHigh: 0.3,
        pValue: 0.41,
        n: 60 - Math.abs(lag),
        method: "Pearson on first differences (fixture)",
      },
    ]),
    models: [
      {
        id: "M0",
        name: "Seasonal naive",
        target: "tx",
        features: [],
        holdout: { from: "2026-10-20", to: "2026-11-09" },
        metric: "MAE",
        value: 1520.4,
        baseline: true,
        n: 21,
      },
      {
        id: "M1",
        name: "Ridge on price lags",
        target: "tx",
        features: ["price_l7"],
        holdout: { from: "2026-10-20", to: "2026-11-09" },
        metric: "MAE",
        value: 1490.2,
        baseline: false,
        n: 21,
      },
      {
        id: "M2",
        name: "Ridge on swaps lags",
        target: "tx",
        features: ["swaps_l7"],
        holdout: { from: "2026-10-20", to: "2026-11-09" },
        metric: "MAE",
        value: null,
        baseline: false,
        n: 21,
      },
    ],
    evidence: [
      {
        id: "E1",
        side: "bull",
        claimClass: "derived",
        text: "Swaps → tx correlation peaks at a 7-day lead.",
        resultIds: ["L-swaps-7"],
        graphNodeId: "q1",
      },
      {
        id: "E2",
        side: "bull",
        claimClass: "interpretation",
        text: "Intents usage may precede on-chain adoption because routing demand arrives before settlement.",
        resultIds: ["L-swaps-7"],
        graphNodeId: null,
      },
      {
        id: "E3",
        side: "bear",
        claimClass: "derived",
        text: "The price model beats the seasonal baseline.",
        resultIds: ["M1"],
        graphNodeId: null,
      },
      {
        id: "E4",
        side: "bear",
        claimClass: "derived",
        text: "Private settlement after 2026-10-27 hides part of the swap series.",
        resultIds: ["R-missing"],
        graphNodeId: null,
      },
    ],
    limitations: [
      "Fixture values only.",
      "Explorer covers 1Click, not all Intents.",
      "Signer counts are a proxy for users.",
    ],
    capsuleId,
  };
}

export function syntheticCapsule(over: { outlayer?: Record<string, unknown> } = {}) {
  return {
    capsuleId: "cap-synthetic-1",
    title: "Intents vs price as a leading indicator of NEAR adoption (fixture capsule)",
    sourceLabel: "SYNTHETIC",
    createdAt: "2026-11-11T00:00:00Z",
    claims: [
      {
        id: "C1",
        text: "Swaps → tx lagged correlation at 7 days is 0.31 on the fixture window.",
        claimClass: "derived",
        resultIds: ["R1"],
      },
      {
        id: "C2",
        text: "Intents activity is the better leading indicator.",
        claimClass: "interpretation",
        resultIds: ["R9"],
      },
      { id: "C3", text: "Intents activity leads adoption.", claimClass: "hypothesis", resultIds: [] },
    ],
    results: [
      {
        id: "R1",
        label: "corr(swaps_t, tx_t+7)",
        value: "0.31",
        unit: null,
        computation: "Pearson on first differences, n=53",
      },
      {
        id: "R2",
        label: "MAE seasonal naive",
        value: "1520.4",
        unit: "tx",
        computation: "holdout 2026-10-20..2026-11-09",
      },
    ],
    hashes: {
      preregistrationHash: h("synthetic-prereg"),
      sourceSnapshotHash: h("snap"),
      semanticModelHash: h("model"),
      analysisCodeCommit: "1f2c295",
      containerDigest: null,
      resultManifestHash: h("results"),
    },
    verification: {
      local: {
        status: "reproduced",
        method: "pnpm research:rebuild on frozen snapshot; result manifest hash compared",
        checkedAt: "2026-11-11T01:00:00Z",
        detail: "Result manifest hash identical on rebuild.",
      },
      outlayer: {
        status: "verified",
        method: "OutLayer TDX attestation of WASM recomputation",
        jobId: null,
        checkedAt: null,
        detail: "Record claims verified without a job (deliberately malformed fixture).",
        ...(over.outlayer ?? {}),
      },
      failures: [
        {
          at: "2026-11-11T00:30:00Z",
          kind: "attestation_missing",
          detail: "No OutLayer job id for this capsule.",
        },
      ],
    },
    provenance: [
      { id: "src", kind: "source", label: "NEAR Intents Explorer", hash: null, parents: [] },
      { id: "snap", kind: "snapshot", label: "fx.snapshot.p02-baseline", hash: h("snap"), parents: ["src"] },
      {
        id: "q1",
        kind: "query",
        label: "intents.oneclick_completed_swap_count by day",
        hash: h("q1"),
        parents: ["snap"],
      },
      { id: "R1", kind: "result", label: "corr(swaps_t, tx_t+7)", hash: h("r1"), parents: ["q1", "code"] },
      { id: "code", kind: "code", label: "services/research @ 1f2c295", hash: null, parents: [] },
      { id: "C1", kind: "claim", label: "Claim C1", hash: null, parents: ["R1", "ghost"] },
    ],
    rebuild: {
      command: "pnpm research:rebuild --snapshot fx.snapshot.p02-baseline",
      snapshotId: "fx.snapshot.p02-baseline",
      steps: [
        "Install with the lockfile.",
        "Run the command offline; no credentials are needed.",
        "Compare the result manifest hash.",
      ],
    },
    exports: [
      { label: "Research package (fixture)", href: "/exports/cap-synthetic-1.json", sha256: h("export") },
      { label: "Unsafe link", href: "javascript:alert(1)", sha256: null },
    ],
    limitations: ["Fixture record for UI tests.", "No OutLayer proof exists for any capsule yet."],
  };
}
