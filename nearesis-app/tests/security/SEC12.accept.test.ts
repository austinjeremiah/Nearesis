/**
 * SEC12: plugin egress, sandbox limits and default-deny third-party MCP. PASS: 0 packets to non-allowlisted
 * destinations, limits terminate the plugin with a reason code and the host is unaffected, unreviewed MCP endpoints are
 * denied, each violation is audited and moves the plugin out of `enabled`.
 * Real execution path (signed manifest, plugin manager, tool gateway) on a disposable database; the fake plugin is the
 * hostile fixture. Packets are counted by TCP canary servers on every private address the plugin tries to reach.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { McpEndpointPolicy } from "../../packages/kernel/src/index.ts";
import { SANDBOX_IMAGE, ensureSandboxImage } from "../../packages/kernel/src/plugins/sandbox-image.ts";
import { hostileManifest, rig } from "./_plugin-harness.ts";
import type { Rig } from "./_plugin-harness.ts";

const IMAGE = SANDBOX_IMAGE;
const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const dockerUp = docker("version", "--format", "{{.Server.Version}}").status === 0;
const imageId =
  dockerUp && ensureSandboxImage()
    ? docker("image", "inspect", IMAGE, "--format", "{{.Id}}").stdout.trim()
    : "";

let canary: net.Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  canary = net.createServer((s) => {
    hits++;
    s.destroy();
  });
  await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
  port = (canary.address() as AddressInfo).port;
});
afterAll(() => {
  canary?.close();
});

const PUBLIC = "feeds.example.org";
const resolveMap: Record<string, string[]> = {
  [PUBLIC]: ["93.184.216.34"],
  "rebind.example.org": ["127.0.0.1"],
  "mixed.example.org": ["93.184.216.34", "169.254.169.254"],
};

it("SEC12: egress allowlist, sandbox limits and default-deny MCP hold; the control without the proxy fails (a)", async () => {
  expect(dockerUp, "docker is required for the sandbox limits").toBe(true);
  const dialed: string[] = [];
  const confined: Rig = await rig({
    prefix: "sec12c",
    manifest: hostileManifest({ networkHosts: [PUBLIC, "rebind.example.org", "mixed.example.org"] }),
    execution: {
      egressDeps: {
        resolve: async (h) => {
          const r = resolveMap[h];
          if (!r) throw new Error("NXDOMAIN");
          return r;
        },
        onDial: (ip) => dialed.push(ip),
        dialOverride: () => ({ ip: "127.0.0.1", port: 9 }), // any permitted dial would go nowhere (discard port)
      },
      egressPolicy: { allowInsecureHttp: true, timeoutMs: 1500 },
    },
  });
  const boxed: Rig = await rig({
    prefix: "sec12s",
    manifest: hostileManifest({
      pluginId: "sec-hostile-box",
      resourceLimits: { memoryMb: 64, cpuMs: 6000, concurrency: 2 },
    }),
    execution: { isolation: () => "sandbox", sandbox: { image: imageId } },
  });
  const revive = (r: Rig) =>
    r.db.admin.query("UPDATE plugin_installations SET state = 'enabled', consecutive_failures = 0");
  const states: Record<string, string> = {};
  try {
    // (a) egress: every attempt fails, nothing dials, no canary packet
    const attempts: Array<Record<string, unknown>> = [
      { action: "egress", url: `http://other.example.net/` },
      { action: "egress", url: `http://127.0.0.1:${port}/` },
      { action: "egress", url: `http://rebind.example.org:${port}/` },
      { action: "egress", url: `http://mixed.example.org/` },
      { action: "egress", url: `http://169.254.169.254/latest/meta-data/` },
      { action: "bare-fetch", url: `http://127.0.0.1:${port}/` },
      { action: "net-connect", host: "127.0.0.1", port },
      { action: "spawn-curl", url: `http://127.0.0.1:${port}/` },
    ];
    const codes: string[] = [];
    for (const a of attempts) {
      await revive(confined);
      const res = await confined.invoke(a);
      codes.push(String(res.reasonCode));
      expect(res.state, JSON.stringify(a)).toBe("failed");
      expect(res.reasonCode, JSON.stringify(a)).toBe("PLUGIN_EGRESS_VIOLATION");
      // (d) the violation is audited and the plugin leaves `enabled`
      const st = (await confined.db.admin.query("SELECT state FROM plugin_installations")).rows[0]
        .state as string;
      states[String(a.action)] = st;
      expect(["degraded", "quarantined"]).toContain(st);
    }
    expect(dialed).toEqual([]);
    expect(hits).toBe(0);
    expect(await confined.auditCount("plugin.violation")).toBeGreaterThanOrEqual(attempts.length);
    // the allowlisted name works through the proxy (the dial hook sees exactly the public address)
    await revive(confined);
    await confined.invoke({ action: "egress", url: `http://${PUBLIC}:80/` }).catch(() => undefined);
    expect(dialed).toEqual(["93.184.216.34"]);

    // (b) limits: each stopped with a reason code, the host is unaffected
    const pid = process.pid;
    const limit = async (input: Record<string, unknown>) => {
      await revive(boxed);
      return boxed.invoke(input);
    };
    const mem = await limit({ action: "alloc" });
    const cpu = await limit({ action: "spin" });
    const disk = await limit({ action: "fill-disk" });
    const bomb = await limit({ action: "fork-bomb" });
    expect(mem.reasonCode).toBe("PLUGIN_MEMORY_LIMIT");
    expect(cpu.reasonCode).toBe("PLUGIN_CPU_LIMIT");
    expect(disk.reasonCode).toBe("PLUGIN_DISK_LIMIT");
    expect(bomb.state === "failed" || (bomb.payload as { kids?: number }).kids! <= 200).toBe(true);
    const after = await limit({ action: "ok", text: "host still serves" });
    expect(after.state).toBe("ok");
    expect(process.pid).toBe(pid);
    await new Promise((r) => setTimeout(r, 1500));
    expect(docker("ps", "-q", "--filter", "name=nearesis-sbx-").stdout.trim()).toBe("");
    await revive(boxed);
    await boxed.invoke({ action: "alloc" });
    const limitState = (await boxed.db.admin.query("SELECT state FROM plugin_installations")).rows[0]
      .state as string;
    expect(["degraded", "quarantined"]).toContain(limitState);
    expect(await boxed.auditCount("tool.invoke.completed")).toBeGreaterThan(0);

    // (c) MCP: default deny, reviewed registration is narrowed
    const policy = new McpEndpointPolicy(confined.k.db, {
      resolve: async () => ["93.184.216.34"],
    });
    const endpoint = `https://mcp.vendor.example/rpc`;
    const denied = await policy
      .register(confined.human, { endpoint, requestedScopes: ["read", "write"] })
      .then(
        () => "accepted",
        (e) => (e as { reasonCode: string }).reasonCode,
      );
    expect(denied).toBe("MCP_NOT_REVIEWED");
    await policy.recordReview(confined.human, {
      endpoint,
      approvedScopes: ["read"],
      reference: "REVIEW-4711",
    });
    const ok = await policy.register(confined.human, { endpoint, requestedScopes: ["read", "write"] });
    expect(ok.scopes).toEqual(["read"]);
    expect(policy.isRegistered(endpoint)).toBe(true);
    // a reviewed endpoint that resolves to a private address is still refused
    const privPolicy = new McpEndpointPolicy(confined.k.db, { resolve: async () => ["10.0.0.5"] });
    await privPolicy.recordReview(confined.human, {
      endpoint,
      approvedScopes: ["read"],
      reference: "REVIEW-4712",
    });
    const priv = await privPolicy.register(confined.human, { endpoint, requestedScopes: ["read"] }).then(
      () => "accepted",
      (e) => (e as { reasonCode: string }).reasonCode,
    );
    expect(priv).toBe("EGRESS_PRIVATE_ADDRESS");
    expect(await confined.auditCount("mcp.registration.denied")).toBe(2);
    expect(await confined.auditCount("mcp.registered")).toBe(1);

    // control: the same hostile module run without the proxy and confinement reaches the canary, so (a) would fail
    const hostile = (await import("./fixtures/plugins/hostile.mjs")) as unknown as {
      default: { handlers: Record<string, (i: unknown, c: unknown) => Promise<unknown>> };
    };
    await hostile.default.handlers["sec.hostile.run@1"]!(
      { action: "net-connect", host: "127.0.0.1", port },
      {},
    ).catch(() => undefined);
    for (let i = 0; i < 40 && hits === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBeGreaterThan(0);

    observe({
      testId: "SEC12",
      observed: `${attempts.length} egress attempts from a hostile plugin through the real gateway (non-allowlisted host, loopback, DNS-rebinding name, mixed public/metadata answer, metadata address, bare fetch, raw socket, curl): all failed with PLUGIN_EGRESS_VIOLATION, 0 dials, 0 canary packets, each audited and the plugin moved to ${[...new Set(Object.values(states))].join("/")}; sandboxed plugin limits: memory ${mem.reasonCode}, CPU ${cpu.reasonCode}, disk ${disk.reasonCode}, process bomb ${bomb.state}, host process unaffected and a follow-up call ok, no orphan containers, plugin moved to ${limitState}; MCP: unreviewed endpoint ${denied}, after review accepted with scopes ${JSON.stringify(ok.scopes)} (requested read,write), reviewed endpoint resolving to a private address refused (${priv}); control without proxy reached the canary (${hits} connection) so criterion (a) fails without it`,
      fixtureHash: createHash("sha256").update(JSON.stringify(attempts)).digest("hex"),
      evidence: {
        codes,
        states,
        limitState,
        mem: mem.reasonCode,
        cpu: cpu.reasonCode,
        disk: disk.reasonCode,
        mcp: { denied, scopes: ok.scopes, priv },
      },
    });
  } finally {
    await confined.drop();
    await boxed.drop();
  }
}, 600_000);
