import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { expect, it } from "vitest";
import { BigQueryAdapter, BigQueryGuard } from "../../src/adapters/bigquery.ts";
import { adcCredentialKind, createBigQueryClient } from "../../src/adapters/bigquery-client.ts";
import { ONE_GIB } from "../../src/adapters/bigquery-guard.ts";
import { explorerSchemaFingerprint, ExplorerTx } from "../../src/adapters/explorer-parse.ts";
import { OneClickQuoteSampler } from "../../src/adapters/oneclick.ts";
import { aggregateToDaily, parseOhlc } from "../../src/adapters/price.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { systemClock } from "../../src/clock.ts";
import {
  ALLOW_COINGECKO_PRO,
  ALLOW_COINGECKO_PUBLIC,
  ALLOW_EXPLORER,
  ALLOW_ONECLICK,
  HttpClient,
} from "../../src/http/client.ts";
import { CredentialSource } from "../../src/http/credentials.ts";
import { setupEnv } from "../helpers/env.ts";

const APP = join(import.meta.dirname, "..", "..", "..", "..");
const BUDGET = join(import.meta.dirname, "..", "live", "D16.budget.json");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const mask = (e: string | null) => (e ? `${e[0]}***@${e.split("@")[1] ?? "?"}#${sha(e).slice(0, 8)}` : null);

type Verdict = { status: "PASS" | "FAIL" | "BLOCKED_DEPENDENCY"; detail: Record<string, unknown> };
// required (documented) field names only, so optional-field presence is not "drift"
const requiredKeys = Object.keys(ExplorerTx.shape).filter(
  (k) => !ExplorerTx.shape[k as keyof typeof ExplorerTx.shape].isOptional(),
);
const keyFp = (items: Array<Record<string, unknown>>) =>
  sha(
    requiredKeys
      .filter((k) => items.every((i) => k in i))
      .sort()
      .join("|"),
  );

