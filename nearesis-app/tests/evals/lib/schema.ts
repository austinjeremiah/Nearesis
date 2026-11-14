import { z } from "zod";

/**
 * Evaluation question (final_master_prompt s19). Every field below the prompt is machine-checkable: nothing in a question is
 * judged by a language model.
 */
export const CATEGORIES = [
  "ecosystem",
  "intents",
  "economics",
  "research_reliability",
  "dynamic_analytics",
  "permission_failure",
  "source_failure",
  "performance",
  "cost_exhaustion",
  "historical_validity",
  "tenant_safety",
] as const;
export const Category = z.enum(CATEGORIES);
export type Category = (typeof CATEGORIES)[number];

const Pattern = z.strictObject({
  id: z.string(),
  pattern: z.string(),
  flags: z.string().default("i"),
  why: z.string(),
});

/** A deterministic numeric or structural check against the API and an independent ClickHouse query. */
export const Probe = z.discriminatedUnion("kind", [
  /** API number equals an independent ClickHouse scalar (read-only SELECT). `rel` is a relative tolerance, default 0 (exact). */
  z.strictObject({
    kind: z.literal("ch_equals"),
    label: z.string(),
    api: z.string(),
    json: z.string(),
    ch: z.string(),
    rel: z.number().nonnegative().default(0),
  }),
  /** The parts add up to the total (partition invariants: statuses sum to swaps, shares sum to 1, ...). */
  z.strictObject({
    kind: z.literal("sum_equals"),
    label: z.string(),
    api: z.string(),
    parts: z.array(z.string()).min(1),
    total: z.string().optional(),
    totalValue: z.number().optional(),
    abs: z.number().nonnegative().default(0),
  }),
  /** The API answers with a value (typically `status: CANNOT_COMPUTE`) that is the honest outcome for this question. */
  z.strictObject({
    kind: z.literal("api_field"),
    label: z.string(),
    api: z.string(),
    json: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    matches: z.string().optional(),
    httpStatus: z.number().int().default(200),
  }),
  /** A ClickHouse-only fact about the source data (e.g. a table is empty). `precondition` true: if it fails the question no longer applies and is SKIPPED, not failed. */
  z.strictObject({
    kind: z.literal("ch_check"),
    label: z.string(),
    ch: z.string(),
    expect: z.number(),
    precondition: z.boolean().default(false),
  }),
  /** A value ordering invariant, e.g. a share lies in [0,1]. */
  z.strictObject({
    kind: z.literal("range"),
    label: z.string(),
    api: z.string(),
    json: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);
export type Probe = z.infer<typeof Probe>;

const Step = z.strictObject({
  as: z.enum(["owner", "viewer", "other", "anonymous"]),
  method: z.enum(["GET", "POST", "PUT"]),
  /** `{WS}` is the owner's workspace, `{WS_OTHER}` the other tenant's. */
  path: z.string(),
  body: z.unknown().optional(),
  expectStatus: z.number().int(),
  expectReason: z.string().optional(),
  /** Body paths whose value must equal (or match) the expectation. */
  expectBody: z
    .array(
      z.strictObject({ json: z.string(), equals: z.unknown().optional(), matches: z.string().optional() }),
    )
    .default([]),
});

export const Question = z.strictObject({
  id: z.string().regex(/^(Q|H)\d{3}$/),
  split: z.enum(["dev", "heldout"]),
  category: Category,
  difficulty: z.enum(["easy", "medium", "hard", "adversarial"]),
  prompt: z.string().min(10).max(4000),
  kind: z.enum(["run", "http"]),
  requiredSources: z.array(z.string()),
  minAnswerProperties: z.array(z.string()).min(1),
  acceptableRefusals: z.array(
    z.strictObject({ state: z.string(), reasonCodes: z.array(z.string()), condition: z.string() }),
  ),
  requiredProvenance: z.array(z.string()).min(1),
  invariants: z.array(z.string()),
  forbiddenClaims: z.array(Pattern),
  acceptanceTests: z.array(z.string()),
  expect: z.strictObject({
    /** answer: must produce evidence. refusal: must be refused or blocked honestly. either: both are acceptable, each judged on its branch. */
    outcome: z.enum(["answer", "refusal", "either"]),
    /** Run states that count as an answer. */
    answerStates: z.array(z.string()).default(["COMPLETE", "PARTIAL"]),
    /** Regex that panels of an answer must satisfy (matched against panel titles and encoded fields). */
    panelPattern: z.string().optional(),
    minPanels: z.number().int().nonnegative().default(1),
    maxLatencyMs: z.number().int().positive().default(120_000),
    maxUsd: z.number().nonnegative().default(0.05),
    /** Panel hashes of a rerun with the same inputs must be identical (reproducibility). */
    reproducible: z.boolean().default(false),
  }),
  run: z
    .strictObject({
      as: z.enum(["owner", "viewer", "other"]).default("owner"),
      source: z.enum(["fixture", "live"]).default("live"),
      snapshotPolicy: z.enum(["live", "pinned"]).default("live"),
      budget: z
        .strictObject({ tokens: z.number().int(), toolCalls: z.number().int(), usd: z.number() })
        .optional(),
    })
    .optional(),
  http: z.array(Step).optional(),
  probes: z.array(Probe).default([]),
});
export type Question = z.infer<typeof Question>;
export const QuestionFile = z.array(Question);
