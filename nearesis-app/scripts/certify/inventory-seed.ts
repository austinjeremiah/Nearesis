/**
 * Curated seed of the requirement inventory. Every entry is a short paraphrase with a chapter/section reference, never
 * Bible text. `scripts/certify/build-inventory.ts` merges this seed with tests/TEST_INDEX.json, the recorded evidence and
 * the code on disk, and writes tests/REQUIREMENTS_INVENTORY.json (committed, so a clean checkout has it).
 *
 * Fields a human declares: where the requirement is documented, which engine owns it, the code that implements it, the
 * tests that prove it, and (only when the code cannot show it) a partial/external judgement with the exact blocker.
 * Implementation status is never declared "done" here: the builder checks that the code paths (and `#symbol` markers
 * inside them) exist and that the bound tests are certified.
 */
export type Engine = "ENGINE_A" | "ENGINE_B" | "FRONTEND" | "OWNER";

export interface SeedOpts {
  /** Code exists but the requirement is only partly delivered. */
  partial?: boolean;
  /** Final verification needs something outside the repository (approval, new observations, other team). */
  external?: boolean;
  /** What is not integrated yet. */
  missing?: string;
  /** The exact blocker. */
  blocker?: string;
  /** Requirement ids this one is built on. */
  deps?: string[];
  /** Unit or integration test files (relative to nearesis-app) that are not canonical acceptance tests. */
  files?: string[];
}
export interface SeedReq {
  id: string;
  ref: string;
  engine: Engine;
  summary: string;
  code: string[];
  tests: string[];
  opts: SeedOpts;
}

const A: Engine = "ENGINE_A";
const B: Engine = "ENGINE_B";
const FE: Engine = "FRONTEND";

export const SEED: SeedReq[] = [];
const r = (
  id: string,
  ref: string,
  engine: Engine,
  summary: string,
  code: string[],
  tests: string[],
  opts: SeedOpts = {},
) => {
  SEED.push({ id, ref, engine, summary, code, tests, opts });
};

// ---------------------------------------------------------------------------------------------------------------
// Chapters 00-03: mandate, product, thesis, architecture
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-CH00-01",
  "ch00 Architecture principles 1, 9",
  A,
  "Every observation carries provider, payload hash, retrieval and event time; fixtures are labelled and never presented as production data.",
  ["services/ingestion/src/archive", "services/ingestion/src/hash.ts", "packages/test-fixtures"],
  ["D06", "D12", "D14", "B02"],
);
r(
  "REQ-CH00-02",
  "ch00 Principle 2",
  B,
  "Semantics are governed by certified Cube metrics; agents never send unrestricted SQL to production.",
  ["packages/semantic-gateway/src/validate.ts", "services/analytics/cube/model"],
  ["S03", "S04", "S14", "SEC09"],
);
r(
  "REQ-CH00-03",
  "ch00 Principle 3",
  A,
  "Agents propose, the kernel authorizes: all tools pass a capability gateway, and approval is mandatory for spend, secrets, mainnet and publishing.",
  [
    "packages/kernel/src/gateway.ts",
    "packages/kernel/src/approvals.ts",
    "packages/agent-runtime/src/grants.ts",
  ],
  ["K10", "A07", "A11", "SEC04"],
);
r(
  "REQ-CH00-04",
  "ch00 Principle 4",
  A,
  "Workspaces are isolated: tasks, memory, markers, runs and findings are workspace-scoped; shared metrics go through an ACL-checked gateway.",
  [
    "packages/kernel/src/db",
    "packages/agent-runtime/src/tenant.ts",
    "packages/semantic-gateway/src/gateway.ts",
  ],
  ["K04", "S16", "A17", "SEC03", "SEC19"],
);
r(
  "REQ-CH00-05",
  "ch00 Principle 5",
  B,
  "Every visual is a validated declarative panel spec with query id, model version, units and watermark; no arbitrary JSX.",
  ["packages/canvas-schema/src/panel.ts", "packages/canvas-schema/src/compiler.ts"],
  ["C02", "C03", "C09", "C17"],
);
r(
  "REQ-CH00-06",
  "ch00 Principle 6",
  A,
  "Durable workflows with replay, schedules, cancellation and idempotency keys for every external side effect.",
  ["packages/workflow/src/workflows.ts", "packages/workflow/src/worker.ts", "packages/kernel/src/outbox.ts"],
  ["K03", "K09", "A02", "A13", "A18"],
);
r(
  "REQ-CH00-07",
  "ch00 Principle 7",
  A,
  "Verification is layered: reproducibility, input integrity, TEE attestation and chain commitment are separate claims and never conflated.",
  ["packages/capsule/src/attestation.ts", "packages/kernel/src/verified-state.ts"],
  ["V09", "V10", "SEC14", "B10"],
);
r(
  "REQ-CH00-08",
  "ch00 Principle 8",
  B,
  "Pre-register hypothesis, loss, split and falsification threshold; report null or contradicting results honestly.",
  ["services/research/nearesis_research", "docs/research/PREREGISTRATION.md"],
  ["Q15", "Q16", "Q17", "Q22"],
);
r(
  "REQ-CH00-09",
  "ch00 Principle 10",
  A,
  "Each phase leaves tests, logs, findings and a gate decision as durable artifacts.",
  ["scripts/accept.ts", "scripts/conformance.ts", "packages/acceptance"],
  ["N07"],
);
r(
  "REQ-CH00-10",
  "ch00 Network wording",
  A,
  "A minimal NEAR mainnet smoke follows testnet integration; a separate Base read adapter is isolated and read-only.",
  ["plugins/chain-commit", "scripts/release/base.ts"],
  ["N03", "N05", "N12"],
  {
    external: true,
    blocker:
      "Mainnet transaction needs the owner's per-write approval record (N08); no mainnet write has been approved or performed.",
  },
);
r(
  "REQ-CH00-11",
  "ch00 Definition of done",
  A,
  "The same raw snapshot, commit and metric versions rebuild identical tables and charts with one command.",
  ["packages/capsule/src/cli.ts", "packages/capsule/src/verify.ts"],
  ["V01", "V12", "B06", "B14"],
);

r(
  "REQ-CH01-01",
  "ch01 Product position and objects",
  B,
  "A workspace has one objective and typed objects (panels, markers, lenses, claims, branches, evidence).",
  ["packages/contracts/src/canvas.ts", "packages/kernel/src/workspace.ts"],
  ["K01", "C04", "M09", "W07"],
);
r(
  "REQ-CH01-02",
  "ch01 Personas and permissions",
  A,
  "Role-scoped permissions for owner, analyst, reviewer, agent, maintainer and public reader.",
  ["packages/kernel/src/auth.ts", "packages/kernel/src/gateway.ts"],
  ["K01", "K04", "A11", "SEC19"],
);
r(
  "REQ-CH01-03",
  "ch01 Journey A (blank to thesis)",
  A,
  "A blank workspace reaches four panels, grounded explanations and a signed or explicitly unsigned capsule.",
  ["packages/workflow/src/workflows.ts", "plugins/near-thesis/src", "tests/integration/B01.accept.test.ts"],
  ["B01", "B05", "C01"],
);
r(
  "REQ-CH01-04",
  "ch01 Journey B (chart to investigation)",
  A,
  "A chart selection becomes a marker and a scoped child research workflow returning evidence-linked output.",
  ["packages/kernel/src/monitoring/tasks.ts", "apps/api/src/marker-run-port.ts"],
  ["M01", "M02", "M11", "C13"],
);
r(
  "REQ-CH01-05",
  "ch01 Journey C (continuous monitoring)",
  A,
  "A deterministic rule engine wakes a deduplicated, leased agent on a breach and attaches a report.",
  ["packages/kernel/src/monitoring", "apps/api/src/monitor-feeder.ts"],
  ["M03", "M05", "M13", "M15", "PERF07"],
);
r(
  "REQ-CH01-06",
  "ch01 Journey D (adversarial comparison)",
  B,
  "Bull/bear branches share frozen data and budget; an auditor adjudicates against the pre-registered protocol.",
  ["packages/agent-runtime/src/graphs/adversarial.ts", "services/research/nearesis_research/adversarial.py"],
  ["Q19", "B15", "W13"],
);
r(
  "REQ-CH01-07",
  "ch01 Journey E (time machine)",
  A,
  "A prior snapshot reconstructs workspace state; unavailable vintage is labelled historical-only.",
  ["packages/kernel/src/history/reconstruct.ts", "packages/kernel/src/history/snapshots.ts"],
  ["W05", "W10", "W11"],
);
r(
  "REQ-CH01-08",
  "ch01 Interaction rules",
  FE,
  "Charts expose window, units, scale, data age, exclusions and provider limits; keyboard accessible.",
  ["apps/web/src/components/Panel.tsx", "packages/ui/src/chart"],
  ["C07", "C08", "C14", "C18", "V15"],
  { missing: "Browser-rendered halves of C-series need the frontend developer (cross-layer gate)." },
);
r(
  "REQ-CH01-09",
  "ch01 Exclusions",
  A,
  "No trading, custody or unrestricted signing; quote sampling is dry:true and non-executing.",
  ["services/ingestion/src/http/quote-wire-guard.ts", "plugins/chain-commit/src/policy.ts"],
  ["D07", "SEC04", "SEC15", "N02"],
);
r(
  "REQ-CH01-10",
  "ch01 Demonstration acceptance",
  A,
  "A fresh evaluator completes the scripted blank-to-export sequence and replays the claimed result.",
  ["tests/integration/B01.accept.test.ts", "tests/integration/B14.accept.test.ts", "scripts/demo"],
  ["B01", "B14", "B05"],
);

