import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENGINE_INTERFACES,
  Db,
  IntegrityGuard,
  Kernel,
  loadTrustedKeys,
  migrate,
} from "@nearesis/kernel";
import { buildApp } from "./app.ts";
import { temporalEngine } from "./temporal-engine.ts";
import { productionMonitoringConfig } from "./monitoring-config.ts";
import {
  CostGovernor,
  externalModelSpend,
  kernelAlertSink,
  kernelSpendGateFactory,
  paidEgressOpFromEnv,
} from "@nearesis/workflow";
import { AuthoredMetricStore, createCh, createPg, loadLiveRegistry } from "@nearesis/analytics";
import { buildSourceCatalogue, createAuthoringService } from "@nearesis/semantic-gateway";
import { startOpsBackground } from "./ops-background.ts";

/** Minimal .env loader (server-side only; values are never logged). */
function loadEnv(): void {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
loadEnv();
// Sessions survive API restarts: without an operator secret, the signing key ring persists (0600) under .data/keys.
if (!process.env.NEARESIS_SESSION_SECRET && !process.env.NEARESIS_SESSION_KEYRING)
  process.env.NEARESIS_SESSION_KEYRING = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".data",
    "keys",
    "session-keyring.json",
  );

const nodeEnv = process.env.NODE_ENV;
// Cost control: plugin egress is authorised before it leaves (the governor is bound after the kernel exists).
const costOn = process.env.NEARESIS_COST_CONTROL === "1";
let apiCost: CostGovernor | undefined;
if (process.env.DATABASE_URL) await migrate(process.env.DATABASE_URL);
const db = Db.connect();
const kernel = new Kernel({
  db,
  // Idle event streams share one journal-head read per 100 ms per workspace (ch.13 per-browser SSE limits).
  stream: { headCacheMs: 100 },
  plugins: {
    trustMode:
      nodeEnv === "production"
        ? "production"
        : process.env.NEARESIS_PLUGIN_TRUST === "dev_trust"
          ? "dev_trust"
          : "production",
    trustedKeys: loadTrustedKeys(),
    pluginRoot: process.env.NEARESIS_PLUGIN_ROOT ?? process.cwd(),
    engineInterfaces: DEFAULT_ENGINE_INTERFACES,
    // The near-thesis connector may reach the internal endpoints its signed manifest declares, and nothing else.
    execution: {
      internalPublishers: ["nearesis"],
      ...(costOn
        ? { spendGate: kernelSpendGateFactory(() => apiCost), paidEgressOp: paidEgressOpFromEnv() }
        : {}),
    },
  },
  // The real semantic catalog, required: metric, unit, version and range checks are enforced (fail closed if unavailable).
  monitoring: productionMonitoringConfig(undefined, new IntegrityGuard(db)),
});
await kernel.boot();
kernel.outbox.start();
kernel.telemetry?.start();
// SLO recording + burn alerts (needs runtime migration 005): NEARESIS_COST_CONTROL=1.
const ops = costOn ? startOpsBackground(kernel) : undefined;
if (costOn)
  apiCost = new CostGovernor({
    pool: kernel.db.pool,
    sink: kernelAlertSink(kernel),
    externalModelSpend: externalModelSpend(),
  });
// Governed metric authoring: store in the shared Postgres (analytics_meta, migration 003), ClickHouse nearesis_live.
const authoringCh = createCh({ database: "nearesis_live" });
let catalogueCache: { at: number; value: ReturnType<typeof buildSourceCatalogue> } | undefined;
const authoring = createAuthoringService({
  store: new AuthoredMetricStore(createPg()),
  ch: authoringCh,
  catalogue: () => {
    if (!catalogueCache || catalogueCache.at < Date.now() - 60_000)
      catalogueCache = {
        at: Date.now(),
        value: buildSourceCatalogue(authoringCh, { database: "nearesis_live" }),
      };
    return catalogueCache.value;
  },
  registry: loadLiveRegistry(),
});
// Testnet time anchor for publish manifests (ADR-20261111-005/006 hash-only commits), opt-in.
const publishAnchorChain =
  process.env.NEARESIS_PUBLISH_ANCHOR_TESTNET === "1"
    ? async (manifestHash: string) =>
        (await import("../../../scripts/release/testnet-anchor-manifest.ts")).anchorManifestOnChain(
          manifestHash,
          "api publish anchor",
        )
    : undefined;
const app = await buildApp({
  ...(publishAnchorChain ? { publishAnchorChain } : {}),
  kernel,
  authoring,
  externalModelSpend: externalModelSpend(),
  ...(ops ? { sloRecorder: ops.recorder } : {}),
  ...(process.env.NEARESIS_MONITOR_BACKGROUND === "1" ? { monitorBackground: {} } : {}),
  ...(process.env.NEARESIS_MCP_GATEWAY_SECRET
    ? {
        gatewayCredential: {
          secret: process.env.NEARESIS_MCP_GATEWAY_SECRET,
          audience: process.env.NEARESIS_MCP_DOWNSTREAM_AUDIENCE ?? "nearesis-api",
        },
      }
    : {}),
  engine: temporalEngine(process.env.TASK_QUEUE ? { taskQueue: process.env.TASK_QUEUE } : {}),
});
if (process.env.NEARESIS_MONITOR_BACKGROUND === "1")
  (await import("./monitor-feeder-live.ts")).startLiveMonitorFeeder(kernel, app);
const port = Number(process.env.PORT ?? 4100);
await app.listen({ host: "127.0.0.1", port });
console.log(`nearesis api listening on 127.0.0.1:${port}`);
