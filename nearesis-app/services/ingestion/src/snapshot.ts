import { z } from "zod";

const PageRef = z.strictObject({
  file: z.string().nullable(),
  fetchedAtUTC: z.iso.datetime(),
  /** HTTP status the provider returned when this page was recorded (non-200 = failed page, file may be null). */
  status: z.number().int().default(200),
  /** Optional per-page response headers recorded with the fixture (e.g. x-body-sha256). */
  headersFile: z.string().optional(),
});
export type PageRef = z.infer<typeof PageRef>;

const Env = z.enum(["fixture_synthetic", "fixture_recorded"]);

const AttemptSpec = z.strictObject({
  routeId: z.string(),
  originAsset: z.string(),
  destinationAsset: z.string(),
  amountBaseUnits: z.string().regex(/^\d+$/),
  privacyMode: z.enum(["public", "basic", "advanced"]),
  scheduledBucketUTC: z.iso.datetime(),
  attemptNo: z.number().int().positive(),
  fetchedAtUTC: z.iso.datetime(),
  outcome: z.enum(["response", "timeout", "network_error", "not_attempted"]),
  status: z.number().int().optional(),
  file: z.string().optional(),
  destDecimals: z.number().int().optional(),
  benchmarkOutFormatted: z.string().optional(),
});
export type AttemptSpec = z.infer<typeof AttemptSpec>;

export const Snapshot = z.strictObject({
  snapshotId: z.string(),
  replayNowUTC: z.iso.datetime(),
  explorer: z
    .strictObject({
      environment: Env,
      pageSize: z.number().int().positive(),
      streams: z.array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("pages"), name: z.string(), pages: z.array(PageRef) }),
          z.strictObject({
            kind: z.literal("days"),
            name: z.string(),
            days: z.array(z.strictObject({ day: z.string(), pages: z.array(PageRef) })),
          }),
        ]),
      ),
    })
    .optional(),
  oneclick: z
    .strictObject({
      environment: Env,
      tokens: z.strictObject({ file: z.string(), fetchedAtUTC: z.iso.datetime() }),
      attempts: z.array(AttemptSpec),
    })
    .optional(),
  price: z
    .strictObject({
      environment: Env,
      coinId: z.string(),
      symbol: z.string(),
      quoteCurrency: z.string(),
      window: z.strictObject({ from: z.string(), to: z.string() }),
      fetches: z.array(
        z.strictObject({
          file: z.string(),
          volumeFile: z.string().optional(),
          fetchedAtUTC: z.iso.datetime(),
        }),
      ),
    })
    .optional(),
  bigquery: z
    .strictObject({
      environment: Env,
      jobs: z.array(
        z.strictObject({
          kind: z.enum(["daily_usage", "signer_days", "contract_interactions"]),
          file: z.string(),
          fetchedAtUTC: z.iso.datetime(),
        }),
      ),
    })
    .optional(),
  registry: z
    .strictObject({
      environment: Env,
      contracts: z.string().optional(),
      aliases: z.string().optional(),
    })
    .optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;