r(
  "REQ-CH02-01",
  "ch02 Plugin contract",
  A,
  "plugin.near.thesis@1 registers metric packs, templates, adapters, experiments and report schema; scheduling and state stay in the kernel.",
  ["plugins/near-thesis/src/manifest.ts", "plugins/near-thesis/src/capabilities.ts"],
  ["B04", "B11"],
);
r(
  "REQ-CH02-02",
  "ch02 Research questions H1-H5",
  B,
  "Distinct hypotheses H1 predictive signal, H2 durability, H3 composition, H4 execution quality, H5 observable boundary.",
  ["docs/research/PREREGISTRATION.md", "services/research/nearesis_research"],
  ["Q01", "Q02", "Q05", "Q22"],
  {
    partial: true,
    missing:
      "H2 fee reconstruction (gas and fee economics) and H4 route-quality metrics depend on the economics and Intents intelligence work, which is not in the code yet.",
    blocker: "Wave 4 economics (final_master_prompt s7) and Intents intelligence (s8) not delivered.",
  },
);
r(
  "REQ-CH02-03",
  "ch02 Preregistration protocol",
  B,
  "PREREGISTRATION.md freezes the analysis, is hashed canonically and committed on NEAR testnet.",
  [
    "docs/research/PREREGISTRATION.md",
    "docs/research/PREREGISTRATION.freeze.json",
    "packages/capsule/src/prereg-commit.ts",
  ],
  ["Q16", "V05", "V13", "N01"],
);
r(
  "REQ-CH02-04",
  "ch02 Methodology",
  B,
  "UTC-day unit, vintage-safe features, four forecast models, rolling origin plus lockbox, robustness matrix.",
  [
    "services/research/nearesis_research/models.py",
    "services/research/nearesis_research/experiment.py",
    "services/research/nearesis_research/leakage.py",
  ],
  ["Q03", "Q04", "Q06", "Q11", "Q12", "Q17", "Q18"],
);
r(
  "REQ-CH02-05",
  "ch02 Segment attribution",
  B,
  "Segments are labels with source, version, confidence and double-count policy; asset registry versioned by effective date.",
  ["services/ingestion/src/registry", "services/research/nearesis_research/live_segments.py"],
  ["D08", "D17", "Q06"],
  {
    partial: true,
    missing:
      "The source-backed, time-versioned ecosystem entity registry with attribution coverage (final_master_prompt s5) is not built.",
    blocker: "Wave 4 worker A17 (entity registry) has not delivered.",
  },
);
r(
  "REQ-CH02-06",
  "ch02 Required deliverables",
  A,
  "SQL, sources, snapshot manifest, DATA/METRICS/THESIS/PREREG/EXPERIMENTS/LIMITATIONS docs, memo, offline dashboard, capsule and publication.",
  [
    "packages/capsule/src/bundle.ts",
    "packages/capsule/src/memo.ts",
    "packages/capsule/src/site.ts",
    "packages/capsule/src/publish.ts",
  ],
  ["V07", "V12", "V16", "Q22"],
);
r(
  "REQ-CH02-07",
  "ch02 Rejection cases",
  B,
  "Claims are blocked on target-in-predictor, future data, hidden pagination gap, untimed FX, private-as-public and numbers absent from results.",
  ["services/research/nearesis_research/leakage.py", "packages/capsule/src/claims-scan.ts"],
  ["Q03", "Q10", "Q13", "V06", "B13"],
);

r(
  "REQ-CH03-01",
  "ch03 Stack",
  A,
  "Node 24 TypeScript, Fastify/Zod API, Postgres with RLS, Temporal, LangGraph, Cube/ClickHouse, Redis, Python quant workers.",
  ["package.json", "pnpm-workspace.yaml", "pyproject.toml", "infrastructure/compose"],
  ["BOOT01", "S13", "PERF04"],
);
r(
  "REQ-CH03-02",
  "ch03 Planes and data flow",
  A,
  "Control, data and execution planes; raw immutable object to normalized facts to Cube to typed envelope to canvas.",
  [
    "services/ingestion/src/archive",
    "services/ingestion/src/normalize.ts",
    "packages/semantic-gateway/src/gateway.ts",
    "packages/canvas-schema/src/compiler.ts",
  ],
  ["D12", "S01", "C01", "B02"],
);
r(
  "REQ-CH03-03",
  "ch03 Multi-environment plan",
  A,
  "Local mocks, testnet staging, gated live collection; no swaps placed by development replay.",
  ["infrastructure/compose", "scripts/release/images.ts", "services/ingestion/src/scheduler/config.ts"],
  ["D15", "D16", "N06"],
);
r(
  "REQ-CH03-04",
  "ch03 Repository boundary",
  A,
  "Monorepo packages follow the documented boundary (kernel, plugin-sdk, canvas-schema, fixtures, infra).",
  [
    "packages/kernel",
    "packages/plugin-sdk",
    "packages/canvas-schema",
    "packages/test-fixtures",
    "infrastructure",
  ],
  ["BOOT01", "B11"],
);
r(
  "REQ-CH03-05",
  "ch03 Build risk",
  A,
  "Selected technologies are tested not assumed: own MCP gateway above Cube Core; 100k-point chart case measured.",
  ["services/mcp-public/src/gateway.ts", "tests/perf/PERF02.accept.test.ts"],
  ["V08", "V17", "C18", "PERF02"],
);

// ---------------------------------------------------------------------------------------------------------------
// Chapters 04-06: kernel, agents, semantics
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-CH04-01",
  "ch04 Kernel responsibilities",
  A,
  "Kernel owns commands, versions, ACL, approvals, journal and plugin registry.",
  ["packages/kernel/src/kernel.ts", "packages/kernel/src/commands.ts", "packages/kernel/src/journal.ts"],
  ["K01", "K02", "K03", "K09"],
);
r(
  "REQ-CH04-02",
  "ch04 Manifest and signing",
  A,
  "Plugin manifests are schema-validated and signed; invalid signatures and conflicts are rejected.",
  ["packages/plugin-sdk/src/manifest.ts", "packages/plugin-sdk/src/signing.ts"],
  ["K05", "K06", "K12"],
);
r(
  "REQ-CH04-03",
  "ch04 Execution envelope and path",
  A,
  "Capability calls pass an envelope with timeout, budget and policy; disabled plugins never run.",
  ["packages/kernel/src/plugins/manager.ts", "packages/kernel/src/plugins/sandbox-exec.ts"],
  ["K07", "K08", "SEC06", "SEC12"],
);
r(
  "REQ-CH04-04",
  "ch04 Delegation and subagents",
  A,
  "Children receive grant subsets only; no expansion or unrestricted peers.",
  ["packages/kernel/src/commands.ts", "packages/agent-runtime/src/grants.ts"],
  ["K10", "A12", "M12", "SEC17"],
);
r(
  "REQ-CH04-05",
  "ch04 Compatibility and rollout",
  A,
  "Breaking changes need a major version; upgrade and rollback preserve in-flight work and pinned workspaces.",
  ["packages/kernel/src/plugins/install.ts", "packages/kernel/src/plugins/manager.ts"],
  ["K11", "K12"],
);

r(
  "REQ-CH05-01",
  "ch05 Framework decision",
  A,
  "Temporal outside, LangGraph inside an activity; no dual retry ownership.",
  [
    "packages/workflow/src/activities.ts",
    "packages/agent-runtime/src/checkpointer.ts",
    "packages/agent-runtime/src/graphs/director.ts",
  ],
  ["A13", "A14", "A02"],
);
r(
  "REQ-CH05-02",
  "ch05 State machine and roles",
  A,
  "Ten role configurations with typed tool contracts and an investigation state machine.",
  [
    "packages/agent-runtime/src/roles.ts",
    "packages/agent-runtime/src/supervisor.ts",
    "packages/agent-runtime/src/schemas.ts",
  ],
  ["A01", "A04", "A11", "A20"],
);
r(
  "REQ-CH05-03",
  "ch05 Memory tiers",
  A,
  "Working, workspace and role memory tiers with cross-workspace and cross-role isolation.",
  ["packages/agent-runtime/src/memory.ts", "packages/agent-runtime/src/tenant.ts"],
  ["A17", "W17"],
);
r(
  "REQ-CH05-04",
  "ch05 Human-in-the-loop and authority",
  A,
  "Approvals are bound to exact parameters, survive interruption and cannot be mutated.",
  ["packages/kernel/src/approvals.ts", "packages/agent-runtime/src/leases.ts"],
  ["A06", "A07", "A03", "A14"],
);
r(
  "REQ-CH05-05",
  "ch05 Inference and attestation policy",
  A,
  "Provider-neutral inference adapter, unattested output can never publish as verified, private data fails closed.",
  [
    "packages/inference/src/policy.ts",
    "packages/inference/src/gate.ts",
    "packages/agent-runtime/src/research-inference-guard.ts",
  ],
  ["A08", "A15", "A21", "SEC21"],
  {
    external: true,
    blocker:
      "A16 (live NEAR AI attested inference) is historical and disabled by ADR-20261110-004; attested publication stays impossible until an attested provider is funded. A21 (OpenRouter live) needs a live key and spend inside the USD 5 ceiling.",
  },
);
r(
  "REQ-CH05-06",
  "ch05 Budget and circuit breakers",
  A,
  "Budgets and breakers stop child spawn storms, tool loops and runaway spend.",
  [
    "packages/agent-runtime/src/ledger.ts",
    "packages/agent-runtime/src/cost",
    "packages/inference/src/spend.ts",
  ],
  ["A05", "A12", "SEC17", "PERF12"],
);
r(
  "REQ-CH05-07",
  "ch05 Testable run outcomes",
  A,
  "Cancel, kill, replay and duplicate-spawn outcomes are deterministic.",
  ["packages/workflow/src/replay.ts", "packages/workflow/src/pure.ts"],
  ["A10", "A13", "A18", "A20"],
);

