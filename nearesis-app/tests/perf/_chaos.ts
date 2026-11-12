/**
 * Plumbing for PERF11 and the backup drill: the isolated fault-injection stack (compose project `nearesis-chaos`,
 * ports 64xxx, own volumes; see infrastructure/compose/chaos.yml and scripts/chaos/stack.sh), the environment
 * redirection that points every harness at it, a mock paid API and a mock chain (both record every delivery), and the
 * pure judgement functions shared by the real run and its negative control.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { APP_ROOT } from "./_reference.ts";

export const ISOLATED = {
  project: "nearesis-chaos",
  pg: 64432,
  redis: 64379,
  chHttp: 64123,
  chNative: 64900,
  temporal: 64233,
  cube: 64400,
};
export const PG_ADMIN_URL = `postgres://nearesis:nearesis@127.0.0.1:${ISOLATED.pg}/nearesis`;
export const PG_APP_URL = `postgres://nearesis_app:nearesis_app@127.0.0.1:${ISOLATED.pg}/nearesis`;
export const CH_URL = `http://127.0.0.1:${ISOLATED.chHttp}`;
export const CUBE_URL = `http://127.0.0.1:${ISOLATED.cube}`;
const STACK_SH = join(APP_ROOT, "scripts", "chaos", "stack.sh");

/** Redirects every shared helper (kernel test db, runtime db, Temporal client, ClickHouse, Cube) to the isolated stack. */
export function useIsolatedEnv(): void {
  process.env.DATABASE_URL = PG_ADMIN_URL;
  process.env.DATABASE_APP_URL = PG_APP_URL;
  process.env.TEMPORAL_ADDRESS = `127.0.0.1:${ISOLATED.temporal}`;
  process.env.NEARESIS_CH_URL = CH_URL;
  process.env.NEARESIS_CUBE_URL = CUBE_URL;
  process.env.REDIS_URL = `redis://127.0.0.1:${ISOLATED.redis}`;
}

export function stack(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(STACK_SH, args, { encoding: "utf8", timeout: 240_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Non-blocking variant for fault injection: the test process keeps generating load and probing while a service restarts. */
export function stackAsync(...args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(STACK_SH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(
  fn: () => Promise<boolean>,
  deadlineMs: number,
  everyMs = 250,
): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      if (await fn()) return Date.now() - t0;
    } catch {
      /* not yet */
    }
    await sleep(everyMs);
  }
  return null;
}

/** True when every isolated service answers: Postgres, Redis, ClickHouse, Temporal (via TCP), Cube. */
export async function stackHealthy(): Promise<{ ok: boolean; down: string[] }> {
  const down: string[] = [];
  const net = await import("node:net");
  const tcp = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.setTimeout(1500);
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
      s.once("timeout", () => (s.destroy(), resolve(false)));
    });
  for (const [n, p] of [
    ["postgres", ISOLATED.pg],
    ["redis", ISOLATED.redis],
    ["temporal", ISOLATED.temporal],
  ] as const)
    if (!(await tcp(p))) down.push(n);
  for (const [n, u] of [
    ["clickhouse", `${CH_URL}/ping`],
    ["cube", `${CUBE_URL}/readyz`],
  ] as const) {
    try {
      if (!(await fetch(u, { signal: AbortSignal.timeout(2000) })).ok) down.push(n);
    } catch {
      down.push(n);
    }
  }
  return { ok: down.length === 0, down };
}

export interface MockProvider {
  url: string;
  paid: { deliveries: Map<string, number>; accepted: Set<string> };
  chain: { broadcasts: Map<string, number>; txs: Set<string>; lookups: Map<string, number> };
  close(): Promise<void>;
}

/**
 * Mock metered providers living in the test process (never killed by a fault). The paid API is IDEMPOTENT by key
 * (a repeated key is a delivery but not a second acceptance). The mock chain accepts a broadcast immediately but answers
 * slowly (`chainDelayMs`), so a worker killed mid-broadcast leaves a pending write that must be resolved by lookup.
 */
export async function startMockProvider(chainDelayMs = 400): Promise<MockProvider> {
  const paid = { deliveries: new Map<string, number>(), accepted: new Set<string>() };
  const chain = {
    broadcasts: new Map<string, number>(),
    txs: new Set<string>(),
    lookups: new Map<string, number>(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, string> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        /* empty */
      }
      const send = (code: number, v: unknown, delay = 0) =>
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(v));
          }
        }, delay);
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/paid") {
        const k = String(body.idempotencyKey ?? "");
        paid.deliveries.set(k, (paid.deliveries.get(k) ?? 0) + 1);
        paid.accepted.add(k);
        return send(200, { ok: true, key: k });
      }
      if (req.method === "POST" && url === "/broadcast") {
        const h = String(body.txHash ?? "");
        chain.broadcasts.set(h, (chain.broadcasts.get(h) ?? 0) + 1);
        chain.txs.add(h);
        return send(200, { ok: true, txHash: h }, chainDelayMs);
      }
      const m = /^\/tx\/(.+)$/.exec(url);
      if (req.method === "GET" && m) {
        const h = decodeURIComponent(m[1]!);
        chain.lookups.set(h, (chain.lookups.get(h) ?? 0) + 1);
        return chain.txs.has(h) ? send(200, { found: true, txHash: h }) : send(404, { found: false });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paid,
    chain,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export interface LedgerRow {
  effect_key: string;
  kind: string;
  guarantee: string;
  provider_calls: number;
  status: string;
}

/**
 * PERF11 (b)+(e) judgement over the side-effect ledger and the providers' own records (pure, so the negative control
 * runs the same code): every idempotent effect accepted exactly once; no chain broadcast repeated; every ledger row
 * done. Duplicate DELIVERIES of an idempotent call are allowed only because the provider dedupes by key (disclosed).
 */
export function judgeEffects(a: {
  ledger: LedgerRow[];
  paidAccepted: Map<string, number>;
  chainBroadcasts: Map<string, number>;
  expectedPaid: string[];
  expectedChain: string[];
}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const k of a.expectedPaid) {
    const n = a.paidAccepted.get(k) ?? 0;
    if (n !== 1) problems.push(`paid effect ${k} accepted ${n} times`);
  }
  for (const h of a.expectedChain) {
    const n = a.chainBroadcasts.get(h) ?? 0;
    if (n !== 1) problems.push(`chain tx ${h} broadcast ${n} times`);
  }
  for (const r of a.ledger)
    if (r.status !== "done") problems.push(`ledger row ${r.effect_key} is ${r.status}`);
  const keys = a.ledger.map((r) => r.effect_key);
  if (new Set(keys).size !== keys.length) problems.push("duplicate ledger keys");
  return { ok: problems.length === 0, problems };
}

/** PERF11 (c) judgement over one workspace's event journal: seq is exactly 1..n, no duplicate event ids. */
export function judgeJournal(rows: Array<{ seq: number; event_id: string }>): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const sorted = [...rows].sort((x, y) => x.seq - y.seq);
  sorted.forEach((r, i) => {
    if (r.seq !== i + 1) problems.push(`gap or duplicate at seq ${r.seq} (expected ${i + 1})`);
  });
  if (new Set(rows.map((r) => r.event_id)).size !== rows.length) problems.push("duplicate event ids");
  return { ok: problems.length === 0, problems: problems.slice(0, 5) };
}
