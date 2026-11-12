import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, zodDetails } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import {
  ACCOUNT_META,
  ClickHouseAccountSource,
  accountConcentration,
  addDaysIso,
  cohortRetention,
  coverageOf,
  dailyActivity,
  growthContribution,
  highFrequency,
} from "@nearesis/analytics";
import type { AccountDataSource } from "@nearesis/analytics";
import { createClient } from "@clickhouse/client";

export interface AccountRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Defaults to the live ClickHouse database (nearesis_live), created lazily on first request. */
  source?: AccountDataSource | undefined;
}

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a calendar date");
const Account = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const MAX_RANGE_DAYS = 400;
const RangeQ = z.strictObject({
  from: Day.optional(),
  to: Day.optional(),
  days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(30),
});
const HfQ = z.strictObject({
  from: Day.optional(),
  to: Day.optional(),
  days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
const GrowthQ = z.strictObject({
  days: z.coerce.number().int().min(1).max(180).default(30),
  to: Day.optional(),
});

function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query parameters.", {
      details: zodDetails(r.error),
    });
  return r.data;
}

/**
 * Account and cohort API (final_master_prompt s6). Accounts are not people: every response carries `meta.caveats`.
 *   GET /v1/accounts/coverage                     -> loaded scan window, window start, head threshold, covered days
 *   GET /v1/accounts/daily?days|from&to           -> daily active accounts, new vs returning (since window start), coverage
 *   GET /v1/accounts/growth?days=30&to            -> average-DAU change split into new and returning contribution
 *   GET /v1/accounts/retention                    -> weekly retention by first-seen cohort week (within the window)
 *   GET /v1/accounts/concentration?days|from&to   -> top-1%, top-5%, top-10 and head/tail shares per day and over the range
 *   GET /v1/accounts/high-frequency?days&limit    -> head accounts ranked by organic transactions, frequency labels (heuristic)
 *   GET /v1/accounts/:account/profile             -> first/last seen in window, active days, daily series (head accounts only)
 * Errors: VALIDATION_FAILED (INVALID_QUERY, INVALID_RANGE), UPSTREAM_DEGRADED (ACCOUNT_SOURCE_UNAVAILABLE, ACCOUNT_DATA_NOT_LOADED),
 * NOT_FOUND (ACCOUNT_NOT_IN_HEAD_SET: below the head threshold on every day, so no per-account row exists; never a zero).
 */
export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (app, opts) => {
  let source = opts.source;
  let client: ReturnType<typeof createClient> | undefined;
  const src = (): AccountDataSource => {
    if (!source) {
      client = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: process.env.NEARESIS_CH_USER ?? "nearesis",
        password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
        database: "nearesis_live",
      });
      source = new ClickHouseAccountSource(client);
    }
    return source;
  };
  app.addHook("onClose", async () => {
    await client?.close();
  });
  async function guarded<T>(req: FastifyRequest, fn: (s: AccountDataSource) => Promise<T>): Promise<T> {
    await opts.authenticate(req);
    try {
      return await fn(src());
    } catch (e) {
      if (e instanceof KernelError) throw e;
      req.log.error({ err: e }, "account source failed");
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "ACCOUNT_SOURCE_UNAVAILABLE",
        "The account data source is unavailable.",
        { retryable: true },
      );
    }
  }
  const loaded = async (s: AccountDataSource) => {
    const w = await s.window();
    if (!w)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "ACCOUNT_DATA_NOT_LOADED",
        "The per-signer scan is not loaded.",
        { retryable: false },
      );
    return w;
  };
  const range = (
    q: { from?: string | undefined; to?: string | undefined; days: number },
    w: { to: string },
  ) => {
    const to = q.to ?? w.to;
    const from = q.from ?? addDaysIso(to, -(q.days - 1));
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS)
      throw new KernelError("VALIDATION_FAILED", "INVALID_RANGE", "Invalid date range.");
    return { from, to };
  };
  const meta = (w: { windowStart: string; headThreshold: number }) => ({
    ...ACCOUNT_META,
    windowStart: w.windowStart,
    headThreshold: w.headThreshold,
    newMeans: "first organic transaction seen since windowStart (not lifetime)",
  });

  app.get("/v1/accounts/coverage", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      return {
        windowStart: w.windowStart,
        from: w.from,
        to: w.to,
        days: w.days.length,
        headThreshold: w.headThreshold,
        meta: meta(w),
      };
    }),
  );
  app.get("/v1/accounts/daily", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      const { from, to } = range(parse(RangeQ, req.query), w);
      const rows = await s.days(from, to);
      return {
        from,
        to,
        coverage: coverageOf(
          rows.map((r) => r.date),
          from,
          to,
        ),
        daily: dailyActivity(rows, w.windowStart),
        meta: meta(w),
      };
    }),
  );
  app.get("/v1/accounts/growth", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      const q = parse(GrowthQ, req.query);
      const to = q.to ?? w.to;
      const rows = await s.days(addDaysIso(to, -(2 * q.days - 1)), to);
      return { ...growthContribution(rows, w.windowStart, to, q.days), meta: meta(w) };
    }),
  );
  app.get("/v1/accounts/retention", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      parse(z.strictObject({}), req.query);
      return { ...cohortRetention(await s.retention(), w.windowStart, w.to), meta: meta(w) };
    }),
  );
  app.get("/v1/accounts/concentration", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      const { from, to } = range(parse(RangeQ, req.query), w);
      const rows = await s.days(from, to);
      return {
        from,
        to,
        coverage: coverageOf(
          rows.map((r) => r.date),
          from,
          to,
        ),
        ...accountConcentration(rows),
        meta: meta(w),
      };
    }),
  );
  app.get("/v1/accounts/high-frequency", (req) =>
    guarded(req, async (s) => {
      const w = await loaded(s);
      const q = parse(HfQ, req.query);
      const { from, to } = range(q, w);
      const [rows, days] = await Promise.all([s.headAccounts(from, to, q.limit), s.days(from, to)]);
      return { from, to, ...highFrequency(rows, days, w.headThreshold), meta: meta(w) };
    }),
  );
  app.get<{ Params: { account: string } }>("/v1/accounts/:account/profile", (req) =>
    guarded(req, async (s) => {
      const account = parse(Account, req.params.account);
      const q = parse(RangeQ, req.query);
      const w = await loaded(s);
      const { from, to } = range(q, w);
      const profile = await s.profile(account);
      if (!profile)
        throw new KernelError(
          "NOT_FOUND",
          "ACCOUNT_NOT_IN_HEAD_SET",
          `No per-account row for ${account}: it never reached ${w.headThreshold} organic transactions in a day inside the window, so the scan stores it only in the exact tail remainder.`,
        );
      const days = await s.headDays(account, from, to);
      return { account, profile, from, to, headDays: days, kind: "account (not a person)", meta: meta(w) };
    }),
  );
};