r(
  "REQ-CH06-01",
  "ch06 Semantic model",
  B,
  "Certified measures and dimensions with units, grains and versions.",
  ["services/analytics/cube/model", "services/analytics/src/registry/registry.ts", "docs/metrics/METRICS.md"],
  ["S01", "S12", "S13"],
);
r(
  "REQ-CH06-02",
  "ch06 Query AST and gateway",
  B,
  "Strict typed query AST; unknown metric and unauthorized dimension are refused.",
  [
    "packages/semantic-gateway/src/validate.ts",
    "packages/semantic-gateway/src/gateway.ts",
    "packages/contracts/src/semantic.ts",
  ],
  ["S03", "S04", "S05", "S14"],
);
r(
  "REQ-CH06-03",
  "ch06 Guarded query design",
  B,
  "Bounded date range, cost estimate and partition checks; summing daily uniques is refused.",
  ["packages/semantic-gateway/src/validate.ts", "packages/semantic-gateway/src/coverage.ts"],
  ["S02", "S06", "S08", "S09", "S15"],
);
r(
  "REQ-CH06-04",
  "ch06 Design for speed",
  B,
  "Cache classes with version-aware invalidation and rollup-aware reads.",
  [
    "packages/semantic-gateway/src/cache.ts",
    "packages/semantic-gateway/src/read-cache.ts",
    "packages/semantic-gateway/src/rollup.ts",
  ],
  ["S07", "S09", "S16", "PERF01"],
);
r(
  "REQ-CH06-05",
  "ch06 Metric drift and registry review",
  B,
  "A definition change is a new version; promotions are reviewed; history is not rewritten.",
  ["services/analytics/src/registry/promotions.ts", "services/analytics/src/registry/registry.ts"],
  ["S12", "W02", "V18"],
);
r(
  "REQ-CH06-06",
  "ch06 Acceptance properties",
  B,
  "Confirmed zero, gap and partial day are distinct; duplicates do not double count.",
  ["packages/semantic-gateway/src/coverage.ts", "services/ingestion/src/normalize.ts"],
  ["S08", "S10", "S11"],
);

// ---------------------------------------------------------------------------------------------------------------
// Chapters 07-10: ingestion, quant, canvas, workspace
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-CH07-01",
  "ch07 Data topology and privacy discontinuity",
  B,
  "Public era versus private settlement regime is modelled; private settlement is a declared blind spot.",
  ["services/ingestion/src/normalize.ts", "services/ingestion/src/registry"],
  ["D08", "D09", "Q05"],
);
r(
  "REQ-CH07-02",
  "ch07 Adapters (BigQuery, Explorer, price)",
  B,
  "Partition-bounded BigQuery, rate-limited resumable Explorer paging, timestamped price candles.",
  [
    "services/ingestion/src/adapters/bigquery.ts",
    "services/ingestion/src/adapters/explorer.ts",
    "services/ingestion/src/adapters/price.ts",
  ],
  ["D01", "D02", "D03", "D04", "D10", "D13", "D18"],
);
r(
  "REQ-CH07-03",
  "ch07 Raw envelope and archive",
  B,
  "Canonical raw envelope stored as content-addressed immutable object; archive rewrite is detected.",
  ["services/ingestion/src/archive/archive.ts", "services/ingestion/src/snapshot.ts"],
  ["D06", "D12", "D14", "SEC13"],
);
r(
  "REQ-CH07-04",
  "ch07 Normalized tables",
  B,
  "Exact decimal amounts, smallest-unit unknown when conversion unproven, idempotent merge keys.",
  ["services/ingestion/src/decimal.ts", "services/ingestion/src/normalized/types.ts"],
  ["D11", "S10", "S15"],
);
r(
  "REQ-CH07-05",
  "ch07 Reconciliation",
  B,
  "Public-era matching by identifiers; unmatched and private items are labelled, not guessed.",
  ["services/ingestion/src/normalize.ts"],
  ["D09", "D17"],
  {
    partial: true,
    missing:
      "Explicit per-day reconciliation status exposed as an API (final_master_prompt s9: reconciliation status, partial-day warnings) is not integrated.",
    blocker: "Wave 4 data-freshness API work not delivered.",
  },
);
r(
  "REQ-CH07-06",
  "ch07 Backfill, late data, deletions",
  B,
  "Checkpointed backfill, crash-safe resume, late data and revision handling.",
  [
    "services/ingestion/src/backfill/orchestrator.ts",
    "services/ingestion/src/backfill/state.ts",
    "services/ingestion/src/scheduler/daily.ts",
  ],
  ["D03", "D05", "D13", "D18"],
);
r(
  "REQ-CH07-07",
  "ch07 Quality rules and pipeline ops",
  B,
  "Quality rules decide certifiable date ranges; replay works with credentials unset.",
  ["services/ingestion/src/replay.ts", "services/ingestion/src/backfill/replay-raw.ts"],
  ["D05", "D12", "D15"],
);

r(
  "REQ-CH08-01",
  "ch08 Primary experiment",
  B,
  "Chronological out-of-sample forecast comparison of Intents volume versus price returns; no causal claim.",
  ["services/research/nearesis_research/experiment.py", "services/research/nearesis_research/models.py"],
  ["Q01", "Q02", "Q11", "Q12", "Q14"],
);
r(
  "REQ-CH08-02",
  "ch08 Leakage and confounding",
  B,
  "Future data, mechanical overlap and post-treatment leakage are blocked.",
  ["services/research/nearesis_research/leakage.py"],
  ["Q03", "Q09", "Q13"],
);
r(
  "REQ-CH08-03",
  "ch08 Model grading and verdict",
  B,
  "Frozen thresholds, two verdict axes, no override; statistical significance only from a qualified procedure.",
  ["services/research/nearesis_research/verdict.py", "docs/research/PREREGISTRATION-AMENDMENT-002.md"],
  ["Q14", "Q15", "Q08"],
  {
    partial: true,
    missing:
      "Q14 corrected comparison (amendment 002) did not yield a qualified procedure; significance claims remain unavailable by design.",
    blocker:
      "ADR-20261111-003 and ADR-20261111-004: no qualifying estimator; the original Q14 failure is preserved.",
  },
);
r(
  "REQ-CH08-04",
  "ch08 Quant process isolation",
  B,
  "Quant runs in an isolated process with no agent-supplied Python.",
  ["services/research/quant_worker/worker.mjs", "infrastructure/sandbox/Dockerfile"],
  ["Q21", "SEC06"],
);
r(
  "REQ-CH08-05",
  "ch08 Experiment registry and independent verification",
  B,
  "Manifest completeness and an independent audit rerun.",
  ["services/research/nearesis_research/manifest.py", "services/research/nearesis_research/artifacts.py"],
  ["Q04", "Q20"],
);
r(
  "REQ-CH08-06",
  "ch08 Publication contract",
  B,
  "THESIS claim table with counterevidence and falsification; claims tie to computed output.",
  ["services/research/nearesis_research/narrative.py", "packages/capsule/src/claims-scan.ts"],
  ["Q10", "Q22", "B13"],
);

r(
  "REQ-CH09-01",
  "ch09 Rendering philosophy and object model",
  B,
  "Typed canvas document with panels, layout, markers and lenses.",
  [
    "packages/canvas-schema/src/panel.ts",
    "packages/canvas-schema/src/runtime.ts",
    "packages/contracts/src/canvas.ts",
  ],
  ["C01", "C02", "C04"],
);
r(
  "REQ-CH09-02",
  "ch09 Prompt to canvas contract",
  B,
  "Natural language compiles to a verified query and a reviewable patch.",
  [
    "packages/canvas-schema/src/compiler.ts",
    "packages/canvas-schema/src/patch.ts",
    "packages/workflow/src/progressive-canvas.ts",
  ],
  ["C01", "C09", "C11", "PERF06"],
);
r(
  "REQ-CH09-03",
  "ch09 Rich interactions",
  FE,
  "Range selection, undo/redo, concurrent edits and keyboard operation.",
  ["apps/web/src/components/Workspace.tsx", "apps/web/src/components/WorkspaceClient.tsx"],
  ["C05", "C06", "C08", "C13"],
  { missing: "Browser acceptance needs the frontend developer to run and review." },
);
r(
  "REQ-CH09-04",
  "ch09 Marker state machine",
  A,
  "Markers move only along specified transitions; drafts never spawn agents.",
  ["packages/kernel/src/monitoring/commands.ts", "packages/kernel/src/monitoring/catalog.ts"],
  ["M08", "M09", "M10"],
);
r(
  "REQ-CH09-05",
  "ch09 Refresh and SSE",
  B,
  "SSE with cursor replay, duplicate and slow-consumer handling.",
  ["packages/kernel/src/stream.ts", "apps/api/src/overload/sse-limiter.ts"],
  ["C15", "PERF09"],
);
r(
  "REQ-CH09-06",
  "ch09 Collaborative editing with Yjs",
  B,
  "CRDT for layout and notes only; server commands stay authoritative.",
  ["apps/api/src/collab-ws.ts", "packages/kernel/src/history/collab.ts"],
  ["W15", "W16", "W04"],
);
r(
  "REQ-CH09-07",
  "ch09 Canvas quality criteria",
  B,
  "Panel states, provenance, 100k-point series and 50-panel canvas stay responsive.",
  ["packages/ui/src/canvas", "packages/ui/src/chart"],
  ["C14", "C18", "PERF02", "PERF05"],
  {
    external: true,
    blocker: "Performance verdicts require the quiet reference machine run by the lead (ADR-20261111-002).",
  },
);