// D16: Controlled read-only live probes (runs only with NEARESIS_ACCEPT_LIVE=1)
it("probes BigQuery, Explorer, 1Click and CoinGecko within the frozen budget", async () => {
  if (process.env.NEARESIS_ACCEPT_LIVE !== "1") {
    observe({ testId: "D16", observed: "live probe not executed", blocked: "live flag not set" });
    return;
  }
  const budgetBytes = readFileSync(BUDGET);
  const budget = JSON.parse(budgetBytes.toString()) as {
    bigquery: { maximumBytesBilledPerQuery: number; totalBytesBilledPerRun: number; maxBilledJobs: number };
    http: { maxRequestsPerProvider: number };
  };
  expect(budget.bigquery.maximumBytesBilledPerQuery).toBeLessThanOrEqual(ONE_GIB);
  const creds = CredentialSource.fromDotenv(join(APP, "..", ".env"));
  const env = await setupEnv();
  const store = new FsObjectStore(join(APP, ".data", "raw"));
  mkdirSync(join(APP, ".data", "raw"), { recursive: true });
  const archive = new RawArchive(store, env.tdb.db);
  const verdicts: Record<string, Verdict> = {};
  const register = readFileSync(join(APP, "docs", "refs", "source-register.yaml"), "utf8");

  // ---------------- BigQuery
  try {
    const bq = createBigQueryClient();
    const guard = new BigQueryGuard(bq, {
      perQueryBytes: budget.bigquery.maximumBytesBilledPerQuery,
      totalBytes: budget.bigquery.totalBytesBilledPerRun,
      maxBilledJobs: budget.bigquery.maxBilledJobs,
    });
    const adapter = new BigQueryAdapter(guard, archive, async () => adcCredentialKind());
    const auth = await adapter.checkAuth();
    if (!auth.ok || !auth.discovery) throw new Error("BigQuery discovery failed");
    const cols = await bq.tableColumns("bigquery-public-data", "crypto_near_mainnet_us", "transactions");
    const need = ["block_date", "signer_account_id"];
    const present = need.filter((n) => cols.some((c) => c.name === n));
    const fp = adapter.getSchemaFingerprint(
      cols.filter((c) => need.includes(c.name)).map((c) => ({ column_name: c.name, data_type: c.type })),
    );
    if (present.length !== need.length) throw new Error("schema drift: required BigQuery columns missing");
    const sql = adapter.dailyUsageSql("2026-11-01");
    const run = await adapter.fetchBatch(sql);
    expect(run.billedBytes).toBeLessThanOrEqual(budget.bigquery.maximumBytesBilledPerQuery);
    expect(guard.billedBytesTotal).toBeLessThanOrEqual(budget.bigquery.totalBytesBilledPerRun);
    expect(guard.jobsExecuted).toBeLessThanOrEqual(budget.bigquery.maxBilledJobs);
    const row = run.rows[0] as Record<string, unknown> | undefined;
    if (!row || !("tx_count" in row) || !("distinct_signers" in row))
      throw new Error("BigQuery output schema invalid");
    verdicts.bigquery = {
      status: "PASS",
      detail: {
        credentialKind: auth.discovery.credentialPrincipal,
        billingProject: auth.discovery.billingProject,
        datasetLocation: auth.discovery.datasetLocation,
        jobUserEmailMasked: mask(run.userEmail),
        jobLocation: run.location,
        dryRunEstimateBytes: run.estimateBytes,
        jobId: run.jobId,
        billedBytes: run.billedBytes,
        dryRunsExecuted: guard.dryRunsExecuted,
        billedJobs: guard.jobsExecuted,
        schemaFingerprint: fp,
        requiredColumns: need,
        sourceRegisterAssertsIdentity: /identity.*asserted|NOT asserted/i.test(register),
        objectHash: run.objectHash,
        rows: run.rows.length,
      },
    };
  } catch (e) {
    verdicts.bigquery = { status: "FAIL", detail: { error: (e as Error).message.slice(0, 300) } };
  }

  // ---------------- Explorer (1 request)
  try {
    if (!creds.has("INTENTS_EXPLORER_JWT")) {
      verdicts.explorer = {
        status: "BLOCKED_DEPENDENCY",
        detail: { reason: "INTENTS_EXPLORER_JWT not set" },
      };
    } else {
      const http = new HttpClient({ allow: [ALLOW_EXPLORER], credentials: creds, clock: systemClock });
      const c = env.collector(
        undefined as never,
        {
          http,
          clock: systemClock,
          credentials: creds,
          pageSize: 5,
          sourceEnvironment: "live",
          streamKey: "probe",
        } as never,
      );
      const r = await c.run({ maxPages: 1 });
      if (r.status === "auth_blocked") {
        verdicts.explorer = {
          status: "BLOCKED_DEPENDENCY",
          detail: { reason: "Explorer rejected the JWT (401/403)", statuses: r.blocker?.http_statuses },
        };
      } else {
        expect(r.status === "max_pages" || r.status === "complete").toBe(true);
        const reqs = http.requestLog.filter((x) => x.outcome !== "denied");
        expect(reqs.length).toBeLessThanOrEqual(1);
        const row = await env.tdb.db.query<{ record: Record<string, unknown> }>(
          "SELECT record FROM ingestion.explorer_swaps LIMIT 5",
        );
        const live = row.rows.map((x) => x.record);
        const fixture = readFixtureJson<Record<string, unknown>[]>("fx.explorer.pages-3", "page-1.json");
        const liveFp = keyFp(live);
        const fixFp = keyFp(fixture);
        verdicts.explorer = {
          status: liveFp === fixFp ? "PASS" : "FAIL",
          detail: {
            authMode: "bearer JWT (docs: all /api/v0 endpoints)",
            requests: reqs.length,
            itemsParsed: live.length,
            requiredKeyFingerprint: liveFp,
            fixtureFingerprint: fixFp,
            fullShapeFingerprint: explorerSchemaFingerprint(live),
            status: r.status,
          },
        };
      }
    }
  } catch (e) {
    verdicts.explorer = { status: "FAIL", detail: { error: (e as Error).message.slice(0, 300) } };
  }

  // ---------------- 1Click: tokens + 1 dry quote
  try {
    const http = new HttpClient({ allow: [ALLOW_ONECLICK], credentials: creds, clock: systemClock });
    const withJwt = creds.has("INTENTS_1CLICK_JWT");
    const sampler = new OneClickQuoteSampler({
      http,
      archive,
      clock: systemClock,
      sourceEnvironment: "live",
      ...(withJwt ? { credentialName: "INTENTS_1CLICK_JWT" } : {}),
    });
    const { tokens, objectHash } = await sampler.fetchTokens();
    const near = tokens.filter((t) => t.blockchain === "near");
    const origin = near.find((t) => t.symbol.toLowerCase() === "wnear") ?? near[0];
    const dest =
      near.find((t) => t.symbol.toUpperCase() === "USDC") ?? near.find((t) => t.assetId !== origin?.assetId);
    if (!origin || !dest) throw new Error("no supported near route found in live tokens");
    const attempt = await sampler.attempt({
      routeId: "probe-near",
      originAsset: origin.assetId,
      destinationAsset: dest.assetId,
      amountBaseUnits: `1${"0".repeat(origin.decimals)}`,
      privacyMode: "public",
      scheduledBucketUTC: new Date().toISOString(),
      attemptNo: 1,
      recipient: "nearesis-probe.near",
      refundTo: "nearesis-probe.near",
      destDecimals: dest.decimals,
    });
    const endpoints = [...new Set(sampler.callLog.map((c) => `${c.method} ${c.path}`))].sort();
    expect(endpoints.every((e) => e === "GET /v0/tokens" || e === "POST /v0/quote")).toBe(true);
    expect(attempt.requestBody.dry).toBe(true);
    expect(http.requestLog.length).toBeLessThanOrEqual(budget.http.maxRequestsPerProvider);
    const fixTokens = readFixtureJson<Array<Record<string, unknown>>>("fx.oneclick.tokens", "tokens.json");
    const req = ["assetId", "priceUpdatedAt"];
    const fp = (arr: Array<Record<string, unknown>>) =>
      sha(req.filter((k) => arr.every((a) => k in a)).join("|"));
    const liveRaw = tokens as unknown as Array<Record<string, unknown>>;
    const fpOk = fp(liveRaw) === fp(fixTokens);
    const unauthorised = attempt.status === 401 || attempt.status === 403;
    verdicts.oneclick = unauthorised
      ? {
          status: "BLOCKED_DEPENDENCY",
          detail: { reason: `quote HTTP ${attempt.status}`, authMode: withJwt ? "JWT" : "none" },
        }
      : {
          status: attempt.attempt.class === "OK" && fpOk ? "PASS" : "FAIL",
          detail: {
            authMode: withJwt ? "JWT (docs: X-API-Key or JWT-auth)" : "none (docs: public token list)",
            endpoints,
            requests: http.requestLog.length,
            quoteDry: true,
            quoteClass: attempt.attempt.class,
            quoteReason: attempt.reason,
            tokenCount: tokens.length,
            tokensObjectHash: objectHash,
            schemaFingerprintMatches: fpOk,
          },
        };
  } catch (e) {
    verdicts.oneclick = { status: "FAIL", detail: { error: (e as Error).message.slice(0, 300) } };
  }

  // ---------------- CoinGecko: 1 candle request
  try {
    const key = creds.has("COINGECKO_API_KEY") ? creds.get("COINGECKO_API_KEY") : undefined;
    const tries: Array<{ host: string; header?: string }> = [
      { host: "https://api.coingecko.com", ...(key ? { header: "x-cg-demo-api-key" } : {}) },
    ];
    if (key) tries.push({ host: "https://pro-api.coingecko.com", header: "x-cg-pro-api-key" });
    const http = new HttpClient({ allow: [ALLOW_COINGECKO_PUBLIC, ALLOW_COINGECKO_PRO], clock: systemClock });
    let result: Verdict | null = null;
    let lastStatus = 0;
    for (const t of tries) {
      const res = await http.request({
        method: "GET",
        url: `${t.host}/api/v3/coins/near/ohlc?vs_currency=usd&days=7`,
        ...(t.header && key ? { headers: { [t.header]: key } } : {}),
      });
      lastStatus = res.status;
      if (res.status !== 200) continue;
      const candles = parseOhlc(res.body);
      const step = candles.length > 1 ? candles[1]!.tsMs - candles[0]!.tsMs : 0;
      const daily = step > 0 && step < 86_400_000 ? aggregateToDaily(candles, step) : candles;
      const a = await archive.archive({
        providerId: "coingecko",
        adapterVersion: "coingecko-price-1.0.0",
        method: "GET",
        url: `${t.host}/api/v3/coins/near/ohlc?vs_currency=usd&days=7`,
        sourceEnvironment: "live",
        fetchedAtUTC: new Date().toISOString(),
        receivedAtUTC: new Date().toISOString(),
        providerEventAtUTC: new Date(candles.at(-1)!.tsMs).toISOString(),
        responseStatus: 200,
        contentType: "application/json",
        payload: res.body,
        privacyVisibility: "public",
        completeness: "complete",
      });
      result = {
        status: daily.length >= 1 && candles.every((c) => c.open && c.close) ? "PASS" : "FAIL",
        detail: {
          authMode: t.header ? `${t.header} on ${new URL(t.host).hostname}` : "none (docs: public API)",
          requests: http.requestLog.length,
          subDailyCandles: candles.length,
          candleStepMs: step,
          dailyCandlesDerived: daily.length,
          rowShape: "[ts,o,h,l,c]",
          objectHash: a.observation.payloadObjectHash,
        },
      };
      break;
    }
    verdicts.coingecko = result ?? {
      status: lastStatus === 401 || lastStatus === 403 || lastStatus === 429 ? "BLOCKED_DEPENDENCY" : "FAIL",
      detail: { lastHttpStatus: lastStatus, requests: http.requestLog.length },
    };
    expect(http.requestLog.length).toBeLessThanOrEqual(budget.http.maxRequestsPerProvider);
  } catch (e) {
    verdicts.coingecko = { status: "FAIL", detail: { error: (e as Error).message.slice(0, 300) } };
  }

  await env.close();
  const text = JSON.stringify(verdicts);
  for (const name of ["INTENTS_EXPLORER_JWT", "INTENTS_1CLICK_JWT", "COINGECKO_API_KEY"]) {
    const v = creds.has(name) ? creds.get(name) : undefined;
    if (v) expect(text.includes(v)).toBe(false); // (g) no secret in output
  }
  const summary = Object.entries(verdicts)
    .map(([k, v]) => `${k}=${v.status}`)
    .join(", ");
  const evidence = {
    providers: verdicts,
    budgetFileSha256: sha(budgetBytes),
    budget,
    fixtureHash: fixtureHash("fx.probe.p02-live"),
  };
  const blocked = Object.values(verdicts).some((v) => v.status === "BLOCKED_DEPENDENCY");
  const failed = Object.values(verdicts).some((v) => v.status === "FAIL");
  if (failed) {
    observe({
      testId: "D16",
      observed: `FAIL: ${summary}`,
      fixtureHash: fixtureHash("fx.probe.p02-live"),
      evidence,
    });
    throw new Error(`D16 provider failure: ${summary}`);
  }
  if (blocked) {
    observe({
      testId: "D16",
      observed: `not all providers reached: ${summary}`,
      blocked: `provider credential missing or rejected: ${summary}`,
      fixtureHash: fixtureHash("fx.probe.p02-live"),
      evidence,
    });
    return;
  }
  observe({
    testId: "D16",
    observed: `all 4 providers reached within frozen budget: ${summary}`,
    fixtureHash: fixtureHash("fx.probe.p02-live"),
    evidence,
  });
}, 300_000);
