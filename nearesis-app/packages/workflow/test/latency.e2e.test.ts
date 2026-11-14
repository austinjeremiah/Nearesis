/**
 * Time breakdown of real questions end to end (final_master_prompt s15) on an isolated API + worker + database, with the live
 * warehouse and the real model (NEARESIS_ACCEPT_LIVE=1; shared USD 5 ledger, about USD 0.01 per question). Prints the table of
 * perf/breakdown.ts and writes it to $A37_REPORT. It asserts only that each question completes: the numbers are the product.
 * Needs Postgres, Temporal, cube-live (:4001) and ClickHouse.
 */
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cubeReady, LIVE_CUBE_URL_DEFAULT } from "@nearesis/analytics";
import { makeEnv, startApi, startWorker, type Api, type Env } from "./helpers/harness.ts";
import { measureQuestion, printRun } from "../perf/breakdown.ts";

const cube = await cubeReady(LIVE_CUBE_URL_DEFAULT).catch(() => false);
const real = process.env.NEARESIS_ACCEPT_LIVE === "1";
const QUESTIONS = process.env.A37_QUESTIONS
  ? (JSON.parse(process.env.A37_QUESTIONS) as string[])
  : [
      "Intents swaps by status per week since August - how have refunds changed?",
      "Daily NEAR transactions vs Intents swap volume since May, with NEAR price",
      "Which origin and destination chains carry the most Intents volume and how concentrated is it?",
    ];

describe.skipIf(!cube || !real)("latency breakdown, real model, isolated stack", () => {
  let env: Env;
  let api: Api;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let pool: pg.Pool;
  const rows: unknown[] = [];
  beforeAll(async () => {
    env = await makeEnv({ kernel: true });
    api = await startApi(env);
    worker = await startWorker(env, { live: true });
    pool = new pg.Pool({ connectionString: env.db.adminUrl });
  }, 180_000);
  afterAll(async () => {
    if (process.env.A37_REPORT)
      writeFileSync(
        process.env.A37_REPORT,
        JSON.stringify({ at: new Date().toISOString(), runs: rows }, null, 2),
      );
    await pool?.end();
    await worker?.stop();
    await api?.close();
    await env?.stop();
  });
  for (const [n, question] of QUESTIONS.entries())
    it(`question ${n + 1}`, async () => {
      const row = (await measureQuestion(
        { call: api.call, pool, temporal: env.client, workspaceId: env.workspaceId },
        question,
        300_000,
      )) as { finalState?: string };
      rows.push(row);
      printRun(row);
      expect(row.finalState).toBe("COMPLETE");
    }, 330_000);
});