r(
  "REQ-CH10-01",
  "ch10 Bounded knowledge system and entities",
  A,
  "Tenant/workspace entities with RLS and key constraints.",
  ["packages/kernel/src/db", "infrastructure/postgres/init"],
  ["K01", "K04", "SEC03"],
);
r(
  "REQ-CH10-02",
  "ch10 Event-sourced command path",
  A,
  "Append-only commands with optimistic versions and idempotent replay.",
  ["packages/kernel/src/commands.ts", "packages/kernel/src/journal.ts"],
  ["K02", "K03", "W11"],
);
r(
  "REQ-CH10-03",
  "ch10 Evidence graph semantics",
  A,
  "Typed nodes, closed relation enum, no orphan edges, impact analysis.",
  [
    "packages/kernel/src/graph.ts",
    "packages/kernel/src/history/graph-ops.ts",
    "packages/kernel/src/history/impact.ts",
  ],
  ["W03", "W07", "W08", "W09"],
);
r(
  "REQ-CH10-04",
  "ch10 Branching and merging",
  A,
  "Branches pin an exact snapshot; merges are policy-gated proposals.",
  ["packages/kernel/src/history/branches.ts", "packages/kernel/src/history/reviews.ts"],
  ["W01", "W06", "W13", "W14"],
);
r(
  "REQ-CH10-05",
  "ch10 Temporal memory and history",
  A,
  "Revision timeline, attribution and reviewer comments over append-only history.",
  ["packages/kernel/src/history/service.ts", "packages/kernel/src/history/summaries.ts"],
  ["W12", "W17"],
);
r(
  "REQ-CH10-06",
  "ch10 Recoverability",
  A,
  "Retention with tombstones, backup and restore verified.",
  ["packages/kernel/src/history/retention.ts", "scripts/chaos/backup-restore.ts"],
  ["W18", "PERF04"],
);

// ---------------------------------------------------------------------------------------------------------------
// Chapters 11-15
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-CH11-01",
  "ch11 REST contract v1",
  A,
  "Versioned REST routes with Zod-validated bodies and typed errors.",
  ["apps/api/src/app.ts", "packages/contracts/src/api.ts", "apps/api/src/request-guards.ts"],
  ["K01", "SEC08", "SEC16"],
  {
    partial: true,
    missing:
      "A generated OpenAPI document for every route and the typed error/state taxonomy for frontend use are not published.",
    blocker: "Wave 4 worker A21 (frontend contracts, OpenAPI) has not delivered.",
  },
);
r(
  "REQ-CH11-02",
  "ch11 Event contract and SSE",
  A,
  "Typed events with cursor replay and stable envelope.",
  ["packages/contracts/src/events.ts", "packages/kernel/src/stream.ts"],
  ["C15", "PERF09"],
);
r(
  "REQ-CH11-03",
  "ch11 Typed command",
  A,
  "Commands carry id, expected version and actor; retries are idempotent.",
  ["packages/kernel/src/commands.ts", "packages/contracts/src/api.ts"],
  ["K02", "K03"],
);
r(
  "REQ-CH11-04",
  "ch11 MCP gateway",
  A,
  "First-party MCP gateway with audited, scoped, ownership-checked tools.",
  ["services/mcp-public/src/gateway.ts", "packages/kernel/src/mcp-policy.ts"],
  ["V08", "V17", "SEC12"],
);
r(
  "REQ-CH11-05",
  "ch11 API test corpus",
  A,
  "Adversarial browser-to-API and parser-abuse suites.",
  ["tests/security", "apps/api/test"],
  ["SEC08", "SEC16"],
);

r(
  "REQ-CH12-01",
  "ch12 Threat model",
  A,
  "Documented threat model with trust boundaries and execution capability matrix.",
  ["docs/security/THREAT_MODEL.md", "packages/kernel/src/sandbox.ts"],
  ["SEC01", "SEC06", "SEC12"],
);
r(
  "REQ-CH12-02",
  "ch12 Prompt injection resistance",
  A,
  "Source text is untrusted across direct, indirect and tool-response channels.",
  ["packages/agent-runtime/src/grounding.ts", "packages/agent-runtime/src/policy.ts"],
  ["A09", "SEC01", "SEC07"],
);
r(
  "REQ-CH12-03",
  "ch12 Tenant isolation and encrypted storage",
  A,
  "RLS everywhere, non-SQL surfaces isolated, protected signing material.",
  ["packages/kernel/src/db", "packages/kernel/src/redact.ts", "plugins/chain-commit/src/signer-host.ts"],
  ["SEC03", "SEC10", "SEC19", "SEC20"],
);
r(
  "REQ-CH12-04",
  "ch12 Inference privacy and classification",
  A,
  "Private classification never routes to an unapproved provider; fail closed.",
  ["packages/kernel/src/classification.ts", "packages/inference/src/policy.ts"],
  ["SEC21", "A08"],
);
r(
  "REQ-CH12-05",
  "ch12 Proof layer and chain commitment policy",
  A,
  "Attestation fails closed; chain writes need approval binding, allowlist and ceilings.",
  [
    "packages/capsule/src/attestation.ts",
    "plugins/chain-commit/src/policy.ts",
    "plugins/chain-commit/src/spend.ts",
  ],
  ["V09", "SEC14", "SEC15", "N08", "N09"],
  {
    external: true,
    blocker:
      "Live halves of SEC15/N09 need the testnet commitment target and, for mainnet, the owner's approval record (BLK-20261111-002).",
  },
);
r(
  "REQ-CH12-06",
  "ch12 Vulnerability management",
  A,
  "Pinned dependencies, SBOM, digest-pinned images and a release policy over scanner output.",
  [
    "scripts/release/vuln-scan.ts",
    "scripts/release/sbom.ts",
    "scripts/security/secret-scan.ts",
    "scripts/ci/install-trivy.sh",
  ],
  ["SEC05", "SEC11", "BOOT02"],
);
r(
  "REQ-CH12-07",
  "ch12 Security release blockers",
  A,
  "A security-critical FAIL or BLOCKED prevents release.",
  ["scripts/release/gate.ts", "packages/kernel/src/release-gate.ts"],
  ["SEC22", "N07"],
);

r(
  "REQ-CH13-01",
  "ch13 Performance targets",
  A,
  "Frozen PERF thresholds measured, never edited after a failure.",
  ["tests/perf", "tests/perf/reference.json"],
  ["PERF01", "PERF02", "PERF05", "PERF06", "PERF07"],
  {
    external: true,
    blocker:
      "Judged runs must be recorded by the lead on the quiet reference machine (ADR-20261111-002); informal runs are not evidence.",
  },
);
r(
  "REQ-CH13-02",
  "ch13 Backpressure and reliability",
  A,
  "Admission control, breakers and graceful degradation under overload.",
  ["apps/api/src/overload", "packages/agent-runtime/src/slo"],
  ["PERF09", "PERF11"],
);
r(
  "REQ-CH13-03",
  "ch13 Cost model and observability",
  A,
  "Cost accounting, budget-burn stop, SLO burn alerts and telemetry.",
  ["packages/agent-runtime/src/cost", "packages/kernel/src/telemetry.ts", "apps/api/src/cost-routes.ts"],
  ["PERF12", "SEC21"],
);
r(
  "REQ-CH13-04",
  "ch13 Benchmark suite",
  A,
  "1M and 10M-row benchmarks, cold versus warm.",
  ["tests/perf/PERF10.accept.test.ts", "tests/perf/_stack.ts"],
  ["PERF10", "PERF11"],
  { external: true, blocker: "Needs the quiet reference machine and the live analytics stack." },
);

