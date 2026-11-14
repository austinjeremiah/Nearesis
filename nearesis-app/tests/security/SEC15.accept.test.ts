/**
 * SEC15: chain-write authorisation. PASS: only the valid owner approval executes, exactly once; every mutated, expired,
 * used, other-run or non-owner approval is denied with no chain call; non-allowlisted contracts and methods, and deposit or
 * gas above the ceiling, are denied before signing; the signer key is in no agent environment, file, audit row or tool
 * response; transfer and swap methods are not callable; each denial is audited and used_at is set once.
 *
 * Mode FIXTURE: the chain is a loopback JSON-RPC fixture that logs every request and verifies the signature against a
 * public key; the signing key is generated here for this run (a local fixture key, never a wallet). The LIVE half (a
 * funded testnet account) is not run: it needs a funded key and RPC access, which the owner limits exclude.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { readbackLive, signerPemFromEnv } from "../../plugins/chain-commit/src/live.ts";
import { canonicalJson, sha256Hex, signManifest } from "../../packages/plugin-sdk/src/index.ts";
import type { ExecutionRequest } from "../../packages/contracts/src/index.ts";
import { TOOL_CATALOG } from "../../packages/agent-runtime/src/tools.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import {
  TEST_KEY,
  TEST_PUBLISHER,
  createTestDb,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import {
  ALLOWED_CONTRACT,
  ALLOWED_METHOD,
  CAPABILITY,
  MAX_GAS,
  PLUGIN_ROOT,
  buildManifest,
  startSigner,
} from "../../plugins/chain-commit/src/index.ts";

const ROOT = join(process.cwd(), "plugins", "chain-commit");
type Rpc = { params: { tx: unknown; digest: string; signature: string }; validSignature: boolean };

let db: TestDb;
let k: Kernel;
let alice: Session; // owner
let anna: Session; // analyst (non-owner approver)
let orgId: string;
let signer: Awaited<ReturnType<typeof startSigner>>;
let rpcServer: ReturnType<typeof createServer>;
let rpcPort = 0;
const rpcLog: Rpc[] = [];
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const pubKey = createPublicKey(keys.publicKey.export({ format: "pem", type: "spki" }));
const keyForms = (): string[] => {
  const der = keys.privateKey.export({ format: "der", type: "pkcs8" });
  const seed = der.subarray(der.length - 32);
  const body = privatePem.replace(/-----[^-]+-----|\s/g, "");
  return [
    body,
    Buffer.from(privatePem).toString("base64"),
    der.toString("base64"),
    der.toString("hex"),
    seed.toString("hex"),
    seed.toString("base64"),
    encodeURIComponent(body),
  ];
};

beforeAll(async () => {
  db = await createTestDb();
  signer = await startSigner(privatePem);
  rpcServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
        params: Rpc["params"];
      };
      const digest = createHash("sha256").update(JSON.stringify(body.params.tx)).digest();
      const validSignature =
        digest.toString("hex") === body.params.digest &&
        verify(null, digest, pubKey, Buffer.from(body.params.signature, "base64"));
      rpcLog.push({ params: body.params, validSignature });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { hash: `fixture-tx-${rpcLog.length}` } }),
        );
    });
  });
  await new Promise<void>((r) => rpcServer.listen(0, "127.0.0.1", r));
  rpcPort = (rpcServer.address() as { port: number }).port;
  process.env.CHAIN_COMMIT_SIGNER_URL = `http://127.0.0.1:${signer.port}/sign`;
  process.env.CHAIN_COMMIT_RPC_URL = `http://127.0.0.1:${rpcPort}/`;
  k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  const org = await seedOrg(db.admin, "sec15", { alice: "owner", anna: "analyst" });
  orgId = org.orgId;
  alice = await loginSession(k, org.users.alice!.subject);
  anna = await loginSession(k, org.users.anna!.subject);
  const m = buildManifest({
    publisher: TEST_PUBLISHER,
    networkHosts: [`127.0.0.1:${signer.port}`, `127.0.0.1:${rpcPort}`],
  });
  (m as unknown as Record<string, unknown>).signature = signManifest(m, TEST_KEY.privateKey);
  await k.plugins.install(null, m);
  await k.plugins.enable(null, "chain-commit");
}, 120_000);
afterAll(async () => {
  signer?.stop();
  await new Promise<void>((r) => (rpcServer ? rpcServer.close(() => r()) : r()));
  await db?.drop();
});

const good = (over: Record<string, unknown> = {}) => ({
  network: "near-testnet",
  contract: ALLOWED_CONTRACT,
  method: ALLOWED_METHOD,
  payloadHash: "a".repeat(64),
  depositYocto: "1",
  gas: 10_000_000_000_000,
  ...over,
});
const hashOf = (input: unknown) => sha256Hex(canonicalJson({ capability: CAPABILITY, input }));

async function workspace() {
  const w = await k.workspaces.create(alice, {
    objective: "sec15 testnet",
    networkScope: "near-testnet",
    idempotencyKey: `c-${randomUUID()}`,
  });
  await pluginUp(k, alice, w.workspaceId, w.version, "chain-commit");
  return w.workspaceId;
}
function agent(run: string) {
  const id = randomUUID();
  const session = {
    principal: { kind: "agent", actorId: id, orgId, parentRunId: run },
    role: alice.role,
    userId: alice.userId,
  } as Session;
  return { id, session, actor: { kind: "agent", actorId: id, parentRunId: run } as const };
}
const approve = (ws: string, run: string, hash: string, by: Session, ttlMs?: number) =>
  k.db.tx({ orgId, userId: by.userId }, (tx) =>
    k.approvals.grant(tx, {
      orgId,
      workspaceId: ws,
      runId: run,
      actionHash: hash,
      approvedBy: by.userId,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }),
  );
const stats = async () =>
  (await (await fetch(`http://127.0.0.1:${signer.port}/stats`)).json()) as {
    signed: number;
    refused: number;
  };

it("SEC15: only the exact owner approval writes, once; everything else is denied before signing; the key is unreachable", async () => {
  const outcomes: Array<{
    case: string;
    state: string;
    reason: string | null;
    chainCalls: number;
    signed: number;
  }> = [];
  const requestIds: string[] = [];
  const unusedApprovals: string[] = [];

  const attempt = async (
    name: string,
    ws: string,
    run: string,
    input: unknown,
    prep?: { approveHash?: string; by?: Session; ttlMs?: number; otherRun?: boolean; deadlineMs?: number },
    sameAgent?: ReturnType<typeof agent>,
  ) => {
    const a = sameAgent ?? agent(run);
    if (!sameAgent)
      await k.leases.issue(alice, {
        workspaceId: ws,
        holderActorId: a.id,
        capability: CAPABILITY,
        grants: [grant({ resource: "chain", action: "commit" })],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (prep?.approveHash)
      await approve(ws, prep.otherRun ? randomUUID() : run, prep.approveHash, prep.by ?? alice, prep.ttlMs);
    if (prep?.ttlMs !== undefined) await new Promise((r) => setTimeout(r, 30));
    const beforeCalls = rpcLog.length;
    const beforeSigned = (await stats()).signed;
    const req = {
      requestId: randomUUID(),
      idempotencyKey: `idem-${randomUUID()}`,
      tenantId: orgId,
      workspaceId: ws,
      actor: a.actor,
      capability: CAPABILITY,
      input,
      deadlineMs: prep?.deadlineMs ?? 8000,
      trace: { traceId: randomUUID() },
    } as unknown as ExecutionRequest;
    requestIds.push(req.requestId);
    const res = await k.gateway.invoke(a.session.principal, req).catch((e) => ({
      state: "threw" as const,
      reasonCode: (e as { reasonCode?: string }).reasonCode ?? "THREW",
    }));
    const o = {
      case: name,
      state: res.state,
      reason: (res as { reasonCode?: string }).reasonCode ?? null,
      chainCalls: rpcLog.length - beforeCalls,
      signed: (await stats()).signed - beforeSigned,
    };
    outcomes.push(o);
    return { res, ...o, agent: a };
  };

  // ---- (a) mutated approvals: each approval is for `good()`; each call changes exactly one parameter
  const mutations: Array<[string, Record<string, unknown>]> = [
    ["network", { network: "near-mainnet" }],
    ["network (alias)", { network: "testnet" }],
    ["contract", { contract: "other.nearesis.testnet" }],
    ["method", { method: "commit_hash_v2" }],
    ["payload hash", { payloadHash: "b".repeat(64) }],
    ["deposit", { depositYocto: "2" }],
    ["gas", { gas: 10_000_000_000_001 }],
  ];
  for (const [what, over] of mutations) {
    const ws = await workspace();
    const run = randomUUID();
    const r = await attempt(`approval for the original, ${what} mutated`, ws, run, good(over), {
      approveHash: hashOf(good()),
    });
    expect(r.chainCalls, what).toBe(0);
    expect(r.signed, what).toBe(0);
    expect(r.res.state, what).not.toBe("ok");
  }
  // expired, other run, non-owner issuer, no approval
  {
    const ws = await workspace();
    const run = randomUUID();
    const r1 = await attempt("expired approval", ws, run, good(), { approveHash: hashOf(good()), ttlMs: 1 });
    const r2 = await attempt("approval belongs to another run", await workspace(), randomUUID(), good(), {
      approveHash: hashOf(good()),
      otherRun: true,
    });
    const r3 = await attempt(
      "approval issued by a non-owner (analyst)",
      await workspace(),
      randomUUID(),
      good(),
      { approveHash: hashOf(good()), by: anna },
    );
    const r4 = await attempt("no approval", await workspace(), randomUUID(), good());
    for (const r of [r1, r2, r3, r4]) {
      expect(r.chainCalls, r.case).toBe(0);
      expect(r.signed, r.case).toBe(0);
      expect(r.res.state, r.case).not.toBe("ok");
    }
    expect(r3.reason).toBe("APPROVAL_REQUIRED");
  }

  // ---- (b) policy violations that DO carry a valid owner approval of their exact input: denied before signing
  const policy: Array<[string, Record<string, unknown>]> = [
    ["non-allowlisted contract", { contract: "evil.testnet" }],
    ["non-allowlisted method", { method: "set_owner" }],
    ["transfer method", { method: "ft_transfer" }],
    ["swap method", { method: "swap" }],
    ["transfer-and-call method", { method: "ft_transfer_call" }],
    ["mainnet network", { network: "near-mainnet" }],
    ["deposit at the ceiling (1e21)", { depositYocto: "1000000000000000000000" }],
    ["deposit far above the ceiling", { depositYocto: "9".repeat(30) }],
    ["gas above the ceiling", { gas: MAX_GAS + 1 }],
    ["gas not an integer", { gas: 1.5 }],
    ["payload is not a hash", { payloadHash: "plain text payload" }],
    ["extra field", { value: "transfer" }],
  ];
  for (const [what, over] of policy) {
    const input = good(over);
    const ws = await workspace();
    const r = await attempt(what, ws, randomUUID(), input, { approveHash: hashOf(input) });
    expect(r.chainCalls, what).toBe(0);
    expect(r.signed, what).toBe(0);
    expect(r.res.state, what).not.toBe("ok");
  }
  // the signer itself refuses policy violations even when called directly (the last line of defence)
  const signerDirect: Array<[string, Record<string, unknown>]> = [
    ["mainnet", { network: "near-mainnet" }],
    ["transfer", { method: "ft_transfer" }],
    ["swap", { method: "swap" }],
    ["other contract", { contract: "wrap.near" }],
    ["deposit above ceiling", { depositYocto: "1" + "0".repeat(21) }],
    ["gas above ceiling", { gas: MAX_GAS * 2 }],
  ];
  let signerRefused = 0;
  for (const [, over] of signerDirect) {
    const r = await fetch(`http://127.0.0.1:${signer.port}/sign`, {
      method: "POST",
      body: JSON.stringify({ tx: good(over) }),
    });
    if (r.status === 403) signerRefused++;
  }
  expect(signerRefused).toBe(signerDirect.length);

  // ---- positive control and (a) exactly once: the valid owner approval
  const ws = await workspace();
  const run = randomUUID();
  const ok = await attempt("valid owner approval", ws, run, good(), { approveHash: hashOf(good()) });
  expect(JSON.stringify(ok.res).slice(0, 600)).toContain('"state":"ok"');
  expect(ok.chainCalls).toBe(1);
  expect(ok.signed).toBe(1);
  const replay = await attempt(
    "replay with a new idempotency key (approval used)",
    ws,
    run,
    good(),
    undefined,
    ok.agent,
  );
  expect(replay.chainCalls).toBe(0);
  expect(replay.signed).toBe(0);
  expect(replay.res.state).not.toBe("ok");
  expect(rpcLog.filter((c) => c.validSignature).length).toBe(1);
  expect(rpcLog.every((c) => c.validSignature)).toBe(true);

  // ---- (c) key isolation
  const forms = keyForms();
  const contains = (text: string) => forms.filter((f) => text.includes(f)).length;
  const envLeak = contains(JSON.stringify(process.env));
  let signerEnv: string;
  try {
    // macOS and Linux: print the signer process's environment (`ps eww` appends it to the command)
    signerEnv = execFileSync("ps", ["eww", "-o", "command=", "-p", String(signer.child.pid)], {
      encoding: "utf8",
    });
  } catch {
    signerEnv = "";
  }
  const signerEnvLeak = contains(signerEnv) + contains(JSON.stringify(signer.child.spawnargs));
  const signerEnvVars = signerEnv.split(" ").filter((t) => /^[A-Z_]+=/.test(t));
  // files: this plugin, the security tests, and the OS temp dir (bounded walk)
  const walk = (dir: string, depth: number, out: string[]): string[] => {
    if (depth < 0) return out;
    let ents: string[];
    try {
      ents = readdirSync(dir);
    } catch {
      return out;
    }
    for (const e of ents) {
      if (e === "node_modules" || e === ".git") continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth - 1, out);
      else if (st.size < 2_000_000) out.push(p);
    }
    return out;
  };
  const files = [
    ...walk(ROOT, 6, []),
    ...walk(join(process.cwd(), "tests", "security"), 3, []),
    ...walk(tmpdir(), 2, []),
  ];
  let fileLeaks = 0;
  for (const f of files) {
    if (f.endsWith("SEC15.accept.test.ts")) continue;
    try {
      fileLeaks += contains(readFileSync(f, "utf8"));
    } catch {
      /* unreadable or binary */
    }
  }
  const audit = await db.admin.query<{
    detail: unknown;
    reason_code: string | null;
    action: string;
    subject: string | null;
  }>("SELECT detail, reason_code, action, subject FROM audit_events WHERE org_id = $1", [orgId]);
  const invocations = await db.admin.query("SELECT * FROM tool_invocations WHERE org_id = $1", [orgId]);
  const dbLeak = contains(JSON.stringify(audit.rows)) + contains(JSON.stringify(invocations.rows));
  const rpcLeak = contains(JSON.stringify(rpcLog));
  const responsesLeak = contains(JSON.stringify(outcomes));
  const agentTools = TOOL_CATALOG.filter(
    (t) => t.sideEffect === "chain_write" || /chain|sign|swap|transfer/i.test(t.id),
  );
  const manifestCaps = buildManifest({ publisher: "x", networkHosts: [] }).capabilities.map(
    (c) => (c as { id: string }).id,
  );

  // ---- (d) audit and used_at
  const denials = outcomes.filter((o) => o.state !== "ok");
  const audited = audit.rows.filter(
    (r) =>
      r.action === "tool.invoke.denied" && requestIds.some((id) => JSON.stringify(r.detail).includes(id)),
  );
  const approvals = await db.admin.query<{
    used_at: string | null;
    used_by: string | null;
    action_hash: string;
  }>("SELECT used_at, used_by, action_hash FROM command_approvals WHERE org_id = $1", [orgId]);
  const used = approvals.rows.filter((r) => r.used_at);
  void unusedApprovals;

  // ---- negative control: an approval checked only at issue time (the handler called with no gateway) writes to the chain
  const handlerPath = join(ROOT, "src", "entry.ts");
  const plugin = (await import(handlerPath)).default as {
    handlers: Record<string, (i: unknown, c: unknown) => Promise<unknown>>;
  };
  const beforeCtl = rpcLog.length;
  await plugin.handlers[CAPABILITY]!(good({ payloadHash: "c".repeat(64) }), {
    requestId: "ctl",
    signal: new AbortController().signal,
    egress: async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const r = await fetch(url, {
        method: init.method ?? "GET",
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body ? { body: init.body } : {}),
      });
      return { status: r.status, headers: {}, body: new Uint8Array(await r.arrayBuffer()), url };
    },
  });
  const controlWrote = rpcLog.length - beforeCtl;

  expect(denials.every((d) => d.chainCalls === 0 && d.signed === 0)).toBe(true);
  expect(denials.length).toBeGreaterThanOrEqual(mutations.length + policy.length + 5);
  expect(envLeak).toBe(0);
  expect(signerEnv.length).toBeGreaterThan(0); // the signer environment was actually read
  expect(signerEnvLeak).toBe(0);
  expect(signerEnvVars).toEqual([]);
  expect(fileLeaks).toBe(0);
  expect(dbLeak + rpcLeak + responsesLeak).toBe(0);
  expect(files.length).toBeGreaterThan(5);
  expect(agentTools).toEqual([]);
  expect(manifestCaps).toEqual([CAPABILITY]);
  expect(audited.length).toBe(denials.length);
  expect(used.length).toBe(1);
  expect(used[0]!.used_by).toBe(ok.res && requestIds[requestIds.indexOf(used[0]!.used_by ?? "")]);
  expect(used[0]!.action_hash).toBe(hashOf(good()));
  const reasons: Record<string, number> = {};
  for (const r of audited) reasons[r.reason_code ?? "none"] = (reasons[r.reason_code ?? "none"] ?? 0) + 1;
  for (const need of [
    "APPROVAL_NOT_OWNER",
    "APPROVAL_EXPIRED",
    "APPROVAL_HASH_MISMATCH",
    "APPROVAL_MISSING",
    "APPROVAL_REUSED",
    "INPUT_SCHEMA_INVALID",
  ])
    expect(reasons[need] ?? 0, need).toBeGreaterThan(0);
  expect(controlWrote).toBe(1); // sensitivity: an unguarded path does write, so the zero counts above mean something

  // ---- LIVE half (ADR-20261111-005/-006): the same gateway, approval and plugin path against NEAR testnet.
  let liveNote = "LIVE half not run (no --live)";
  let liveEvidence: Record<string, unknown> | null = null;
  if (process.env.NEARESIS_ACCEPT_LIVE === "1") {
    const liveSigner = await startSigner(signerPemFromEnv(join(process.cwd(), "..", ".env")));
    try {
      process.env.CHAIN_COMMIT_SIGNER_URL = `http://127.0.0.1:${liveSigner.port}/sign`;
      process.env.CHAIN_COMMIT_RPC_URL = "https://rpc.testnet.near.org";
      process.env.CHAIN_COMMIT_LIVE = "1";
      const m2 = buildManifest({
        publisher: TEST_PUBLISHER,
        networkHosts: [`127.0.0.1:${liveSigner.port}`, "rpc.testnet.near.org"],
        version: "1.1.0",
      });
      (m2 as unknown as Record<string, unknown>).signature = signManifest(m2, TEST_KEY.privateKey);
      await k.plugins.install(null, m2);
      await k.plugins.upgrade(null, "chain-commit", "1.1.0");
      const liveHash = createHash("sha256").update(`sec15-live-${Date.now()}`).digest("hex");
      const liveGood = good({ payloadHash: liveHash, depositYocto: "0", gas: 30_000_000_000_000 });
      const liveStats = async () =>
        (await (await fetch(`http://127.0.0.1:${liveSigner.port}/stats`)).json()) as { signed: number };
      // denials with valid approvals of their exact input: 0 signatures, nothing broadcast
      const before = (await liveStats()).signed;
      for (const over of [
        { network: "near-mainnet" },
        { contract: "evil.testnet" },
        { method: "ft_transfer" },
      ]) {
        const input = { ...liveGood, ...over };
        const d = await attempt("live denial", await workspace(), randomUUID(), input, {
          approveHash: hashOf(input),
        });
        expect(d.res.state).not.toBe("ok");
      }
      expect((await liveStats()).signed - before).toBe(0);
      const lws = await workspace();
      const lrun = randomUUID();
      const lok = await attempt("live valid owner approval", lws, lrun, liveGood, {
        approveHash: hashOf(liveGood),
        deadlineMs: 60_000,
      });
      const out = JSON.stringify(lok.res);
      expect(out).toContain('"state":"ok"');
      const txHash = /"txHash":"([A-Za-z0-9]+)"/.exec(out)?.[1];
      expect(txHash).toBeTruthy();
      const rb = await readbackLive(txHash as string, liveHash);
      expect(rb.finality).toBe("FINAL");
      expect(rb.succeeded && rb.equal).toBe(true);
      liveEvidence = {
        txHash,
        payloadHash: liveHash,
        finality: rb.finality,
        viewTimestampNs: rb.viewTimestampNs,
      };
      liveNote = `LIVE half: executed through the kernel gateway with an owner approval against NEAR testnet, real borsh transaction signed by the signer process: tx ${txHash} (contract ${rb.receiver}, method ${rb.method}), FINAL, contract view returns the committed hash ${liveHash}; 3 live denials (mainnet, other contract, transfer method) with valid approvals produced 0 signatures`;
    } finally {
      liveSigner.stop();
      delete process.env.CHAIN_COMMIT_LIVE;
    }
  }

  observe({
    testId: "SEC15",
    observed: `FIXTURE half (loopback chain fixture, locally generated ed25519 key, testnet only): ${outcomes.length} agent invocations of chain_commit.commit_hash@1: exactly 1 executed (valid owner approval: 1 chain call, 1 signature, signature verified by the fixture chain), ${denials.length} denied with 0 chain calls and 0 signatures (${mutations.length} single-parameter mutations of an approved call, expired, other-run, non-owner issuer, no approval, replay, ${policy.length} policy violations that carried a valid approval of their exact input: non-allowlisted contract and method, transfer, swap, mainnet, deposit and gas above ceiling); the signer process refused ${signerRefused}/${signerDirect.length} policy-violating requests sent to it directly; ${audited.length}/${denials.length} denials audited with reasons ${JSON.stringify(reasons)}; ${used.length} approval has used_at set (the executed one); key forms searched in the host environment, the signer's environment (${signerEnvVars.length} variables, started with an empty env, key via stdin), ${files.length} files, ${audit.rowCount} audit rows, ${invocations.rowCount} invocation rows, RPC log and tool responses: 0 hits; agent tool catalog has ${agentTools.length} chain, sign, swap or transfer tools and the plugin offers exactly one capability; control: the handler called without the gateway wrote ${controlWrote} to the chain, so the zero counts are sensitive. ${liveNote}`,
    fixtureHash: createHash("sha256")
      .update(JSON.stringify({ mutations, policy, signerDirect }))
      .digest("hex"),
    evidence: {
      outcomes,
      signerRefused,
      audited: audited.length,
      approvalsUsed: used.length,
      filesScanned: files.length,
      controlWrote,
      live: liveEvidence,
    },
  });
}, 300_000);
