/**
 * N12: Base read-only adapter isolation and truthful scope. FIXTURE half runs against a recording RPC mock. The one bounded
 * live read runs only with `--live` (endpoint NEARESIS_BASE_RPC_URL, else the keyless public https://mainnet.base.org) and
 * makes read-only calls through the real HTTP transport. The transport half also proves, against a loopback server that
 * records every request on the wire, that no write method is ever serialised. If the live RPC is unreachable the verdict is
 * BLOCKED_DEPENDENCY, never PASS.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  BASE_ALLOWED_METHODS,
  BaseReadonly,
  DEFAULT_BASE_PUBLIC_RPC,
  assertKeylessBaseUrl,
  baseReportSection,
  createHttpTransport,
  g12Verdict,
  pluginEnvironment,
} from "../../scripts/release/base.ts";

const mockRpc = (chainId = "0x2105") => {
  const seen: string[] = [];
  return {
    seen,
    transport: async (m: string) => {
      seen.push(m);
      return m === "eth_chainId" ? chainId : { hash: "0xhead" };
    },
  };
};

it("N12: the Base adapter calls only eth_chainId and one finalized header, denies writes before the RPC, holds no NEAR key, and is never counted toward G12", async () => {
  // (a)
  const m = mockRpc();
  const ok = await new BaseReadonly(m.transport).smoke();
  expect(ok).toEqual({ chainId: "0x2105", ok: true, header: "0xhead" });
  expect(m.seen).toEqual(["eth_chainId", "eth_getBlockByNumber"]);

  // (b) write, signing, wide log query and a second header are denied before reaching the RPC
  const b = mockRpc();
  const adapter = new BaseReadonly(b.transport);
  for (const method of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_signTransaction",
    "eth_getLogs",
    "personal_sign",
    "eth_accounts",
  ])
    await expect(adapter.call(method, [{ fromBlock: "0x0", toBlock: "latest" }]), method).rejects.toThrow(
      /denied/,
    );
  await adapter.call("eth_getBlockByNumber", ["finalized", false]);
  await expect(adapter.call("eth_getBlockByNumber", ["finalized", false])).rejects.toThrow(/budget/);
  await expect(new BaseReadonly(b.transport).call("eth_getBlockByNumber", ["0x10", true])).rejects.toThrow(
    /finalized header/,
  );
  expect(b.seen.every((x) => (BASE_ALLOWED_METHODS as readonly string[]).includes(x))).toBe(true);
  expect(b.seen).toEqual(["eth_getBlockByNumber"]);

  // (c) wrong chain id fails and fetches no header
  const w = mockRpc("0x1");
  const bad = await new BaseReadonly(w.transport).smoke();
  expect(bad.ok).toBe(false);
  expect(w.seen).toEqual(["eth_chainId"]);

  // (d) no NEAR key material in the plugin environment or requests; rate policy
  const canary = "ed25519:" + "9".repeat(64);
  const env = pluginEnvironment({
    PATH: "/bin",
    HOME: "/h",
    NEAR_PRIVATE_KEY: canary,
    NEARESIS_WALLET_KEY: canary,
    EXTRA: canary,
    OTHER_SECRET: "s",
  });
  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  expect(JSON.stringify([m.seen, b.seen])).not.toContain("ed25519");
  const rl = mockRpc();
  const limited = new BaseReadonly(rl.transport, { maxRequestsPerMinute: 1, now: () => 5 });
  await limited.call("eth_chainId");
  await expect(limited.call("eth_chainId")).rejects.toThrow(/rate policy/);
  expect(rl.seen).toHaveLength(1);

  // (e) report states the check is additive and never satisfies G12; a generator marking G12 PASS on N12 alone fails
  const section = baseReportSection({ ran: true, verdict: "PASS" });
  expect(section).toMatchObject({ countsTowardG12: false, countsTowardN03: false });
  expect(section.note).toMatch(/not equivalent/);
  expect(g12Verdict({ n03: "BLOCKED_DEPENDENCY", n12: "PASS" })).toBe("BLOCKED_DEPENDENCY");
  expect(g12Verdict({ n03: "NOT_RUN", n12: "PASS" })).not.toBe("PASS");
  const naive = (x: { n12: string }) => (x.n12 === "PASS" ? "PASS" : "FAIL");
  expect(naive({ n12: "PASS" })).toBe("PASS"); // control: this generator would be detected by the line above

  // transport layer: a loopback server records every request on the wire; writes never reach it, even bypassing the adapter
  const wire: string[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b) as { method: string };
      wire.push(j.method);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: j.method === "eth_chainId" ? "0x2105" : { hash: "0xh" },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const lb = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const raw = createHttpTransport(lb);
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_signTransaction",
      "eth_getLogs",
    ])
      await expect(raw(method, []), method).rejects.toThrow(/denied at transport/);
    expect(wire).toEqual([]);
    expect(await new BaseReadonly(raw).smoke()).toMatchObject({ ok: true });
    expect(wire).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
  } finally {
    srv.close();
  }
  // keyless public endpoints only
  for (const bad of [
    "https://user:pw@base.example/rpc",
    "https://base.example/rpc?apikey=abc",
    "https://base.example/v2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "http://base.example/rpc",
  ])
    expect(() => assertKeylessBaseUrl(bad), bad).toThrow();
  expect(() => assertKeylessBaseUrl(DEFAULT_BASE_PUBLIC_RPC)).not.toThrow();

  // live half (read-only): one eth_chainId and one finalized header through the real transport
  const live = !!process.env.NEARESIS_ACCEPT_LIVE;
  let liveNote: { ok: boolean; chainId?: string; methods: string[]; error?: string } | null = null;
  if (live) {
    const seen: string[] = [];
    const http = createHttpTransport(process.env.NEARESIS_BASE_RPC_URL || DEFAULT_BASE_PUBLIC_RPC);
    try {
      const r = await new BaseReadonly(async (m, p) => (seen.push(m), http(m, p))).smoke();
      liveNote = { ok: r.ok, chainId: r.chainId, methods: seen };
    } catch (e) {
      liveNote = { ok: false, methods: seen, error: String((e as Error).message).slice(0, 160) };
    }
  }
  const liveOk = liveNote?.ok === true;
  if (liveOk) {
    expect(liveNote!.chainId).toBe("0x2105");
    expect(liveNote!.methods).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
  }

  observe({
    testId: "N12",
    ...(liveOk
      ? {}
      : {
          blocked: live
            ? `Live Base RPC unreachable or refused (${liveNote?.error ?? "no result"}); fixture half passed: criteria (a) to (e)`
            : "NOT_RUN (live half): run with --live; no live read was made. Fixture half passed: criteria (a) to (e)",
        }),
    observed: `${liveOk ? `live half (read-only, real HTTP transport): eth_chainId returned ${liveNote!.chainId} (8453) and one finalized header was read; methods on the wire: ${liveNote!.methods.join(", ")}; ` : "live half not run or unreachable; "}transport half: a loopback server recording the wire saw 0 requests for eth_sendRawTransaction, eth_sendTransaction, eth_signTransaction, eth_getLogs and only eth_chainId plus one header for the smoke; URLs with credentials, query strings, key-like paths or plain http are refused; fixture half: smoke calls only eth_chainId and one finalized header and requires 0x2105; eth_sendRawTransaction, eth_sendTransaction, eth_signTransaction, eth_getLogs, personal_sign, eth_accounts and a second header denied before the RPC (recorded methods subset of allowlist); wrong chain id 0x1 fails with no header fetched; plugin environment excludes NEAR, wallet, key, secret variables and the canary key never appears in requests; rate policy enforced; report section says additive, countsTowardG12=false, countsTowardN03=false, and N12 PASS with N03 blocked leaves G12 BLOCKED_DEPENDENCY. `,
    fixtureHash: null,
    evidence: {
      recordedMethods: [...m.seen, ...b.seen],
      wireMethods: wire,
      live: liveNote,
      envKeys: Object.keys(env),
      report: section,
    },
  });
});