r(
  "REQ-CH14-01",
  "ch14 BigQuery adapter",
  B,
  "Partitioned, bounded, dry-run-first BigQuery reads with budget enforcement.",
  ["services/ingestion/src/adapters/bigquery-guard.ts", "services/ingestion/src/backfill/budget.ts"],
  ["D10", "D16"],
);
r(
  "REQ-CH14-02",
  "ch14 Explorer adapter",
  B,
  "Env-token auth, gap-free pagination, 429 and 401/403 handling, single shared rate coordinator.",
  ["services/ingestion/src/adapters/explorer.ts", "services/ingestion/src/rate/limiter.ts"],
  ["D01", "D02", "D04", "D18", "PERF08"],
);
r(
  "REQ-CH14-03",
  "ch14 1Click dry quotes",
  B,
  "Dry-only quotes enforced at the final HTTP boundary; a quote is not an executed spread.",
  ["services/ingestion/src/adapters/oneclick.ts", "services/ingestion/src/http/quote-wire-guard.ts"],
  ["D07", "PERF08"],
  {
    partial: true,
    missing:
      "Signed-quote verification, per-route quote intelligence fields and asset-catalogue address validation (final_master_prompt s8) are not integrated.",
    blocker: "Wave 4 worker A20 (Intents intelligence) has not delivered.",
  },
);
r(
  "REQ-CH14-04",
  "ch14 Bridge taxonomy and attribution",
  B,
  "Registered bridge and ecosystem attribution with double-count policy.",
  ["services/ingestion/src/registry"],
  ["D08", "D17"],
  { partial: true, missing: "Ecosystem entity registry (A17) not delivered.", blocker: "Wave 4 worker A17." },
);
r(
  "REQ-CH14-05",
  "ch14 NEAR AI Cloud and OutLayer",
  A,
  "NEAR AI adapter kept but disabled; OutLayer WASM verification and attestation.",
  [
    "packages/inference/src/near-ai.ts",
    "services/outlayer-verifier",
    "packages/capsule/src/outlayer-prove.ts",
  ],
  ["V03", "V04", "V09", "V10", "V11"],
  {
    external: true,
    blocker: "Live OutLayer attestation needs the testnet submission path and credentials (V10 live).",
  },
);
r(
  "REQ-CH14-06",
  "ch14 NEAR chain commitment and Base adapter",
  A,
  "Testnet hash commitment with readback; Base read-only adapter on chain id 8453.",
  ["plugins/chain-commit", "scripts/release/base.ts", "scripts/release/near-live-chain.ts"],
  ["V05", "V13", "N01", "N05", "N12"],
  {
    external: true,
    blocker:
      "Live commitment readback requires the testnet target (BLK-20261111-002) and owner approval records.",
  },
);
r(
  "REQ-CH14-07",
  "ch14 Dependency documentation register",
  A,
  "Every production integration URL has a source-register entry.",
  ["docs/refs/source-register.yaml", "scripts/security/url-audit.ts"],
  ["BOOT03", "D16"],
);

