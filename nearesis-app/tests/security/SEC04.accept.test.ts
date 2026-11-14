/**
 * SEC04: a mainnet (or any unapproved) chain action is refused. PASS: 0 chain writes.
 * Real kernel, real Postgres RLS, real plugin manager and tool gateway. The "chain" is an in-process ledger behind a
 * chain_write capability, so the test counts exactly how many writes happened. No network and no wallet involved.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { canonicalJson, sha256Hex, signManifest } from "../../packages/plugin-sdk/src/index.ts";
import type { CapabilityDecl, ExecutionRequest, PluginManifest } from "../../packages/contracts/src/index.ts";
import { TOOL_CATALOG } from "../../packages/agent-runtime/src/tools.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import {
  TEST_KEY,
  TEST_PUBLISHER,
  cap,
  createTestDb,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "plugins");
const CAP = "sec04_chain.commit@1";
const chain = () => (globalThis as unknown as { __sec04Chain: unknown[] }).__sec04Chain;

function manifest(): PluginManifest {
  const file = readFileSync(join(ROOT, "chain-writer.ts"));
  const m = {
    pluginId: "sec04-chain",
    version: "1.0.0",
    apiVersion: 1,
    publisher: TEST_PUBLISHER,
    artifactSha256: createHash("sha256").update(file).digest("hex"),
    capabilities: [
      cap(CAP, {
        sideEffect: "chain_write",
        idempotent: false,
        category: "network.adapter",
        requiredGrants: ["fx:run"],
        inputSchema: {
          type: "object",
          properties: { network: { type: "string" }, payload: {} },
          additionalProperties: true,
        },
      } as Partial<CapabilityDecl>),
    ],
    permissions: [],
    networkHosts: [],
    resourceLimits: { memoryMb: 64, cpuMs: 1000, concurrency: 4 },
    configurationSchema: {},
    healthCheck: { intervalMs: 60_000 },
    entrypoint: "chain-writer.ts",
    rollbackStrategy: "previous_version",
    requires: [],
  } as unknown as PluginManifest;
  (m as unknown as Record<string, unknown>).signature = signManifest(m, TEST_KEY.privateKey);
  return m;
}

let db: TestDb;
let k: Kernel;
let human: Session;
let orgId: string;
beforeAll(async () => {
  db = await createTestDb();
  k = testkernel();
  const org = await seedOrg(db.admin, "sec04", { alice: "owner" });
  orgId = org.orgId;
  human = await loginSession(k, org.users.alice!.subject);
  await k.plugins.install(null, manifest());
  await k.plugins.enable(null, "sec04-chain");
});
function testkernel(): Kernel {
  return testKernel(db, { pluginRoot: ROOT });
}
afterAll(async () => db?.drop());

type Scope = "fixture-only" | "near-mainnet-read" | "near-testnet";
async function workspace(scope: Scope) {
  const w = await k.workspaces.create(human, {
    objective: `sec04 ${scope}`,
    networkScope: scope,
    idempotencyKey: `c-${randomUUID()}`,
  });
  await pluginUp(k, human, w.workspaceId, w.version, "sec04-chain");
  return w.workspaceId;
}
function agent(run: string): { session: Session; id: string } {
  const id = randomUUID();
  return {
    id,
    session: {
      principal: { kind: "agent", actorId: id, orgId, parentRunId: run },
      role: human.role,
      userId: human.userId,
    } as Session,
  };
}
function req(
  s: Session,
  ws: string,
  input: unknown,
  actor: ExecutionRequest["actor"],
  over: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    tenantId: s.principal.orgId,
    workspaceId: ws,
    actor,
    capability: CAP,
    input,
    deadlineMs: 5000,
    trace: { traceId: randomUUID() },
    ...over,
  } as ExecutionRequest;
}
const approve = (ws: string, run: string, hash: string, ttlMs?: number) =>
  k.db.tx({ orgId, userId: human.userId }, (tx) =>
    k.approvals.grant(tx, {
      orgId,
      workspaceId: ws,
      runId: run,
      actionHash: hash,
      approvedBy: human.userId,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }),
  );
const hashOf = (input: unknown) => sha256Hex(canonicalJson({ capability: CAP, input }));

it("SEC04: chain actions without a valid approval, or aimed at mainnet, perform 0 chain writes", async () => {
  const outcomes: Array<{ case: string; state: string; reason: string | null }> = [];
  const attempt = async (name: string, s: Session, r: ExecutionRequest) => {
    const before = chain().length;
    const res = await k.gateway.invoke(s.principal, r).catch((e) => ({
      state: "threw" as const,
      reasonCode: (e as { reasonCode?: string }).reasonCode ?? "THREW",
    }));
    outcomes.push({
      case: name,
      state: res.state,
      reason: (res as { reasonCode?: string }).reasonCode ?? null,
    });
    return { res, wrote: chain().length - before };
  };
  const commitInput = (network: string) => ({ network, payload: { manifestHash: "a".repeat(64) } });

  // ---- cases that must write nothing
  const denied: Array<
    [string, Scope, "agent" | "human", (ws: string, run: string) => Promise<void> | void, string]
  > = [
    ["agent, mainnet-read scope, no approval", "near-mainnet-read", "agent", () => undefined, "mainnet"],
    [
      "agent, mainnet-read scope, valid approval for the exact call",
      "near-mainnet-read",
      "agent",
      async (ws, run) => approve(ws, run, hashOf(commitInput("mainnet"))),
      "mainnet",
    ],
    [
      "agent, fixture-only scope, valid approval",
      "fixture-only",
      "agent",
      async (ws, run) => approve(ws, run, hashOf(commitInput("testnet"))),
      "testnet",
    ],
    ["agent, testnet scope, no approval", "near-testnet", "agent", () => undefined, "testnet"],
    [
      "agent, testnet scope, approval for a different payload",
      "near-testnet",
      "agent",
      async (ws, run) => approve(ws, run, hashOf({ network: "testnet", payload: "other" })),
      "testnet",
    ],
    [
      "agent, testnet scope, expired approval",
      "near-testnet",
      "agent",
      async (ws, run) => approve(ws, run, hashOf(commitInput("testnet")), 1),
      "testnet",
    ],
    [
      "agent, testnet scope, approval belonging to another run",
      "near-testnet",
      "agent",
      async (ws) => approve(ws, randomUUID(), hashOf(commitInput("testnet"))),
      "testnet",
    ],
    [
      "agent, testnet scope, approval hash for a mainnet-labelled call",
      "near-testnet",
      "agent",
      async (ws, run) => approve(ws, run, hashOf(commitInput("mainnet"))),
      "mainnet",
    ],
    ["human, mainnet-read scope", "near-mainnet-read", "human", () => undefined, "mainnet"],
    ["human, fixture-only scope", "fixture-only", "human", () => undefined, "testnet"],
    ["human, testnet scope but the call names mainnet", "near-testnet", "human", () => undefined, "Mainnet"],
  ];
  for (const [name, scope, who, prep, network] of denied) {
    const ws = await workspace(scope);
    const run = randomUUID();
    let s = human;
    let actor: ExecutionRequest["actor"] = { kind: "human", actorId: human.principal.actorId };
    let holder = human.principal.actorId;
    if (who === "agent") {
      const a = agent(run);
      s = a.session;
      actor = { kind: "agent", actorId: a.id, parentRunId: run };
      holder = a.id;
    }
    await k.leases.issue(human, {
      workspaceId: ws,
      holderActorId: holder,
      capability: CAP,
      grants: [grant()],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await prep(ws, run);
    if (name.includes("expired")) await new Promise((r) => setTimeout(r, 30));
    const { wrote } = await attempt(name, s, req(s, ws, commitInput(network), actor));
    expect(wrote, name).toBe(0);
  }
  // a forged actor claim (human claiming to be the agent's principal) is rejected before anything else
  {
    const ws = await workspace("near-testnet");
    const a = agent(randomUUID());
    const { wrote } = await attempt(
      "agent principal forging a human actor",
      a.session,
      req(a.session, ws, commitInput("testnet"), { kind: "human", actorId: a.id }),
    );
    expect(wrote).toBe(0);
  }
  // the agent tool catalog offers no chain_write tool at all: an agent-invented chain tool never reaches the gateway
  expect(TOOL_CATALOG.filter((t) => t.sideEffect === "chain_write")).toEqual([]);
  expect(TOOL_CATALOG.some((t) => /chain|near\.tx|sign|swap/i.test(t.id))).toBe(false);

  expect(chain().length).toBe(0);

  // ---- positive control (testnet scope only): exactly the approved call executes, once
  const ws = await workspace("near-testnet");
  const run = randomUUID();
  const a = agent(run);
  await k.leases.issue(human, {
    workspaceId: ws,
    holderActorId: a.id,
    capability: CAP,
    grants: [grant()],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const input = commitInput("testnet");
  await approve(ws, run, hashOf(input));
  const actor = { kind: "agent", actorId: a.id, parentRunId: run } as const;
  const ok = await attempt(
    "control: agent, testnet scope, exact approval",
    a.session,
    req(a.session, ws, input, actor),
  );
  expect(ok.res.state).toBe("ok");
  expect(ok.wrote).toBe(1);
  const replay = await attempt(
    "control: replay with a new idempotency key (approval already used)",
    a.session,
    req(a.session, ws, input, actor),
  );
  expect(replay.wrote).toBe(0);
  expect(chain().length).toBe(1);

  const refused = outcomes.filter((o) => o.case !== "control: agent, testnet scope, exact approval").length;
  observe({
    testId: "SEC04",
    observed: `${refused} unapproved, mis-scoped, expired, replayed, forged and mainnet-labelled chain_write attempts (agents and humans, fixture-only / near-mainnet-read / near-testnet workspaces) all refused: chain writes 0; the agent tool catalog contains 0 chain_write tools; positive control (testnet scope, exact one-time approval) wrote exactly 1`,
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(denied.map((d) => d[0])))
      .digest("hex"),
    evidence: { outcomes, refusedWrites: 0, controlWrites: 1 },
  });
}, 120_000);
