/** Shared fixtures for the G06 acceptance tests M08-M16 (kernel, real Postgres, real command bus and scheduler). */
import { createHash, randomUUID } from "node:crypto";
import { HTTP_STATUS_FOR, PanelSpec } from "@nearesis/contracts";
import type { Kernel, Session, RunPort, RunOutput } from "../../src/index.ts";
import { KernelError } from "../../src/index.ts";
import { createWs, runCmd } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

export const sha256 = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export const panelSpec = () =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Swap volume",
    queryRef: { hash: "a".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

export const wsVersion = async (db: TestDb, ws: string): Promise<number> =>
  (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0].version as number;

export async function workspaceWithPanel(k: Kernel, db: TestDb, s: Session) {
  const { workspaceId } = await createWs(k, s);
  const p = panelSpec();
  await runCmd(
    k,
    s,
    workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 0,
      operations: [{ op: "addPanel", panel: p }],
    },
    await wsVersion(db, workspaceId),
  );
  return { workspaceId, panelId: p.panelId };
}

export const cmd = async (
  k: Kernel,
  db: TestDb,
  s: Session,
  ws: string,
  type: Parameters<typeof runCmd>[3],
  payload: Record<string, unknown>,
) => runCmd(k, s, ws, type, payload, await wsVersion(db, ws));

export async function rejected(p: Promise<unknown>): Promise<KernelError & { status: number }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof KernelError)) throw e;
    return Object.assign(e, { status: HTTP_STATUS_FOR[e.code] });
  }
  throw new Error("expected the call to be rejected");
}

/**
 * Deterministic stand-in for the investigation runtime at the RunPort boundary (the component under test in M08/M14 is the
 * marker/monitor machinery, not Temporal). It records every start so tests can prove 0 spawns, and a run completes on the
 * first status poll with the configured outputs.
 */
export class ScriptedRunPort implements RunPort {
  readonly starts: Array<{ question: string; budget: unknown; grants: string[]; mode: string; key: string }> =
    [];
  private readonly polls = new Map<string, number>();
  constructor(
    private readonly script: {
      outputs?: (n: number) => RunOutput[];
      failStart?: () => boolean;
      failure?: string;
    } = {},
  ) {}
  async start(
    _s: Session,
    _ws: string,
    input: { question: string; budget: unknown; grants: string[]; mode: string; idempotencyKey: string },
  ) {
    if (this.script.failStart?.()) throw new Error("workflow service unavailable");
    this.starts.push({
      question: input.question,
      budget: input.budget,
      grants: input.grants,
      mode: input.mode,
      key: input.idempotencyKey,
    });
    return { runId: randomUUID(), workflowId: `wf-${randomUUID()}` };
  }
  async status(_s: Session, runId: string) {
    const n = (this.polls.get(runId) ?? 0) + 1;
    this.polls.set(runId, n);
    if (n < 1) return { state: "EXECUTING", terminal: false, succeeded: false, outputs: [] };
    if (this.script.failure)
      return {
        state: "FAILED",
        terminal: true,
        succeeded: false,
        outputs: [],
        failure: { reasonCode: this.script.failure },
      };
    const outs = this.script.outputs?.(this.starts.length) ?? [
      { taskId: randomUUID(), role: "quant", outputRef: `out-${runId}` },
    ];
    return { state: "COMPLETE", terminal: true, succeeded: true, outputs: outs };
  }
}

import { DEFAULT_ENGINE_INTERFACES, Kernel as KernelClass } from "../../src/index.ts";
import type { MetricCatalog } from "../../src/index.ts";
import { FIXTURE_ROOT, TEST_KEY, TEST_PUBLISHER } from "../helpers/index.ts";

/** Fixture catalog (SYNTHETIC, labelled): certified metrics with units, one catalog version, and an accessible range. */
export const FIXTURE_CATALOG: MetricCatalog = {
  semanticVersion: "1.0.0",
  knownVersions: ["1.0.0", "1.1.0"],
  metrics: { vol: { unit: "USD" }, swaps: { unit: "swaps" }, failure_rate: { unit: "ratio" } },
  accessibleRange: { start: "2026-01-01T00:00:00Z", end: "2026-10-31T23:59:59Z" },
};

/** The test kernel with a semantic catalog configured for monitoring validation. */
export function monitoringKernel(db: TestDb, catalog: MetricCatalog | undefined = FIXTURE_CATALOG): Kernel {
  return new KernelClass({
    db: db.app,
    plugins: {
      trustMode: "production",
      trustedKeys: { [TEST_PUBLISHER]: [TEST_KEY.publicKey] },
      pluginRoot: FIXTURE_ROOT,
      engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      quarantineAfterFailures: 3,
    },
    sessionSecret: "test-session-secret-0123456789abcdef",
    nodeEnv: "test",
    ...(catalog ? { monitoring: { catalog } } : {}),
  });
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  deadlineMs: number,
  everyMs = 100,
  what = "condition",
): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** mulberry32: seeded PRNG so shuffles are reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = seeded(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