for (const [n, phase] of [
  ["P00", "Documentary baseline, repo bootstrap, threat model"],
  ["P01", "Kernel, auth, ACL, command bus, plugins"],
  ["P02", "NEAR data adapters and immutable evidence"],
  ["P03", "Normalization, ClickHouse, semantic model, query guard"],
  ["P04", "Temporal, LangGraph agents, inference adapter"],
  ["P05", "Canvas compiler, panels, persistent editing"],
  ["P06", "Markers, lenses, monitors, autonomous subagents"],
  ["P07", "Research methods, preregistration, adversarial review"],
  ["P08", "Evidence graph, time machine, branches, collaboration"],
  ["P09", "Verifiable compute, testnet registration, publication"],
  ["P10", "Bounty integration and cross-plugin vertical slice"],
  ["P11", "Security, load, chaos, backup, release hardening"],
  ["P12", "Network promotion: testnet to minimal mainnet"],
] as const) {
  // Tests are filled in by the builder: every required test of the matching gate.
  r(
    `REQ-CH15-${n}`,
    `ch15 Phase ${n}`,
    A,
    `${phase}: the gate G${n.slice(1)} passes with current evidence.`,
    [],
    [],
    { deps: [] },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Chapters 17-23, 25-28 (16/16a/16b become one requirement per test id; ch24 comes from REQUIREMENTS_MAP.json)
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-CH17-01",
  "ch17 Environment matrix and deployable services",
  A,
  "Documented environments and production images for API, ingestion and web.",
  ["infrastructure/deploy", "infrastructure/compose/docker-compose.yml"],
  ["N06", "SEC11"],
);
r(
  "REQ-CH17-02",
  "ch17 Testnet discipline and release manifest",
  A,
  "Release manifest with digests, rollback manifest, idempotent release command.",
  ["scripts/release/manifest.ts", "scripts/release/rollback.ts", "scripts/release/release.ts"],
  ["N04", "N06"],
);
r(
  "REQ-CH17-03",
  "ch17 Minimal mainnet gate",
  A,
  "Mainnet write needs a single-use scoped approval, pre-write checks and post-write verification.",
  ["scripts/release/approval.ts", "scripts/release/chain.ts", "scripts/release/near-ledger.ts"],
  ["N02", "N03", "N08", "N09", "N10", "N11"],
  {
    external: true,
    blocker: "Owner must approve and perform the mainnet transaction; until then N03/N09/N11 stay BLOCKED.",
  },
);
r(
  "REQ-CH17-04",
  "ch17 Base adapter clarification",
  A,
  "Base is a read-only adapter, not a mainnet substitute.",
  ["scripts/release/base.ts"],
  ["N05", "N12"],
);
r(
  "REQ-CH17-05",
  "ch17 Incident playbook",
  A,
  "Post-deployment incident steps and uncertain-write handling.",
  ["scripts/release/chain.ts", "packages/kernel/src/release-gate-runbook.ts"],
  ["N10", "SEC22"],
);

r(
  "REQ-CH18-01",
  "ch18 Reporting layout and templates",
  A,
  "Evidence per test under reports/TESTS, phase reports, findings, blockers and decisions.",
  ["packages/acceptance/src/index.ts", "scripts/accept.ts", "scripts/coord.ts"],
  ["N07"],
);
r(
  "REQ-CH18-02",
  "ch18 Blocker and failure policy",
  A,
  "BLOCKED_DEPENDENCY is recorded, never PASS; failures keep evidence.",
  ["packages/acceptance/src/index.ts", "scripts/conformance.ts"],
  ["N07", "B10"],
);

r(
  "REQ-CH19-01",
  "ch19 Scripted reviewer demonstration",
  A,
  "Twelve-step reviewer demo works from a fresh clone.",
  ["scripts/demo", "tests/integration/B14.accept.test.ts"],
  ["B14", "B01", "B05"],
);
r(
  "REQ-CH19-02",
  "ch19 README and THESIS structure",
  B,
  "README acceptance and mandatory THESIS.md structure.",
  ["docs/user/README.md", "docs/user/GETTING_STARTED.md", "packages/capsule/src/bundle.ts"],
  ["B14", "Q22", "V16"],
);
r(
  "REQ-CH19-03",
  "ch19 Submission anti-patterns",
  B,
  "Claims stay inside data limits; known limitations are published.",
  ["docs/user/KNOWN_LIMITATIONS.md", "packages/capsule/src/claims-scan.ts"],
  ["B13", "B07"],
);

r(
  "REQ-CH20-01",
  "ch20 Plugin SDK interface",
  A,
  "Typed plugin definition and manifest.",
  ["packages/plugin-sdk/src/define.ts", "packages/plugin-sdk/src/manifest.ts"],
  ["K05", "K06", "K12"],
);
r(
  "REQ-CH20-02",
  "ch20 Strict query schema and BigQuery partition rule",
  B,
  "Strict query schema; BigQuery reads must carry a block_date predicate.",
  ["packages/contracts/src/semantic.ts", "services/ingestion/src/adapters/bigquery-guard.ts"],
  ["S14", "D10"],
);
r(
  "REQ-CH20-03",
  "ch20 Canvas panel patch",
  B,
  "Deterministic patch application with one invalid op rejecting atomically.",
  ["packages/canvas-schema/src/patch.ts"],
  ["C11", "C05", "C06"],
);
r(
  "REQ-CH20-04",
  "ch20 Monitoring rule schema",
  A,
  "Rule conditions are deterministic ASTs evaluated before any AI.",
  ["packages/contracts/src/monitor.ts", "packages/kernel/src/monitoring/condition.ts"],
  ["M15", "M13", "M14"],
);
r(
  "REQ-CH20-05",
  "ch20 Research-capsule manifest and CLI",
  A,
  "Capsule manifest, export, verify and rebuild CLI.",
  ["packages/contracts/src/capsule.ts", "packages/capsule/src/cli.ts", "packages/capsule/src/bundle.ts"],
  ["V01", "V02", "V12"],
);

r(
  "REQ-CH21-01",
  "ch21 Operational dashboard and runbooks",
  A,
  "Runbooks for Explorer limits, BigQuery cost, metric drift, agent loops, collab, TEE failure, uncertain transactions.",
  ["packages/kernel/src/release-gate-runbook.ts", "docs/operations/COST_SLO_CHAOS_RESTORE.md"],
  ["SEC22", "PERF11", "N10"],
);
r(
  "REQ-CH21-02",
  "ch21 Data recovery exercise",
  A,
  "Backup and restore drill with verification.",
  ["scripts/chaos/backup-restore.ts", "tests/ops/backup-restore.drill.test.ts"],
  ["PERF04"],
);
r(
  "REQ-CH21-03",
  "ch21 Maintenance automation",
  A,
  "Scheduled collection and forward ingestion with leases.",
  ["services/ingestion/src/scheduler/daily.ts", "services/ingestion/src/scheduler/lease.ts"],
  ["D03", "D04"],
);

r(
  "REQ-CH22-01",
  "ch22 ADR-001..009 decisions",
  A,
  "Kernel plus plugins, Temporal outside, Cube plus own MCP, declarative canvas, Postgres/ClickHouse/Parquet, privacy-aware reconciliation, evidence DAG, one objective per workspace, research first.",
  [
    "packages/kernel",
    "packages/workflow",
    "packages/semantic-gateway",
    "packages/canvas-schema",
    "services/ingestion",
  ],
  ["K12", "S13", "C02", "D09", "W07"],
);
r(
  "REQ-CH22-02",
  "ch22 Risk register and unresolved facts",
  A,
  "Risks and unresolved facts stay tracked with owners.",
  ["docs/user/KNOWN_LIMITATIONS.md", "docs/security/THREAT_MODEL.md"],
  ["B13", "SEC22"],
  {
    partial: true,
    missing:
      "The unresolved-fact register is kept in the Bible, not in the repository; no machine check ties it to code.",
    blocker: "None technical; needs the owner to confirm the register is closed.",
  },
);

r(
  "REQ-CH23-01",
  "ch23 References and documentation reading order",
  A,
  "Every integration cites an official source; source register audited.",
  ["docs/refs/source-register.yaml", "scripts/security/url-audit.ts"],
  ["BOOT03"],
);

r(
  "REQ-CH25-01",
  "ch25 Bounty plugin manifest and registration",
  A,
  "near-thesis plugin manifest, registration points and typed dependency graph.",
  ["plugins/near-thesis/src/manifest.ts", "plugins/near-thesis/src/descriptor.ts"],
  ["B04", "B11"],
);
r(
  "REQ-CH25-02",
  "ch25 Investment-question lifecycle",
  A,
  "Question to workstreams to evidence to capsule; ordering of preregistration, evaluation and publication.",
  ["plugins/near-thesis/src/lifecycle/ordering.ts", "plugins/near-thesis/src/lifecycle/trace.ts"],
  ["B05", "B08", "B12"],
);
r(
  "REQ-CH25-03",
  "ch25 Failure propagation",
  A,
  "An Explorer credential failure and mixed provider outage degrade the slice honestly.",
  ["plugins/near-thesis/src/lifecycle/degradation.ts", "packages/workflow/src/source-gate.ts"],
  ["B03", "B09", "B10"],
);
r(
  "REQ-CH25-04",
  "ch25 Coherent demo assertion",
  A,
  "One question yields identical numbers across agents, canvas and capsule.",
  ["plugins/near-thesis/src/lifecycle/consistency.ts", "plugins/near-thesis/src/lifecycle/agreement.ts"],
  ["B06", "B07", "B12", "B15"],
);

r(
  "REQ-CH26-01",
  "ch26 Three-layer representation",
  B,
  "Semantic IR, panel spec and render layer.",
  ["packages/canvas-schema/src/compiler.ts", "packages/canvas-schema/src/panel.ts"],
  ["C01", "C09", "C17"],
);
r(
  "REQ-CH26-02",
  "ch26 Panel state machine",
  B,
  "Loading, partial, empty, error and ready panel states.",
  ["packages/canvas-schema/src/runtime.ts", "packages/ui/src/canvas"],
  ["C07", "C14", "C18"],
);
r(
  "REQ-CH26-03",
  "ch26 Chart semantic validation and gestures",
  B,
  "Unit mismatch and semantic violations are rejected; selection gestures are typed.",
  ["packages/canvas-schema/src/issues.ts", "packages/canvas-schema/src/compiler.ts"],
  ["C03", "C13", "C17"],
);
r(
  "REQ-CH26-04",
  "ch26 Failure-injection exercises",
  B,
  "Hostile strings, malformed specs and SSE faults handled.",
  ["packages/canvas-schema/src/markdown.ts", "apps/web/src/components/SafeMarkdown.tsx"],
  ["C09", "C10", "C15"],
);

r(
  "REQ-CH27-01",
  "ch27 Agent quality measured",
  B,
  "Deterministic evaluation of agent runs over scenario taxonomy; LLM judge never decides numeric correctness.",
  ["packages/agent-runtime/src/review.ts", "packages/agent-runtime/src/grounding.ts"],
  ["A19", "B07", "Q10"],
  {
    partial: true,
    missing:
      "The 50-question expert analyst evaluation corpus and scorer (final_master_prompt s19) are not delivered.",
    blocker: "Engine B evaluation-suite task not delivered.",
  },
);
r(
  "REQ-CH27-02",
  "ch27 Adversarial bull/bear protocol",
  B,
  "Deterministic adjudication of competing branches.",
  ["packages/agent-runtime/src/graphs/adversarial.ts", "services/research/nearesis_research/adversarial.py"],
  ["Q19"],
);
r(
  "REQ-CH27-03",
  "ch27 Abstention and fail states",
  A,
  "Abstention, CANNOT_COMPUTE and insufficient data are valid terminal states.",
  ["packages/agent-runtime/src/errors.ts", "packages/contracts/src/research.ts"],
  ["A19", "V14", "B10"],
);
r(
  "REQ-CH27-04",
  "ch27 Evidence-grounded generation",
  B,
  "Generated text is limited to computed results; numeric claims need evidence.",
  ["packages/agent-runtime/src/grounding.ts", "packages/capsule/src/claims-scan.ts"],
  ["W08", "Q10", "V06", "B07"],
);

r(
  "REQ-CH28-01",
  "ch28 First clone and preflight",
  A,
  "Fresh clone installs with the frozen lockfile and passes typecheck and lint.",
  ["scripts/bootstrap-toolchain.sh", "scripts/toolchain-env.sh", "scripts/ci/steps.sh"],
  ["BOOT01", "B14"],
);
r(
  "REQ-CH28-02",
  "ch28 Agent governance and packages",
  A,
  "AGENTS.md governance, dependency pins and branch convention.",
  ["AGENTS.md", "pnpm-lock.yaml"],
  ["BOOT01", "SEC11"],
);
r(
  "REQ-CH28-03",
  "ch28 Daily report flow",
  A,
  "Coordination events and handoffs per agent session.",
  ["scripts/coord.ts", "scripts/coord-lib.ts"],
  ["N07"],
);

// ---------------------------------------------------------------------------------------------------------------
// Final master directive, sections 4-21 (owner's final checklist)
// ---------------------------------------------------------------------------------------------------------------
const W4 = (who: string) => `Wave 4 worker ${who} has not delivered this yet.`;
r(
  "REQ-FMP04-01",
  "final s4 Dynamic analytics: query planning pipeline",
  A,
  "Unfamiliar question to discovery, entity and grain, validated plan, cost estimate, coverage check, authorized execution, provenance, limitations, follow-ups, saved artifact.",
  [
    "packages/semantic-gateway/src/gateway.ts",
    "packages/semantic-gateway/src/coverage.ts",
    "packages/workflow/src/activities.ts",
  ],
  ["S03", "S06", "S08", "A19"],
  {
    partial: true,
    missing:
      "Follow-up proposal and saved-investigation artifact for unfamiliar questions are not integrated.",
    blocker: W4("A19 (metric authoring)"),
  },
);
r(
  "REQ-FMP04-02",
  "final s4 Governed metric authoring",
  A,
  "Typed metric proposals compile through an allowlisted compiler; no unrestricted SQL.",
  ["packages/semantic-gateway/src/authoring", "apps/api/src/metric-routes.ts"],
  [],
  {
    files: ["packages/semantic-gateway/test/authoring.test.ts"],
    missing: "Authoring compiler and APIs do not exist in the code yet.",
    blocker: W4("A19"),
  },
);
r(
  "REQ-FMP04-03",
  "final s4 Metric lifecycle and version pinning",
  A,
  "DRAFT, VALIDATED, CERTIFIED, DEPRECATED lifecycle; drafts visibly exploratory and excluded from verified artifacts; snapshots pin metric versions.",
  ["services/analytics/src/registry/promotions.ts#approveChange", "packages/kernel/src/history/pinned.ts"],
  ["S12", "W02", "W10", "V18"],
  {
    partial: true,
    missing:
      "Promotion (proposed/approved/rejected) and version pinning exist; the DRAFT/VALIDATED states, exploratory labelling and authoring APIs are not present.",
    blocker: W4("A19"),
  },
);
r(
  "REQ-FMP05-01",
  "final s5 Ecosystem entity registry",
  A,
  "Source-backed, time-versioned registry of accounts, contracts, apps, DAOs, bridges, tokens with mapping methodology and confidence.",
  ["services/ingestion/src/entities", "services/analytics/src/entities", "apps/api/src/entity-routes.ts"],
  ["D17"],
  {
    files: ["services/ingestion/test/entities.test.ts"],
    missing: "Registry, entity metrics and routes do not exist.",
    blocker: W4("A17"),
  },
);
r(
  "REQ-FMP05-02",
  "final s5 Attribution without double counting",
  A,
  "No double-counting across overlapping classifications; classified versus unclassified coverage; no LLM-guessed attribution.",
  ["services/analytics/src/entities"],
  [],
  {
    files: ["services/analytics/test/entities.test.ts"],
    missing: "Attribution rules and coverage not built.",
    blocker: W4("A17"),
  },
);
r(
  "REQ-FMP06-01",
  "final s6 Account activity and cohorts",
  A,
  "Daily active, new versus returning, first/last seen, retention cohorts, concentration, growth contributions, per-account views.",
  [
    "services/ingestion/src/backfill/account-sql.ts",
    "services/ingestion/src/backfill/account-load.ts",
    "services/ingestion/src/scheduler/account-forward.ts",
  ],
  ["D10", "Q06"],
  {
    partial: true,
    missing:
      "Per-account load and forward ingest exist; retention cohorts, concentration measures and per-account query APIs are not built.",
    blocker:
      "Full per-signer history needs a billed ~35 GiB BigQuery query: owner approval packet required (final s6, s2 spend rule).",
  },
);
r(
  "REQ-FMP07-01",
  "final s7 Gas, fees and economics",
  A,
  "Gas, receipts, burnt gas, fees, percentiles, contract intensity with exact arithmetic and explicit conversions.",
  ["services/ingestion/src/economics", "services/analytics/src/economics"],
  [],
  {
    files: ["services/ingestion/test/economics.test.ts"],
    missing: "No gas or fee metrics in the code (only chain-write gas in release scripts).",
    blocker: `${W4("A18")} Any billed BigQuery run needs owner approval.`,
  },
);
r(
  "REQ-FMP08-01",
  "final s8 Intents analytics",
  A,
  "Swap counts, flows, chains, status, settlement duration, size buckets, concentration from trusted fields.",
  ["services/analytics/src/intents", "apps/api/src/intents-routes.ts"],
  ["D01", "D09"],
  {
    files: ["services/analytics/test/intents.test.ts"],
    missing: "Intents intelligence metrics and routes do not exist.",
    blocker: W4("A20"),
  },
);
r(
  "REQ-FMP08-02",
  "final s8 Solver analysis returns CANNOT_COMPUTE",
  A,
  "Solver share, fill rate and quote-to-execution only with a defensible join, else CANNOT_COMPUTE with the missing-data reason.",
  ["services/analytics/src/intents"],
  ["V14"],
  {
    files: ["services/analytics/test/intents.test.ts"],
    missing: "No solver analysis exists.",
    blocker: W4("A20"),
  },
);
r(
  "REQ-FMP08-03",
  "final s8 1Click quote intelligence",
  A,
  "dry:true enforced at the outbound boundary; quote fields, error category, rate-limit status; signed-quote verification where supported.",
  ["services/ingestion/src/http/quote-wire-guard.ts", "services/ingestion/src/quotes"],
  ["D07", "PERF08"],
  {
    partial: true,
    missing:
      "dry:true guard and sampler exist; the quote intelligence record and signed-quote verification do not.",
    blocker: W4("A20"),
  },
);
r(
  "REQ-FMP09-01",
  "final s9 Backfill integrity and archive repair",
  A,
  "Immutable archives, checkpointed cursors, quarantines, unknown-versus-zero, archive metadata repaired from surviving payloads, no invented data.",
  [
    "services/ingestion/src/archive/archive.ts",
    "services/ingestion/src/backfill/state.ts",
    "services/ingestion/src/backfill/skip-quarantined.ts",
  ],
  ["D03", "D06", "D11", "D14", "S11"],
  {
    partial: true,
    missing: "Raw-archive metadata reconstruction from surviving payloads is not integrated.",
    blocker: W4("A15"),
  },
);
r(
  "REQ-FMP09-02",
  "final s9 Near-real-time ingestion",
  A,
  "Optional forward-only low-latency feed with finality state; no provisional events treated as final.",
  [
    "services/ingestion/src/scheduler/explorer-forward.ts",
    "services/ingestion/src/scheduler/account-forward.ts",
  ],
  ["D03", "D04"],
  {
    partial: true,
    missing:
      "Forward Explorer and account collectors exist; a NEAR RPC/indexer comparison and finality-aware feed do not.",
    blocker: W4("A15"),
  },
);
r(
  "REQ-FMP09-03",
  "final s9 Freshness and coverage exposure",
  A,
  "Last observation and ingestion time, watermark, finality, coverage, lag, reconciliation status, partial-day warnings.",
  ["packages/semantic-gateway/src/coverage.ts", "services/ingestion/src/backfill/explorer-coverage.ts"],
  ["S08", "S11"],
  {
    partial: true,
    missing:
      "Coverage and watermark exist; collector lag and reconciliation status are not exposed as one contract.",
    blocker: W4("A21"),
  },
);
r(
  "REQ-FMP10-01",
  "final s10 Research agents (Director to Publisher)",
  A,
  "Ten agent roles with specified duties, authorised delegation, observable model routing.",
  [
    "packages/agent-runtime/src/roles.ts",
    "packages/agent-runtime/src/graphs/director.ts",
    "packages/agent-runtime/src/supervisor.ts",
  ],
  ["A01", "A11", "A19", "Q19"],
  {
    partial: true,
    missing:
      "Measured per-task model routing and data-scout/semantic-analyst usefulness against unfamiliar questions are not evaluated.",
    blocker: "Engine B research-agent quality task and the 50-question suite.",
  },
);
r(
  "REQ-FMP11-01",
  "final s11 Composable autonomous investigations",
  B,
  "General investigation framework builds workstreams, reuses typed artifacts, degrades honestly, pins snapshots.",
  [
    "packages/workflow/src/workflows.ts",
    "packages/workflow/src/source-gate.ts",
    "packages/contracts/src/research-artifacts.ts",
  ],
  ["B01", "B09", "B12", "A13"],
  {
    partial: true,
    missing:
      "Artifact reuse across agents and the full workstream set for the s20 question are not verified end to end.",
    blocker: "Engine B s20 live investigation task.",
  },
);
r(
  "REQ-FMP12-01",
  "final s12 Quantitative research complete",
  B,
  "Target construction, horizons, four models, baselines, rolling origin, holdout, leakage defenses, versioning, robustness, power, independent comparison.",
  ["services/research/nearesis_research", "docs/research/RESEARCH_ENGINE.md"],
  ["Q01", "Q03", "Q11", "Q12", "Q13", "Q14", "Q17", "Q18", "Q20"],
  {
    partial: true,
    missing:
      "Statistical-power evaluation and a qualified significance procedure are unavailable; descriptive comparison only.",
    blocker: "ADR-20261111-003 and ADR-20261111-004: Q14 amendments ended without a qualifying estimator.",
  },
);
r(
  "REQ-FMP13-01",
  "final s13 Evidence graph and time machine",
  A,
  "Typed links among claims, sources, queries, metrics, results, runs, assumptions, evidence, counterevidence, snapshots, reviews, publications; no silent vintage substitution.",
  ["packages/kernel/src/graph.ts", "packages/kernel/src/history", "packages/contracts/src/graph.ts"],
  ["W03", "W05", "W07", "W09", "W10", "W11", "W18", "V18"],
  {
    partial: true,
    missing:
      "Publication invalidation exists for metric corrections (V18); source-correction tracking beyond metrics and node restriction enforcement on the graph endpoint remain open.",
    blocker: "INTEGRATION_QUEUE: graph endpoint does not apply node restrictions (Engine B request to W2).",
  },
);
r(
  "REQ-FMP14-01",
  "final s14 Live analytics regression (Cube swap rollup)",
  A,
  "Swap rollup fixed, rebuilt and verified through the public API at small, 1M and 10M rows; no stale cache, tenant leaks or restart faults.",
  ["services/analytics/cube/model", "packages/semantic-gateway/src/rollup.ts", "services/analytics/test"],
  ["S09", "S13", "PERF10"],
  {
    partial: true,
    missing:
      "Verification at 1M and 10M rows and real swap queries through the public API are the A16 task; rollup-aware serving is committed.",
    blocker: "Wave 4 worker A16 verification report pending; 10M run needs a quiet machine.",
  },
);
r(
  "REQ-FMP15-01",
  "final s15 Measured performance",
  A,
  "Separate timing for progress, first data, first panel, completion; percentiles, cache hit rate, db/model/tool/queue time; thresholds never changed.",
  ["tests/perf", "packages/workflow/src/progressive-canvas.ts", "packages/agent-runtime/src/slo"],
  ["PERF01", "PERF02", "PERF05", "PERF06", "PERF07", "PERF09", "PERF10"],
  {
    external: true,
    blocker: "Quiet reference machine required; current numbers are informal (ADR-20261111-002).",
  },
);
r(
  "REQ-FMP16-01",
  "final s16 Real-world failure handling",
  A,
  "Typed reason codes and explicit state transitions for 429, expired tokens, outages, crashes, duplicates, cancellations, reconnects, revoked permissions.",
  [
    "apps/api/src/overload",
    "packages/agent-runtime/src/errors.ts",
    "packages/workflow/src/source-gate.ts",
    "services/ingestion/src/rate/breaker.ts",
  ],
  ["D02", "D18", "A02", "A10", "A18", "PERF09", "PERF11", "B03", "B09", "SEC20"],
);
r(
  "REQ-FMP17-01",
  "final s17 Security and multi-tenant reliability",
  A,
  "Tenant-safe storage, capability auth, classification controls, idempotency, injection and SSRF defenses, secrets hygiene, supply chain, restore verification.",
  [
    "packages/kernel/src",
    "apps/api/src/request-guards.ts",
    "scripts/security",
    "scripts/release/vuln-scan.ts",
  ],
  [
    "SEC01",
    "SEC02",
    "SEC03",
    "SEC05",
    "SEC09",
    "SEC10",
    "SEC11",
    "SEC18",
    "SEC19",
    "SEC20",
    "SEC21",
    "PERF04",
  ],
  {
    partial: true,
    missing:
      "Real authentication with session persistence across restarts and a supervisor script are not integrated.",
    blocker: W4("A15"),
  },
);
r(
  "REQ-FMP18-01",
  "final s18 Cost engine",
  A,
  "Reservations, actuals and reconciliation per resource (tokens, paid HTTP, BigQuery, storage, OutLayer, workflow); per-resource limits; unknown price is not zero; forecasts; global USD 5 ceiling.",
  [
    "packages/agent-runtime/src/cost",
    "services/ingestion/src/cost",
    "packages/workflow/src/cost-ops.ts",
    "apps/api/src/cost-routes.ts",
    "packages/inference/src/spend.ts",
  ],
  ["PERF12", "A05", "SEC17"],
  {
    partial: true,
    missing:
      "Authorise-before/settle-after is wired for BigQuery, paid HTTP, plugin egress, archive, OutLayer and workflow ops; cost forecasts and threshold notifications are not complete.",
    blocker: W4("A21 (cost engine)"),
  },
);
r(
  "REQ-FMP19-01",
  "final s19 Analyst question evaluation suite",
  B,
  "At least 50 realistic analyst questions with coverage, provenance, invariants, forbidden claims, deterministic scorers and unseen questions.",
  ["services/research/eval", "docs/research/eval"],
  [],
  {
    files: ["services/research/test/eval-corpus.test.ts"],
    missing: "No corpus or scorer exists in the repository.",
    blocker: "Engine B evaluation-suite task not delivered.",
  },
);
r(
  "REQ-FMP20-01",
  "final s20 Live investigation without hardcoded answers",
  B,
  "The Intents broad-based versus concentrated question runs through all 22 expected steps and ends in a capsule, OutLayer check and testnet readback.",
  [
    "packages/workflow/src/workflows.ts",
    "tests/integration/P10.lifecycle-live.test.ts",
    "packages/capsule/src/live.ts",
  ],
  ["B01", "B05", "B12", "V10", "V13", "N01"],
  {
    external: true,
    blocker:
      "Depends on s5, s6, s8 analytics, the live OutLayer attestation and the testnet commitment target (BLK-20261111-002), plus the unbuilt account/entity analytics.",
    deps: ["REQ-FMP05-01", "REQ-FMP06-01", "REQ-FMP08-01"],
  },
);
r(
  "REQ-FMP21-01",
  "final s21 Frontend data contracts",
  A,
  "OpenAPI or equivalent, schemas, sample payloads, fixtures; states for loading, partial, stale, truncated, unavailable, denied, rate limited, insufficient, uncertified, unvalidated, budget exhausted.",
  ["packages/contracts/src", "docs/api", "apps/api/src/openapi.ts"],
  [],
  {
    files: ["apps/api/test/openapi.test.ts"],
    partial: true,
    missing:
      "Zod contracts and generated JSON schemas exist; the OpenAPI document, state taxonomy and sample payloads do not.",
    blocker: W4("A21"),
  },
);

// ---------------------------------------------------------------------------------------------------------------
// Accepted ADRs
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-ADR-20261110-001",
  "ADR-20261110-001",
  A,
  "Root layout is the Build Bible plus nearesis-app; one reports tree under the Bible; the Bible is never committed.",
  ["../.gitignore", "AGENTS.md"],
  ["BOOT01"],
);
r(
  "REQ-ADR-20261110-002",
  "ADR-20261110-002",
  A,
  "The 35 amendment tests are defined, evidence lives under reports/TESTS, and the runner reads tests/TEST_INDEX.json.",
  ["tests/TEST_INDEX.json", "scripts/accept.ts", "scripts/conformance.ts"],
  ["K11", "D13", "S10", "A11", "C09", "N07"],
);
r(
  "REQ-ADR-20261110-003",
  "ADR-20261110-003",
  A,
  "Test budget and provisional TEE measurement baseline for NEAR AI; per-call spend refusal.",
  ["packages/inference/src/spend.ts", "packages/inference/src/near-verify.ts"],
  ["A08", "A15"],
  {
    external: true,
    blocker: "NEAR AI has no credits (BLK-20261110-005); superseded for live inference by ADR-20261110-004.",
  },
);
r(
  "REQ-ADR-20261110-004",
  "ADR-20261110-004",
  A,
  "OpenRouter BYOK replaces NEAR AI as the live provider; A21 substitutes A16, which becomes historical and non-required.",
  ["packages/inference/src/openrouter.ts", "packages/inference/src/policy.ts"],
  ["A21", "A15", "A08"],
  {
    external: true,
    blocker:
      "A21 is a live test: needs the BYOK key and spend inside the USD 5 ceiling; only fixture evidence exists.",
  },
);
r(
  "REQ-ADR-20261110-005",
  "ADR-20261110-005",
  B,
  "Live 365-day NEAR backfill within a BigQuery budget.",
  ["services/ingestion/src/backfill/orchestrator.ts", "services/ingestion/src/backfill/budget.ts"],
  ["D10", "D12"],
);
r(
  "REQ-ADR-20261111-001",
  "ADR-20261111-001",
  A,
  "16b (G06-G12) accepted with five corrections; the dependency graph is acyclic.",
  ["scripts/tests/validate-deps.ts", "tests/TEST_INDEX.json"],
  ["N07"],
  { files: ["scripts/tests/validate-deps.test.ts"] },
);
r(
  "REQ-ADR-20261111-002",
  "ADR-20261111-002",
  A,
  "Reference environment for PERF tests.",
  ["tests/perf/reference.json", "tests/perf/_reference.ts"],
  ["PERF01", "PERF02", "PERF03", "PERF04"],
  { external: true, blocker: "Lead records PERF on the quiet reference machine." },
);
r(
  "REQ-ADR-20261111-003",
  "ADR-20261111-003",
  B,
  "Q14 amendment 001 ended without a qualifying estimator; original failure preserved.",
  ["docs/research/PREREGISTRATION-AMENDMENT-001.md", "services/research/nearesis_research/amendment.py"],
  ["Q14"],
);
r(
  "REQ-ADR-20261111-004",
  "ADR-20261111-004",
  B,
  "Q14 amendment 002 fixed-smoothing comparison.",
  [
    "docs/research/PREREGISTRATION-AMENDMENT-002.md",
    "services/research/nearesis_research/amendment2.py",
    "services/research/nearesis_research/dm_fixed_smoothing.py",
  ],
  ["Q14"],
);
r(
  "REQ-ADR-20261111-005",
  "ADR-20261111-005",
  A,
  "Owner approval to sign NEAR testnet transactions (testnet only).",
  ["plugins/chain-commit/src/policy.ts", "plugins/chain-commit/src/signer-host.ts"],
  ["SEC15", "N01", "V13"],
);
r(
  "REQ-ADR-20261111-006",
  "ADR-20261111-006",
  A,
  "Owner approval to create the testnet commitment target.",
  ["scripts/release/testnet-deploy-commit.ts", "scripts/release/testnet-commit-prereg.ts"],
  ["N01", "V05", "V13"],
  {
    external: true,
    blocker:
      "BLK-20261111-002: target creation was outside the first approval; confirm current state before the live half is run.",
  },
);
r(
  "REQ-ADR-20261112-001",
  "ADR-20261112-001 and final directive",
  A,
  "Full Build Bible completion: nothing silently omitted, no threshold changes, canonical gates plus approved additions.",
  ["scripts/conformance.ts", "tests/REQUIREMENTS_INVENTORY.json"],
  ["N07"],
);
r(
  "REQ-ADR-ACCEPTANCE-GAP",
  "ACCEPTANCE_TEST_GAP_RESOLUTION",
  A,
  "Chapter 16 gap closed by amendments: no UNDEFINED test; fixture and live tests distinct; SKIP is never PASS.",
  ["tests/TEST_INDEX.json", "scripts/conformance.ts"],
  ["K11", "D16", "S16", "A20", "C18"],
);

