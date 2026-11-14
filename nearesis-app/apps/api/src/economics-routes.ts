import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, zodDetails } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import { EconomicsReader, createCh } from "@nearesis/analytics";

export interface EconomicsRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam. Default: a lazily created reader over the live ClickHouse database. */
  reader?: EconomicsReader;
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Win = z.object({
  from: Day.optional(),
  to: Day.optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
  top: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * NEAR network economics (execution fees) over the loaded near_economics_* tables, 90 days by default. Read-only,
 * authenticated, platform-wide public-chain data (no tenant rows). Money is exact decimal strings (yoctoNEAR integers);
 * USD only from timestamped CoinGecko NEAR candles (conversion method and source in the row), else null with
 * NO_TIMESTAMPED_PRICE. Nothing is labelled protocol revenue.
 *
 *   GET /v1/economics/daily        gas burnt, tokens burnt, gas price, conversion vs receipt-only burn, intensity, USD
 *   GET /v1/economics/totals       window sums
 *   GET /v1/economics/receivers    ?top  gas and fee by executing account
 *   GET /v1/economics/percentiles  per-transaction percentiles where loaded (else loaded:false)
 *   GET /v1/economics/coverage     source_coverage, quality gaps, loaded row counts
 */
export const economicsRoutes: FastifyPluginAsync<EconomicsRoutesOptions> = async (app, opts) => {
  const { authenticate } = opts;
  let owned: ReturnType<typeof createCh> | null = null;
  let made: EconomicsReader | null = opts.reader ?? null;
  const live = (): EconomicsReader => {
    if (!made) {
      const database = process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live";
      owned = createCh({ database });
      made = new EconomicsReader(owned, database);
    }
    return made;
  };
  app.addHook("onClose", async () => {
    await owned?.close();
  });
  const route = (
    path: string,
    run: (r: EconomicsReader, w: { from: string; to: string }, top: number) => Promise<unknown>,
  ): void => {
    app.get(`/v1/economics/${path}`, async (req) => {
      await authenticate(req);
      const p = Win.safeParse(req.query);
      if (!p.success)
        throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query parameters.", {
          details: zodDetails(p.error),
        });
      const r = live();
      let w: { from: string; to: string };
      if (p.data.from && p.data.to) w = { from: p.data.from, to: p.data.to };
      else {
        const d = await r.defaultWindow(p.data.days ?? 90);
        if (!d)
          throw new KernelError(
            "NOT_FOUND",
            "NO_ECONOMICS_DATA",
            "No economics day is loaded yet; pass an explicit from and to.",
          );
        w = { from: p.data.from ?? d.from, to: p.data.to ?? d.to };
      }
      if (w.from > w.to)
        throw new KernelError("VALIDATION_FAILED", "INVALID_WINDOW", "from must not be after to.");
      return run(r, w, p.data.top ?? 25);
    });
  };
  route("daily", (r, w) => r.daily(w));
  route("totals", (r, w) => r.totals(w));
  route("receivers", (r, w, top) => r.receivers(w, top));
  route("percentiles", (r, w) => r.percentiles(w));
  route("coverage", async (r, w) => ({ window: w, ...(await r.coverage(w)) }));
};

(economicsRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
