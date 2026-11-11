import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rig } from "../../../tests/security/_plugin-harness.ts";
import type { Rig } from "../../../tests/security/_plugin-harness.ts";

let r: Rig;
let canary: net.Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  canary = net.createServer((s) => {
    hits++;
    s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi");
  });
  await new Promise<void>((res) => canary.listen(0, "127.0.0.1", res));
  port = (canary.address() as AddressInfo).port;
  r = await rig({ prefix: "conf" });
});
afterAll(async () => {
  await new Promise((res) => canary?.close(() => res(null)));
  await r?.drop();
});

describe("plugin confinement on the real execution path", () => {
  it("a plugin's bare network and process primitives are refused and audited", async () => {
    const before = hits;
    const attacks: Array<Record<string, unknown>> = [
      { action: "bare-fetch", url: `http://127.0.0.1:${port}/` },
      { action: "http-request", url: `http://127.0.0.1:${port}/` },
      { action: "net-connect", host: "127.0.0.1", port },
      { action: "dns-lookup", host: "example.org" },
      { action: "spawn-curl", url: `http://127.0.0.1:${port}/` },
      { action: "worker", port },
    ];
    for (const a of attacks) {
      const res = await r.invoke(a);
      expect(res.state, String(a.action)).toBe("failed");
      expect(res.reasonCode, String(a.action)).toBe("PLUGIN_EGRESS_VIOLATION");
      // re-enable between attacks: the first violation degrades the plugin
      await r.db.admin.query("UPDATE plugin_installations SET state = 'enabled', consecutive_failures = 0");
    }
    expect(hits).toBe(before);
    expect(await r.auditCount("plugin.violation")).toBeGreaterThanOrEqual(attacks.length);
  });

  it("ctx.egress is the only path: a non-allowlisted target is denied and counts as a violation", async () => {
    await r.db.admin.query("UPDATE plugin_installations SET state = 'enabled', consecutive_failures = 0");
    const res = await r.invoke({ action: "swallowed-egress", url: `http://127.0.0.1:${port}/` });
    expect(res.state).toBe("failed");
    expect(res.reasonCode).toBe("PLUGIN_EGRESS_VIOLATION");
    expect(hits).toBe(0);
  });

  it("ordinary handlers still work and the guards do not leak outside the handler", async () => {
    await r.db.admin.query("UPDATE plugin_installations SET state = 'enabled', consecutive_failures = 0");
    const ok = await r.invoke({ action: "ok", text: "x" });
    expect(ok.state).toBe("ok");
    // kernel code outside a plugin scope can still open sockets
    const s = net.connect(port, "127.0.0.1");
    await new Promise((res, rej) => {
      s.on("connect", () => res(null));
      s.on("error", rej);
    });
    s.destroy();
  });
});
