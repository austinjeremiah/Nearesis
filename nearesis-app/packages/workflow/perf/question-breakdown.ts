/* eslint-disable @typescript-eslint/no-explicit-any, no-empty, no-useless-assignment, @typescript-eslint/no-unused-vars */
/**
 * End-to-end time breakdown of real questions through the live API (final_master_prompt s15).
 *   pnpm --filter @nearesis/workflow exec tsx perf/question-breakdown.ts [--base-url http://127.0.0.1:4110] [--out f.json] ["question" ...]
 * (no question: three default questions). Submits each question to a fixture-only measurement workspace, approves the pending
 * patch at once, waits for the terminal state and prints the breakdown of perf/breakdown.ts. Spend is read from /v1/cost/global.
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { measureQuestion, printRun, type BreakdownIo } from "./breakdown.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BASE = arg("base-url") ?? "http://127.0.0.1:4110";
const skip = new Set([arg("base-url"), arg("out")].filter(Boolean));
const argvQs = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith("--") && !skip.has(a) && !all[i - 1]?.startsWith("--"));
const QUESTIONS = argvQs.length
  ? argvQs
  : [
      "Intents swaps by status per week since August - how have refunds changed?",
      "Daily NEAR transactions vs Intents swap volume since May, with NEAR price",
      "Which origin and destination chains carry the most Intents volume and how concentrated is it?",
    ];

let token: string | null = null;
async function call(method: "GET" | "POST", path: string, body?: unknown, h: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...h,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, json: j };
}

async function main() {
  token = (await call("POST", "/v1/dev/login", { oidcSubject: "dev-owner" })).json.token as string;
  const cost = async () => (await call("GET", "/v1/cost/global")).json.committedUsd as number;
  const spend0 = await cost();
  const OBJ = "Nearesis latency measurement";
  let ws = ((await call("GET", "/v1/workspaces")).json.workspaces as any[]).find(
    (w) => w.objective === OBJ,
  )?.id;
  if (!ws) {
    ws = (
      await call(
        "POST",
        "/v1/workspaces",
        { objective: OBJ, networkScope: "fixture-only" },
        { "idempotency-key": "latency-measurement-ws-0001" },
      )
    ).json.workspaceId;
    const v = (await call("GET", `/v1/workspaces/${ws}`)).json.version;
    await call("POST", `/v1/workspaces/${ws}/commands`, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "plugin.enable",
      payload: { pluginId: "near-thesis" },
      expectedVersion: v,
    });
  }
  const io: BreakdownIo = {
    call,
    pool: new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis",
    }),
    temporal: new Client({
      connection: await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:57233" }),
    }),
    workspaceId: ws,
  };
  const out: unknown[] = [];
  for (const q of QUESTIONS) {
    const row = await measureQuestion(io, q);
    out.push(row);
    printRun(row);
  }
  const spend1 = await cost();
  console.log(
    `spend ${(spend1 - spend0).toFixed(4)} USD (global committed ${spend0.toFixed(4)} -> ${spend1.toFixed(4)})`,
  );
  if (arg("out"))
    writeFileSync(
      arg("out")!,
      JSON.stringify({ at: new Date().toISOString(), spendUsd: spend1 - spend0, runs: out }, null, 2),
    );
  await io.pool.end();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