// ---------------------------------------------------------------------------------------------------------------
// Final directive sections 22-29 (process requirements that conformance itself must enforce)
// ---------------------------------------------------------------------------------------------------------------
r(
  "REQ-FMP22-01",
  "final s22 All Build Bible features in scope",
  A,
  "Every Bible requirement, including 16b, appears in a machine-readable inventory with code, tests and a blocker if open.",
  ["scripts/certify/build-inventory.ts", "tests/REQUIREMENTS_INVENTORY.json", "scripts/conformance.ts"],
  ["N07"],
  { files: ["tests/conformance/inventory.test.ts"] },
);
r(
  "REQ-FMP24-01",
  "final s24 Repository safety",
  A,
  "No Bible, directive, env, key or runtime-data path is tracked; secret scan in CI; no local hooks.",
  ["../.github/workflows/ci.yml", "scripts/certify/check-prohibited.sh", "scripts/ci/steps.sh#prohibited"],
  ["BOOT02", "SEC05"],
  { files: ["tests/conformance/prohibited.test.ts"] },
);
r(
  "REQ-FMP27-01",
  "final s27 Clean-room certification",
  A,
  "Clean checkout, frozen install, build, migrate from baseline, run the whole canonical suite serially, PASS/FAIL/BLOCKED manifest.",
  ["scripts/certify/clean-room.sh"],
  ["BOOT01", "N07"],
  {
    files: ["tests/conformance/clean-room.test.ts"],
    external: true,
    blocker:
      "The full run belongs to the lead on a quiet machine; steps 9-19 also need live approvals and the frontend developer.",
  },
);
