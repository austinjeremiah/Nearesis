import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NativeConnection, Worker } from "@temporalio/worker";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { observe } from "@nearesis/acceptance";
import { connectClient, replayFiles, WORKFLOWS_PATH } from "../../src/index.ts";
import { HISTORY_DIR, makeEnv, q, sha, type Env } from "../helpers/harness.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";

let env: Env;
let client: Client;
beforeAll(async () => {
  env = await makeEnv();
  client = await connectClient();
}, 120_000);
afterAll(async () => {
  await env.stop();
});

const fx = (n: string) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));

it("A13: recorded histories replay deterministically; the negative control fails", async () => {
  const files = readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const a20 = files.filter((f) => f.startsWith("a20-"));
  const cancel = files.filter((f) => f.startsWith("a10-cancel"));
  const approval = files.filter((f) => f.startsWith("a06-approval") || f.startsWith("a20-"));
  expect(a20.length).toBeGreaterThan(0); // histories exported from the A20 run
  expect(cancel.length).toBeGreaterThan(0); // history including a cancellation (A10)
  expect(approval.length).toBeGreaterThan(0); // history including an approval signal (A06)

  const entries = files.map((f) => {
    const raw = readFileSync(`${HISTORY_DIR}/${f}`, "utf8");
    const wid = f.split("__")[2]!.replace(/\.json$/, "");
    return { file: `${HISTORY_DIR}/${f}`, workflowId: wid, sha256: sha(raw) };
  });
  // (b) replay executes 0 activities: DB side-effect ledger and gateway counters are untouched by the replay
  const before = await q<{ n: string }>(
    env,
    env.tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects",
  );
  const results = await replayFiles(entries.map((e) => ({ file: e.file, workflowId: e.workflowId })));
  const after = await q<{ n: string }>(
    env,
    env.tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects",
  );
  expect(after[0]!.n).toBe(before[0]!.n);
  const failures = results.filter((r) => !r.ok);
  expect(failures).toEqual([]); // (a) 0 non-determinism errors
  expect(results).toHaveLength(entries.length);

  // (c) negative control: record a v1 history on the real server, replay under v1 (ok) and v2 (must fail)
  const taskQueue = `a3-control-${randomUUID()}`;
  const counters = { a: 0, b: 0 };
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:57233",
  });
  const worker = await Worker.create({
    connection,
    taskQueue,
    workflowsPath: fx("control-v1.ts"),
    activities: {
      stepA: async () => (counters.a++, "a"),
      stepB: async () => (counters.b++, "b"),
    },
  });
  const wid = `control-${randomUUID()}`;
  await worker.runUntil(client.workflow.execute("ControlWorkflow", { taskQueue, workflowId: wid }));
  await connection.close();
  const ctlFile = join(mkdtempSync(join(tmpdir(), "a3-ctl-")), "control.json");
  writeFileSync(ctlFile, historyToJSON(await client.workflow.getHandle(wid).fetchHistory()));
  const v1 = await replayFiles([{ file: ctlFile, workflowId: wid }], fx("control-v1.ts"));
  const v2 = await replayFiles([{ file: ctlFile, workflowId: wid }], fx("control-v2.ts"));
  expect(v1[0]!.ok).toBe(true);
  expect(v2[0]!.ok).toBe(false);
  expect(v2[0]!.error).toMatch(/Nondeterminism|determinis/i);
  const countersAfterReplay = { ...counters };
  expect(countersAfterReplay).toEqual({ a: 1, b: 1 }); // replays ran no activities

  const logPath = join(mkdtempSync(join(tmpdir(), "a3-replay-")), "replay.log");
  const log = JSON.stringify({ results, control: { v1, v2 } }, null, 2);
  writeFileSync(logPath, log);
  const bundleHash = sha(
    readFileSync(WORKFLOWS_PATH, "utf8") +
      readFileSync(fileURLToPath(new URL("../../src/pure.ts", import.meta.url)), "utf8"),
  );
  observe({
    testId: "A13",
    observed: `${results.length} recorded histories (A20 ${a20.length}, cancellation ${cancel.length}, approval ${approval.length}) replayed on current code with ${failures.length} non-determinism errors; ledger rows unchanged by replay (${before[0]!.n} -> ${after[0]!.n}), control-workflow activity counters stayed {a:1,b:1}; negative control v2 failed: ${v2[0]!.error}`,
    fixtureHash: sha(entries.map((e) => e.sha256).join("")),
    evidence: {
      histories: entries.map((e) => ({ file: e.file.split("/").pop(), sha256: e.sha256 })),
      workflowSourceSha256: bundleHash,
      replayLog: results,
      negativeControl: { v1, v2 },
      replayLogHash: sha(log),
    },
  });
}, 300_000);
